package com.zxi2233.wechatbridge;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.AndroidAppHelper;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;

import org.json.JSONObject;

import java.lang.reflect.Proxy;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;

/** Coordinates user confirmation, the host WeChat SDK and the local server. */
final class BridgeRuntime implements LoopbackHttpServer.Listener {
    private static final String TAG = "[JzLoginBridge] ";
    private static final long HOST_READY_STABLE_MS = 800L;
    private static final long WECHAT_READY_TIMEOUT_MS = 8_000L;
    private static final long WECHAT_PROBE_INTERVAL_MS = 500L;
    private static final long READINESS_LOG_INTERVAL_MS = 2_000L;
    private static final long HOST_HOOK_PROBE_INTERVAL_MS = 400L;
    private static final long HOST_HOOK_PROBE_TIMEOUT_MS = 30_000L;

    private final ClassLoader hostClassLoader;
    private final RequestRegistry registry = new RequestRegistry();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<String> diagnosticLines = new ArrayList<>();

    private WeakReference<Activity> resumedActivity = new WeakReference<>(null);
    private AlertDialog confirmationDialog;
    private String confirmationState;
    private boolean retryScheduled;
    private long lastHostLaunch;
    private String lastPreviewState = "";
    private final AtomicBoolean hostLoginInFlight = new AtomicBoolean(false);
    private volatile String pendingOfficialState;
    private volatile String hostSessionJson;
    private BroadcastReceiver officialLoginReceiver;
    private volatile boolean wxApiReady;
    private int officialHostSessionRetries;
    private volatile long confirmationGraceUntil;
    private String activeTransferredState;
    private long hostReadySince;
    private boolean hostWasReady;
    private boolean hostReadyCheckScheduled;
    private long lastWechatProbeAt;
    private long lastReadinessLogAt;
    private String pendingWechatStartState;
    private long pendingWechatStartDeadline;
    private boolean pendingWechatStartScheduled;
    private boolean wechatCallbackHookInstalled;
    private boolean sessionStoreHookInstalled;
    private boolean wechatApiHookInstalled;
    private boolean hostHooksProbeScheduled;
    private long hostHooksProbeStartedAt;
    private int hostHooksProbeAttempts;

    private void recordDiagnostic(String message) {
        String line = System.currentTimeMillis() + " " + message;
        try {
            XposedBridge.log(TAG + line);
        } catch (Throwable ignored) {
            Log.i("JzLoginBridge", line);
        }
        synchronized (diagnosticLines) {
            diagnosticLines.add(line);
            if (diagnosticLines.size() > 80) {
                Iterator<String> iterator = diagnosticLines.iterator();
                iterator.next();
                iterator.remove();
            }
        }
    }

    @Override
    public JSONObject diagnostics() {
        try {
            return new JSONObject()
                    .put("hostVersion", hostVersion())
                    .put("loginInFlight", hostLoginInFlight.get())
                    .put("officialRequestPending", pendingOfficialState != null)
                    .put("hasCapturedSession", hostSessionJson != null);
        } catch (Throwable ignored) {
            return new JSONObject();
        }
    }

    @Override
    public String diagnosticLog() {
        synchronized (diagnosticLines) {
            StringBuilder builder = new StringBuilder();
            for (String line : diagnosticLines) {
                if (builder.length() > 0) builder.append('\n');
                builder.append(line);
            }
            return builder.toString();
        }
    }

    BridgeRuntime(ClassLoader hostClassLoader) {
        this.hostClassLoader = hostClassLoader;
    }

    void install() throws Throwable {
        // Secneo loads host classes only after process bootstrap. Install the
        // independent bridge surface first; one missing SDK class must never
        // disable HTTP, Activity lifecycle hooks or the consent UI.
        hookActivities();
        hookHostLaunchIntent();
        LoopbackHttpServer server = new LoopbackHttpServer(registry, this);
        server.start();
        recordDiagnostic("bridge HTTP server started");
        scheduleHostHookProbe(0L);
    }

    /**
     * Probe optional host integrations independently while Secneo finishes
     * loading. The bounded retry keeps startup from creating an endless loop.
     */
    private void scheduleHostHookProbe(long delayMs) {
        if (hostHooksProbeScheduled) return;
        if (wechatCallbackHookInstalled && sessionStoreHookInstalled
                && wechatApiHookInstalled) return;
        hostHooksProbeScheduled = true;
        mainHandler.postDelayed(() -> {
            hostHooksProbeScheduled = false;
            probeHostHooks();
        }, delayMs);
    }

    private void probeHostHooks() {
        long now = System.currentTimeMillis();
        if (hostHooksProbeStartedAt == 0L) {
            hostHooksProbeStartedAt = now;
            recordDiagnostic("host class hook probe started");
        }
        hostHooksProbeAttempts++;
        if (!wechatCallbackHookInstalled) {
            try {
                hookWechatCallback();
                wechatCallbackHookInstalled = true;
                recordDiagnostic("WeChat callback hook installed");
            } catch (Throwable error) {
                if (hostHooksProbeAttempts == 1) {
                    recordDiagnostic("WeChat callback hook deferred: "
                            + error.getClass().getSimpleName());
                }
            }
        }
        if (!sessionStoreHookInstalled) {
            try {
                hookOfficialSessionStore();
                sessionStoreHookInstalled = true;
                recordDiagnostic("official session store hook installed");
            } catch (Throwable error) {
                if (hostHooksProbeAttempts == 1) {
                    recordDiagnostic("session store hook deferred: "
                            + error.getClass().getSimpleName());
                }
            }
        }
        if (!wechatApiHookInstalled) {
            try {
                hookWechatApiInitialization();
                wechatApiHookInstalled = true;
                recordDiagnostic("WeChat API initialization hook installed");
            } catch (Throwable error) {
                if (hostHooksProbeAttempts == 1) {
                    recordDiagnostic("WeChat API hook deferred: "
                            + error.getClass().getSimpleName());
                }
            }
        }
        if (officialLoginReceiver == null) {
            installOfficialLoginReceiver();
        }
        boolean ready = wechatCallbackHookInstalled && sessionStoreHookInstalled
                && wechatApiHookInstalled;
        if (!ready && now - hostHooksProbeStartedAt < HOST_HOOK_PROBE_TIMEOUT_MS) {
            scheduleHostHookProbe(HOST_HOOK_PROBE_INTERVAL_MS);
        } else if (!ready) {
            recordDiagnostic("optional host hooks still unavailable after timeout");
        } else {
            recordDiagnostic("all optional host hooks installed");
        }
    }

    /**
     * The module starts XTC's launcher activity with a private one-time action.
     * Read the state from both lifecycle callbacks: a cold launch reaches
     * onResume, while a singleTop activity already in front uses onNewIntent.
     */
    private void hookHostLaunchIntent() {
        // singleTop host activities receive an already-open auth intent here
        // without necessarily pausing or resuming the activity.
        XposedHelpers.findAndHookMethod(Activity.class, "onNewIntent",
                Intent.class, new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        Activity activity = (Activity) param.thisObject;
                        if (!isHostActivity(activity)) return;
                        Intent intent = param.args[0] instanceof Intent
                                ? (Intent) param.args[0] : activity.getIntent();
                        acceptHostAuthIntent(intent, "onNewIntent");
                    }
                });
        XposedHelpers.findAndHookMethod(Activity.class, "onResume",
                new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        Activity activity = (Activity) param.thisObject;
                        if (!isHostActivity(activity)) return;
                        acceptHostAuthIntent(activity.getIntent(), "onResume");
                    }
                });
    }

    /**
     * Secneo replaces the launcher activity with its login page and rewrites
     * the custom action while retaining the intent extras. The one-time state
     * is therefore authoritative; the action is only a compatibility signal.
     */
    private void acceptHostAuthIntent(Intent intent, String lifecycle) {
        if (intent == null) return;
        String state = intent.getStringExtra(BridgeContract.EXTRA_DEEP_LINK_STATE);
        if (!BridgeContract.isValidState(state)) return;
        boolean actionPreserved = BridgeContract.HOST_AUTH_ACTION.equals(
                intent.getAction());
        recordDiagnostic("host auth state extra observed in " + lifecycle
                + ", actionPreserved=" + actionPreserved);
        acceptHostLaunchIntent(null, intent);
    }

    private static boolean isHostActivity(Activity activity) {
        return activity != null
                && BridgeContract.HOST_PACKAGE.equals(activity.getPackageName());
    }

    private void acceptHostLaunchIntent(Activity activity, Intent intent) {
        if (intent == null) return;
        String state = intent.getStringExtra(
                BridgeContract.EXTRA_DEEP_LINK_STATE);
        if (state == null && confirmationState != null) {
            // A second launcher callback without a new state must not leave a
            // dialog stranded after the one-time intent was consumed.
            mainHandler.post(this::showNextConfirmationWhenHostReady);
            return;
        }
        if (!BridgeContract.isValidState(state)) {
            recordDiagnostic("host launch intent contained an invalid state");
            intent.removeExtra(BridgeContract.EXTRA_DEEP_LINK_STATE);
            intent.removeExtra(BridgeContract.EXTRA_DEEP_LINK_ORIGIN);
            return;
        }
        try {
            AuthorizationSnapshot snapshot = registry.acceptTransfer(
                    state,
                    System.currentTimeMillis());
            recordDiagnostic("host launch intent accepted, status="
                    + snapshot.status);
            activeTransferredState = state;
            hostReadySince = 0L;
            hostWasReady = false;
            mainHandler.post(this::showNextConfirmationWhenHostReady);
            recordDiagnostic("host transfer accepted; waiting for stable host UI");
        } catch (BridgeException error) {
            recordDiagnostic("host launch intent rejected: " + error.code);
            registry.fail(state, error.code, error.getMessage(),
                    System.currentTimeMillis());
            mainHandler.post(this::launchHost);
        } finally {
            // Never leave a one-time correlation value on a long-lived
            // launcher intent after the in-memory request is established.
            intent.removeExtra(BridgeContract.EXTRA_DEEP_LINK_STATE);
            intent.removeExtra(BridgeContract.EXTRA_DEEP_LINK_ORIGIN);
            intent.setData(null);
        }
    }

    private void scheduleHostReadyCheck() {
        if (hostReadyCheckScheduled) return;
        hostReadyCheckScheduled = true;
        mainHandler.postDelayed(() -> {
            hostReadyCheckScheduled = false;
            showNextConfirmationWhenHostReady();
        }, 200L);
    }

    private void hookWechatApiInitialization() {
        try {
            Class<?> managerClass = loadHostClass(
                    "com.xtc.common.util.WXBaseManager");
            Class<?> apiClass = loadHostClass(
                    "com.tencent.mm.opensdk.openapi.IWXAPI");
            XposedHelpers.findAndHookMethod(managerClass, "registerApp",
                    new XC_MethodHook() {
                        @Override
                        protected void afterHookedMethod(MethodHookParam param) {
                            try {
                                Object api = XposedHelpers.callMethod(
                                        param.thisObject, "getApi");
                                wxApiReady = api != null
                                        && apiClass.isInstance(api);
                                recordDiagnostic("WeChat API initialization observed, ready="
                                        + wxApiReady);
                                hostReadySince = 0L;
                                if (wxApiReady) scheduleHostReadyCheck();
                            } catch (Throwable error) {
                                recordDiagnostic("WeChat API readiness check failed: " + error);
                            }
                        }
                    });
            try {
                Object manager = XposedHelpers.callStaticMethod(
                        managerClass, "getInstance");
                Object api = XposedHelpers.callMethod(manager, "getApi");
                if (api != null && apiClass.isInstance(api)) {
                    wxApiReady = true;
                    recordDiagnostic("WeChat API was already initialized");
                }
            } catch (Throwable error) {
                recordDiagnostic("existing WeChat API probe skipped: "
                        + error.getClass().getSimpleName());
            }
        } catch (Throwable error) {
            throw new IllegalStateException(
                    "WeChat API hook unavailable", error);
        }
    }

    private void scheduleOfficialLoginReceiver() {
        if (officialLoginReceiver != null) return;
        mainHandler.postDelayed(this::installOfficialLoginReceiver, 300L);
    }

    private void installOfficialLoginReceiver() {
        if (officialLoginReceiver != null) return;
        try {
            Class<?> activityClass = loadHostClass(
                    "com.xtc.watch.wxapi.WXEntryActivity");
            String action = (String) XposedHelpers.getStaticObjectField(
                    activityClass, "AuX");
            String extra = (String) XposedHelpers.getStaticObjectField(
                    activityClass, "aUX");
            Context context = AndroidAppHelper.currentApplication();
            if (context == null) {
                mainHandler.postDelayed(this::installOfficialLoginReceiver, 300L);
                return;
            }
            officialLoginReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context receiverContext, Intent intent) {
                    String encoded = intent == null
                            ? null : intent.getStringExtra(extra);
                    if (encoded == null || encoded.isEmpty()) {
                        recordDiagnostic("official broadcast missing response");
                        return;
                    }
                    try {
                        Class<?> codecClass = loadHostClass(
                                "com.xtc.watch.util.Uganda");
                        Class<?> responseClass = loadHostClass(
                                "com.tencent.mm.opensdk.modelmsg.SendAuth$Resp");
                        Object response = XposedHelpers.callStaticMethod(
                                codecClass, "Gabon", encoded, responseClass);
                        if (response == null) {
                            recordDiagnostic("official broadcast decoded to null");
                            return;
                        }
                        String wireState = (String) XposedHelpers.getObjectField(
                                response, "state");
                        int errorCode = XposedHelpers.getIntField(
                                response, "errCode");
                        String error = (String) XposedHelpers.getObjectField(
                                response, "errStr");
                        String code = (String) XposedHelpers.getObjectField(
                                response, "code");
                        String officialState = pendingOfficialState;
                        boolean officialRequest = officialState != null
                                && (wireState == null
                                || "login_state".equals(wireState));
                        boolean bridgeRequest = registry.matches(wireState);
                        if (!officialRequest && !bridgeRequest) return;
                        boolean owned = officialRequest
                                ? registry.claimOfficialWechat(
                                        officialState, errorCode, error, System.currentTimeMillis())
                                : registry.claimWechat(
                                        wireState, errorCode, error, System.currentTimeMillis());
                        if (!owned) return;
                        recordDiagnostic("wx broadcast received, official="
                                + officialRequest + ", errCode=" + errorCode
                                + ", hasCode=" + (code != null && !code.isEmpty()));
                        if (errorCode != 0) {
                            pendingOfficialState = null;
                            releaseHostLogin();
                        }
                    } catch (Throwable error) {
                        recordDiagnostic("official broadcast parse failed: " + error);
                    }
                }
            };
            context.registerReceiver(officialLoginReceiver,
                    new IntentFilter(action), Context.RECEIVER_EXPORTED);
            recordDiagnostic("official login broadcast receiver installed");
        } catch (Throwable error) {
            officialLoginReceiver = null;
            if (hostHooksProbeAttempts <= 1) {
                recordDiagnostic("official login broadcast receiver deferred: "
                        + error.getClass().getSimpleName());
            }
        }
    }

    private void hookActivities() {
        hookHostOnCreate();
        XposedHelpers.findAndHookMethod(Activity.class, "onResume", new XC_MethodHook() {
            @Override
            protected void afterHookedMethod(MethodHookParam param) {
                resumedActivity = new WeakReference<>((Activity) param.thisObject);
                hostReadySince = 0L;
                hostWasReady = false;
                scheduleOfficialLoginReceiver();
                ensureWechatApiReady();
                showNextConfirmationWhenHostReady();
            }
        });
        XposedHelpers.findAndHookMethod(Activity.class, "onPause", new XC_MethodHook() {
            @Override
            protected void afterHookedMethod(MethodHookParam param) {
                Activity current = resumedActivity.get();
                if (current == param.thisObject) {
                    resumedActivity.clear();
                    hostReadySince = 0L;
                    hostWasReady = false;
                }
            }
        });
        XposedHelpers.findAndHookMethod(Activity.class, "onWindowFocusChanged",
                boolean.class, new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        Activity activity = (Activity) param.thisObject;
                        boolean focused = Boolean.TRUE.equals(param.args[0]);
                        recordDiagnostic("host window focus changed, focused=" + focused);
                        if (!focused) {
                            if (activity == resumedActivity.get()) {
                                hostReadySince = 0L;
                                hostWasReady = false;
                            }
                            return;
                        }
                        if (activity != resumedActivity.get()
                                || !isHostActivity(activity)) {
                            return;
                        }
                        mainHandler.post(
                                BridgeRuntime.this::showNextConfirmationWhenHostReady);
                    }
                });
    }

    private void hookHostOnCreate() {
        XposedHelpers.findAndHookMethod(Activity.class, "onCreate",
                Bundle.class, new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        if (!"com.xtc.watch.wxapi.WXEntryActivity".equals(
                                param.thisObject.getClass().getName())) {
                            return;
                        }
                        // BaseWXEntryActivity registers its private finish
                        // receiver from the native onCreate constructor. Give
                        // that receiver a chance to register before the SDK
                        // immediately delivers a pending callback.
                        recordDiagnostic("WXEntryActivity created");
                    }
                });
    }

    private void ensureWechatApiReady() {
        Context context = AndroidAppHelper.currentApplication();
        if (context == null) {
            mainHandler.postDelayed(this::ensureWechatApiReady, 300L);
            return;
        }
        try {
            Class<?> managerClass = loadHostClass(
                    "com.xtc.common.util.WXBaseManager");
            Class<?> apiClass = loadHostClass(
                    "com.tencent.mm.opensdk.openapi.IWXAPI");
            Object manager = XposedHelpers.callStaticMethod(
                    managerClass, "getInstance");
            Object api = XposedHelpers.callMethod(manager, "getApi");
            wxApiReady = api != null && apiClass.isInstance(api);
            lastWechatProbeAt = System.currentTimeMillis();
            if (wxApiReady) {
                recordDiagnostic("WeChat API ready on resumed host activity");
                scheduleHostReadyCheck();
            } else {
                recordDiagnostic("WeChat API remained unavailable");
                if (pendingWechatStartState != null) scheduleWechatStartCheck();
            }
        } catch (Throwable error) {
            recordDiagnostic("WeChat API initialization on resume failed: "
                    + Log.getStackTraceString(error));
        }
    }

    private void loadExistingHostSession() {
        if (pendingOfficialState == null) return;
        Context context = AndroidAppHelper.currentApplication();
        if (context == null) return;
        try {
            SharedPreferences preferences = context.getSharedPreferences(
                    context.getPackageName(), Context.MODE_PRIVATE);
            String value = preferences.getString(
                    "mobile_account_login_status", null);
            if (value == null || value.isEmpty()) return;
            if (parseHostSession(value)) {
                recordDiagnostic("loaded persisted host account session");
            } else {
                retryLoadPersistedHostSession();
            }
        } catch (Throwable error) {
            recordDiagnostic("persisted host session unavailable: "
                    + error.getClass().getSimpleName());
            retryLoadPersistedHostSession();
        }
    }

    private void retryLoadPersistedHostSession() {
        if (pendingOfficialState == null || officialHostSessionRetries >= 20) return;
        officialHostSessionRetries++;
        mainHandler.postDelayed(this::loadExistingHostSession, 150L);
    }

    private boolean parseHostSession(String value) throws Exception {
        JSONObject record = new JSONObject(value);
        JSONObject account = record.optJSONObject("MobileAccount");
        if (account == null) account = record;
        String token = account.optString("token", "");
        if (token.isEmpty()) return false;
        String mobileId = account.optString("mobileId", "");
        JSONObject session = new JSONObject()
                .put("accountId", account.optString("mobileId", ""))
                .put("authId", account.optString("authId", ""))
                .put("mobileId", account.optString("mobileId", ""))
                .put("ticket", token)
                .put("userName", firstNonEmpty(
                        account.optString("name", ""),
                        account.optString("number", ""),
                        account.optString("mobileId", "")))
                .put("mobileNumber", account.optString("number", ""))
                .put("avatar", account.optString("icon", ""))
                .put("ssoAccountId", ticketAccountId(token));
        attachHostBusinessIdentity(session, mobileId);
        hostSessionJson = session.toString();
        return true;
    }

    private void hookOfficialSessionStore() {
        try {
            Class<?> sharedToolClass = Class.forName(
                    "com.xtc.common.shared.SharedTool", false, hostClassLoader);
            XposedHelpers.findAndHookMethod(sharedToolClass, "saveString",
                    String.class, String.class, new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(MethodHookParam param) {
                            if (!"mobile_account_login_status".equals(param.args[0])
                                    || param.args[1] == null) return;
                            try {
                                parseHostSession(String.valueOf(param.args[1]));
                                recordDiagnostic("captured host account session");
                            } catch (Throwable error) {
                                recordDiagnostic("host session parse skipped: "
                                        + error.getClass().getSimpleName());
                            }
                        }
                    });
        } catch (Throwable error) {
            throw new IllegalStateException(
                    "session store hook unavailable", error);
        }
    }

    private void hookWechatCallback() throws Throwable {
        final Class<?> authResponseClass = Class.forName(
                "com.tencent.mm.opensdk.modelmsg.SendAuth$Resp", false, hostClassLoader);
        XposedHelpers.findAndHookMethod(
                "com.xtc.common.util.BaseWXEntryActivity",
                hostClassLoader,
                "onResp",
                "com.tencent.mm.opensdk.modelbase.BaseResp",
                new XC_MethodHook() {
                    @Override
                    protected void beforeHookedMethod(MethodHookParam param) {
                        Object response = param.args[0];
                        if (response == null || !authResponseClass.isInstance(response)) return;
                        String wireState = (String) XposedHelpers.getObjectField(response, "state");
                        String officialState = pendingOfficialState;
                        boolean officialRequest = officialState != null
                                && (wireState == null || "login_state".equals(wireState));
                        boolean bridgeRequest = registry.matches(wireState);
                        if (!officialRequest && !bridgeRequest) return;

                        int errorCode = XposedHelpers.getIntField(response, "errCode");
                        String error = (String) XposedHelpers.getObjectField(response, "errStr");
                        long now = System.currentTimeMillis();
                        boolean owned = officialRequest
                                ? registry.claimOfficialWechat(
                                        officialState, errorCode, error, now)
                                : registry.claimWechat(wireState, errorCode, error, now);
                        if (!owned) return;
                        recordDiagnostic("wx callback received, official="
                                + officialRequest + ", errCode=" + errorCode);
                        if (errorCode != 0) {
                            pendingOfficialState = null;
                            mainHandler.post(BridgeRuntime.this::releaseHostLogin);
                        }
                        // Keep the original callback. BaseWXEntryActivity must
                        // broadcast it so WXAccountManager can run the host's
                        // own wc(), persistence and IM startup sequence.
                    }
                });
    }

    private void completeHostLogin(final String wireState, final Object service,
                                   final Class<?> mobileAccountClass) {
        recordDiagnostic("reading host account session");
        try {
            Object account = loadMobileAccount(service, mobileAccountClass);
            String sessionJson = hostSessionJson;
            if (account != null && mobileAccountClass.isInstance(account)) {
                String mobileId = stringField(account, "getMobileId");
                String token = stringField(account, "getToken");
                String authId = stringField(account, "getAuthId");
                if (!token.isEmpty()) {
                    JSONObject session = new JSONObject()
                            .put("accountId", mobileId)
                            .put("authId", authId)
                            .put("mobileId", mobileId)
                            .put("ticket", token)
                            .put("userName", firstNonEmpty(
                                    stringField(account, "getName"),
                                    stringField(account, "getNumber"),
                                    mobileId))
                            .put("mobileNumber", firstNonEmpty(
                                    stringField(account, "getNumber"),
                                    stringField(account, "getContactNumber")))
                            .put("avatar", stringField(account, "getIcon"))
                            .put("ssoAccountId", ticketAccountId(token));
                    attachHostBusinessIdentity(session, mobileId);
                    sessionJson = session.toString();
                }
            }
            if (account == null && hostSessionJson == null) {
                if (officialHostSessionRetries < 12) {
                    officialHostSessionRetries++;
                    recordDiagnostic("host account not ready, retry "
                            + officialHostSessionRetries);
                    mainHandler.postDelayed(() -> completeHostLogin(
                            wireState, service, mobileAccountClass), 400L);
                    return;
                }
            }
            if (sessionJson == null || sessionJson.isEmpty()) {
                throw new IllegalStateException("host session is unavailable");
            }
            AuthorizationSnapshot completion =
                    registry.completeWithAccountForInternal(
                            wireState, sessionJson, 0, null,
                            System.currentTimeMillis());
            if (completion != null) {
                recordDiagnostic("host account login completed");
                showCredentialPreview(
                        completion, registry.originForInternal(completion.state));
            }
        } catch (Throwable error) {
            recordDiagnostic("reading host account failed: "
                    + error.getClass().getSimpleName());
            registry.failLogin(wireState, "session_unavailable",
                    "小天才登录成功，但无法读取账号会话。",
                    System.currentTimeMillis());
        } finally {
            pendingOfficialState = null;
            officialHostSessionRetries = 0;
            mainHandler.post(this::releaseHostLogin);
        }
    }

    private void releaseHostLogin() {
        hostLoginInFlight.set(false);
    }

    private Class<?> loadHostClass(String name) throws Throwable {
        return Class.forName(name, false, hostClassLoader);
    }

    private Object loadMobileService(Context context) throws Throwable {
        Class<?> serviceClass = loadHostClass(
                "com.xtc.account.service.impl.Gambia");
        Object service = XposedHelpers.callStaticMethod(
                serviceClass, "Yd", context);
        if (service == null) {
            throw new IllegalStateException("Gambia.Yd returned null");
        }
        return service;
    }

    private Object loadMobileAccount(Object service, Class<?> mobileAccountClass) {
        Object account = XposedHelpers.callMethod(service, "Xb");
        if (account != null && mobileAccountClass.isInstance(account)) return account;
        Context context = AndroidAppHelper.currentApplication();
        if (context == null) return null;
        try {
            Class<?> api = Class.forName(
                    "com.xtc.component.api.account.AccountInfoApi",
                    false, hostClassLoader);
            account = XposedHelpers.callStaticMethod(api, "getMobileAccount", context);
            return account != null && mobileAccountClass.isInstance(account) ? account : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * The official host uses these values to identify the same Android
     * installation across SSO and its business APIs. They are separate from
     * the SSO deviceId embedded in the ticket.
     */
    private void attachHostBusinessIdentity(
            JSONObject session, String mobileId) {
        Context context = AndroidAppHelper.currentApplication();
        if (context == null || session == null || mobileId == null
                || mobileId.trim().isEmpty()) {
            return;
        }
        try {
            Class<?> deviceToolClass = loadHostClass(
                    "com.xtc.data.device.DeviceDataTool");
            Object deviceTool = XposedHelpers.callStaticMethod(
                    deviceToolClass, "getInstance", context);
            if (deviceTool == null) {
                recordDiagnostic("host business identity unavailable: no device tool");
                return;
            }
            String deviceId = callStringGetter(
                    deviceTool, "getDeviceId", mobileId);
            String mac = callStringGetter(
                    deviceTool, "getMacAddress", context);
            String machineId = callStringGetter(
                    deviceTool, "getMachineId");
            String newDeviceId = callStringGetter(
                    deviceTool, "getNewDeviceId");
            session.put("bizDeviceId", deviceId)
                    .put("bizMac", mac)
                    .put("bizMachineId", machineId)
                    .put("bizNDeviceId", firstNonEmpty(newDeviceId, deviceId))
                    .put("businessIdentity", !deviceId.isEmpty()
                            && !mac.isEmpty() && !machineId.isEmpty());
            recordDiagnostic("host business identity captured, "
                    + "device=" + (deviceId.isEmpty() ? "missing" : "present")
                    + ", mac=" + (mac.isEmpty() ? "missing" : "present")
                    + ", machine=" + (machineId.isEmpty() ? "missing" : "present")
                    + ", newDevice=" + (newDeviceId.isEmpty() ? "missing" : "present"));
        } catch (Throwable error) {
            recordDiagnostic("host business identity capture failed: "
                    + error.getClass().getSimpleName());
        }
    }

    private static String callStringGetter(
            Object target, String getter, Object... args) {
        try {
            Object value = XposedHelpers.callMethod(
                    target, getter, args);
            return value == null ? "" : String.valueOf(value);
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static String stringField(Object target, String getter) {
        try {
            Object value = XposedHelpers.callMethod(target, getter);
            return value == null ? "" : String.valueOf(value);
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return "";
    }

    private static String ticketAccountId(String ticket) {
        try {
            return new JSONObject(ticket).optString("accountId", "");
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static String failureMessage(Object value) {
        if (value == null) return "";
        try {
            Object desc = XposedHelpers.getObjectField(value, "desc");
            if (desc != null && !String.valueOf(desc).trim().isEmpty()) {
                return String.valueOf(desc).trim();
            }
        } catch (Throwable ignored) {
        }
        return String.valueOf(value);
    }

    @Override
    public void onAuthorizationCreated(final String state) {
        mainHandler.post(() -> {
            if (registry.originForInternal(state) == null) return;
            activeTransferredState = null;
            confirmationGraceUntil = Math.max(confirmationGraceUntil,
                    System.currentTimeMillis() + 1_000L);
            showNextConfirmationWhenHostReady();
            mainHandler.postDelayed(
                    () -> expire(state), BridgeContract.REQUEST_TTL_MS);
        });
    }

    @Override
    public void onAuthorizationTransferAccepted(final String state) {
        recordDiagnostic("browser bound deep-link authorization");
        mainHandler.post(() -> {
            confirmationGraceUntil = 0L;
            if (state.equals(activeTransferredState)) {
                showNextConfirmationWhenHostReady();
            }
        });
    }

    @Override
    public void onAuthorizationCancelled(final String state) {
        mainHandler.post(() -> {
            clearPendingWechatStart(state);
            activeTransferredState = null;
            dismissConfirmation(state);
            showNextConfirmationWhenHostReady();
        });
    }

    @Override
    public String hostVersion() {
        Context context = AndroidAppHelper.currentApplication();
        if (context == null) return "unknown";
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(
                    BridgeContract.HOST_PACKAGE, 0);
            return info.versionName == null ? "unknown" : info.versionName;
        } catch (Throwable error) {
            return "unknown";
        }
    }

    private void showCredentialPreview(AuthorizationSnapshot snapshot, String origin) {
        if (snapshot == null || !snapshot.isTerminal()) return;
        Context context = AndroidAppHelper.currentApplication();
        if (context == null) return;
        // The registry already makes completion and redirect claiming atomic,
        // so duplicate SDK callbacks cannot open a second preview.
        String previewKey = snapshot.state + ":" + snapshot.status + ":" + snapshot.expiresAt;
        try {
            Intent preview = new Intent();
            preview.setClassName(BridgeContract.MODULE_PACKAGE,
                    BridgeContract.MODULE_PACKAGE + ".MainActivity");
            preview.setAction(MainActivity.ACTION_SHOW_CREDENTIAL);
            preview.putExtra(MainActivity.EXTRA_STATE, snapshot.state);
            if (snapshot.accountSession != null) {
                preview.putExtra(MainActivity.EXTRA_SESSION, snapshot.accountSession);
            }
            preview.putExtra(MainActivity.EXTRA_ORIGIN,
                    origin == null ? "小天才家长端 · 原生微信登录" : origin);
            preview.putExtra(MainActivity.EXTRA_WECHAT_ERROR_CODE, snapshot.wechatErrorCode);
            preview.putExtra(MainActivity.EXTRA_WECHAT_ERROR, snapshot.wechatError);
            preview.putExtra(MainActivity.EXTRA_CAPTURED_AT, System.currentTimeMillis());
            preview.putExtra(MainActivity.EXTRA_HOST_VERSION, hostVersion());
            preview.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            Activity activity = resumedActivity.get();
            Context launcher = activity != null && !activity.isFinishing()
                    && !activity.isDestroyed() ? activity : context;
            launcher.startActivity(preview);
            lastPreviewState = previewKey;
            bringResultScreenToFrontAfterHostSettles();
        } catch (Throwable error) {
            recordDiagnostic("result screen could not be opened: "
                    + error.getClass().getSimpleName());
        }
    }

    /**
     * XTC may update its own task after the login callback. Reuse the result
     * activity's existing task with a plain launcher intent so those lifecycle
     * updates do not leave the user on the host screen.
     */
    private void bringResultScreenToFrontAfterHostSettles() {
        mainHandler.postDelayed(this::bringResultScreenToFront, 400L);
        mainHandler.postDelayed(this::bringResultScreenToFront, 1_200L);
    }

    private void bringResultScreenToFront() {
        Context context = AndroidAppHelper.currentApplication();
        if (context == null) return;
        Intent bring = context.getPackageManager().getLaunchIntentForPackage(
                BridgeContract.MODULE_PACKAGE);
        if (bring == null) return;
        bring.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        try {
            context.startActivity(bring);
        } catch (Throwable error) {
            recordDiagnostic("result screen could not be kept in front: "
                    + error.getClass().getSimpleName());
        }
    }

    private void launchHost() {
        long now = System.currentTimeMillis();
        if (now - lastHostLaunch < 3_000L) return;
        Context context = AndroidAppHelper.currentApplication();
        if (context == null) return;
        try {
            Intent intent = context.getPackageManager().getLaunchIntentForPackage(
                    BridgeContract.HOST_PACKAGE);
            if (intent == null) return;
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            context.startActivity(intent);
            lastHostLaunch = now;
        } catch (Throwable error) {
            // Android can reject background activity starts. The polling page
            // keeps waiting_for_host, so the user can open XTC manually.
            recordDiagnostic("host launch deferred: "
                    + error.getClass().getSimpleName());
        }
    }

    /**
     * Wait for the foreground host window to remain usable before showing
     * consent. A single lifecycle callback can still arrive while the launch
     * screen is being replaced. The WeChat SDK is probed only after the user
     * confirms, so its initialization cannot block the consent dialog.
     */
    private void showNextConfirmationWhenHostReady() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::showNextConfirmationWhenHostReady);
            return;
        }
        if (confirmationDialog != null) return;
        if (confirmationState != null) {
            // A page transition can replace the Activity that owns an
            // AlertDialog without dismissing it cleanly. Never leave a
            // stranded dialog attached to the old login launch page.
            dismissConfirmation(confirmationState);
        }
        AuthorizationSnapshot request = registry.nextPending(
                System.currentTimeMillis());
        if (request == null) return;
        Activity activity = resumedActivity.get();
        if (request.state.equals(activeTransferredState)
                && (activity == null
                || !isHostActivity(activity))) {
            activity = null;
        }
        if (!isHostReady(activity) || !isLoginMethodActivity(activity)) {
            hostReadySince = 0L;
            hostWasReady = false;
            recordReadinessWait(activity);
            scheduleHostReadyCheck();
            return;
        }
        long now = System.currentTimeMillis();
        if (!hostWasReady) {
            hostWasReady = true;
            hostReadySince = now;
            recordDiagnostic("host window ready; confirming stability");
        }
        long remaining = hostReadySince + HOST_READY_STABLE_MS - now;
        if (remaining > 0L) {
            mainHandler.postDelayed(
                    this::showNextConfirmationWhenHostReady, remaining);
            return;
        }
        recordDiagnostic("host window stable; showing login confirmation");
        showNextConfirmation();
    }

    private void recordReadinessWait(Activity activity) {
        long now = System.currentTimeMillis();
        if (now - lastReadinessLogAt < READINESS_LOG_INTERVAL_MS) return;
        lastReadinessLogAt = now;
        String activityName = activity == null ? "none"
                : activity.getClass().getSimpleName();
        recordDiagnostic("waiting for confirmation: activity=" + activityName
                + ", focused=" + (activity != null && activity.hasWindowFocus())
                + ", resumed=" + (activity == resumedActivity.get()));
    }

    private static boolean isHostReady(Activity activity) {
        if (activity == null || activity.isFinishing()
                || activity.isDestroyed() || activity.getWindow() == null) {
            return false;
        }
        View decor = activity.getWindow().getDecorView();
        return decor != null
                && decor.isAttachedToWindow()
                && decor.getVisibility() == View.VISIBLE
                && decor.getWidth() > 0
                && decor.getHeight() > 0;
    }

    private static boolean isLoginMethodActivity(Activity activity) {
        return activity != null
                && "com.xtc.choneclick.activity.ThirdLoginRecommendActivity"
                        .equals(activity.getClass().getName());
    }

    private boolean isHostSessionReady() {
        return isHostReady(resumedActivity.get());
    }

    private void showNextConfirmation() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::showNextConfirmation);
            return;
        }
        if (confirmationDialog != null) return;
        if (confirmationGraceUntil > System.currentTimeMillis()) {
            scheduleConfirmationRetry();
            return;
        }
        loadExistingHostSession();
        AuthorizationSnapshot request = registry.nextPending(System.currentTimeMillis());
        if (request == null) return;
        Activity activity = resumedActivity.get();
        if (!isHostReady(activity) || !isLoginMethodActivity(activity)) {
            launchHost();
            scheduleConfirmationRetry();
            return;
        }
        if (!registry.mark(request.state, AuthorizationSnapshot.WAITING_FOR_HOST,
                AuthorizationSnapshot.AWAITING_CONFIRMATION, System.currentTimeMillis())) {
            return;
        }

        confirmationState = request.state;
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("允许网页使用微信授权？")
                .setMessage("连接地址：jzbridge"
                        + "\n\n确认后将打开小天才官方微信登录。")
                .setNegativeButton("拒绝", (ignored, which) ->
                        reject(request.state, "user_denied",
                                "你已拒绝这个网页的授权请求。"))
                .setPositiveButton("允许并打开微信", (ignored, which) ->
                        sendWechatAuthorization(request.state))
                .setOnCancelListener(ignored ->
                        reject(request.state, "user_denied",
                                "你已取消这个网页的授权请求。"))
                .create();
        confirmationDialog = dialog;
        dialog.setOnDismissListener(ignored -> {
            if (confirmationDialog == dialog) {
                confirmationDialog = null;
                confirmationState = null;
            }
        });
        try {
            dialog.show();
        } catch (Throwable error) {
            confirmationDialog = null;
            confirmationState = null;
            recordDiagnostic("confirmation UI failed: "
                    + Log.getStackTraceString(error));
            registry.fail(request.state, "host_ui_unavailable",
                    "小天才当前页面无法显示确认框，请打开小天才后重试。",
                    System.currentTimeMillis());
            return;
        }
    }

    private static String safeOrigin(String origin) {
        return origin == null ? "未知来源（请勿继续）" : origin;
    }

    private void scheduleConfirmationRetry() {
        if (retryScheduled) return;
        retryScheduled = true;
        mainHandler.postDelayed(() -> {
            retryScheduled = false;
            showNextConfirmation();
        }, 250L);
    }

    private void reject(String state, String code, String message) {
        clearPendingWechatStart(state);
        if (state.equals(activeTransferredState)) activeTransferredState = null;
        if (registry.fail(state, code, message, System.currentTimeMillis())) {
            dismissConfirmation(state);
        }
    }

    private void dismissConfirmation(String state) {
        if (confirmationState == null || !confirmationState.equals(state)) return;
        AlertDialog dialog = confirmationDialog;
        confirmationDialog = null;
        confirmationState = null;
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
    }

    private void expire(String state) {
        clearPendingWechatStart(state);
        if (state.equals(activeTransferredState)) activeTransferredState = null;
        if (registry.fail(state, "expired", "授权请求已过期，请重新发起。",
                System.currentTimeMillis())) {
            dismissConfirmation(state);
        }
    }

    private void sendWechatAuthorization(String state) {
        Activity activity = resumedActivity.get();
        if (!isHostReady(activity)) {
            registry.fail(state, "host_not_ready",
                    "小天才当前页面不可用，请返回小天才后重试。",
                    System.currentTimeMillis());
            activeTransferredState = null;
            dismissConfirmation(state);
            return;
        }
        if (!registry.mark(state, AuthorizationSnapshot.AWAITING_CONFIRMATION,
                AuthorizationSnapshot.LAUNCHING_WECHAT,
                System.currentTimeMillis())) {
            dismissConfirmation(state);
            return;
        }
        pendingWechatStartState = state;
        pendingWechatStartDeadline =
                System.currentTimeMillis() + WECHAT_READY_TIMEOUT_MS;
        lastWechatProbeAt = 0L;
        recordDiagnostic("user confirmed; waiting briefly for WeChat API");
        ensureWechatApiReady();
        launchWechatWhenReady();
    }

    private void launchWechatWhenReady() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::launchWechatWhenReady);
            return;
        }
        final String state = pendingWechatStartState;
        if (state == null) return;
        if (!isHostReady(resumedActivity.get())) {
            failPendingWechatStart("host_ui_unavailable",
                    "小天才当前页面不可用，请回到小天才后重试。");
            return;
        }
        if (wxApiReady) {
            pendingWechatStartState = null;
            pendingWechatStartDeadline = 0L;
            startOfficialWechat(state);
            return;
        }
        long now = System.currentTimeMillis();
        if (now >= pendingWechatStartDeadline) {
            failPendingWechatStart("host_not_ready",
                    "小天才微信组件尚未初始化完成，请稍后重新发起登录。");
            return;
        }
        if (now - lastWechatProbeAt >= WECHAT_PROBE_INTERVAL_MS) {
            ensureWechatApiReady();
            if (wxApiReady) {
                launchWechatWhenReady();
                return;
            }
        }
        scheduleWechatStartCheck();
    }

    private void scheduleWechatStartCheck() {
        if (pendingWechatStartScheduled || pendingWechatStartState == null) return;
        pendingWechatStartScheduled = true;
        mainHandler.postDelayed(() -> {
            pendingWechatStartScheduled = false;
            launchWechatWhenReady();
        }, WECHAT_PROBE_INTERVAL_MS);
    }

    private void failPendingWechatStart(String code, String message) {
        String state = pendingWechatStartState;
        clearPendingWechatStart(state);
        if (state == null) return;
        recordDiagnostic("WeChat launch aborted: " + code);
        registry.fail(state, code, message, System.currentTimeMillis());
        activeTransferredState = null;
    }

    private void clearPendingWechatStart(String state) {
        if (state == null || !state.equals(pendingWechatStartState)) return;
        pendingWechatStartState = null;
        pendingWechatStartDeadline = 0L;
    }

    private void startOfficialWechat(String state) {
        Activity activity = resumedActivity.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            registry.fail(state, "host_ui_unavailable",
                    "小天才当前页面不可用，请回到小天才后重试。",
                    System.currentTimeMillis());
            activeTransferredState = null;
            return;
        }
        if (!wxApiReady) {
            registry.fail(state, "host_not_ready",
                    "小天才刚启动，微信组件还未初始化完成，请稍后重试。",
                    System.currentTimeMillis());
            return;
        }
        if (!hostLoginInFlight.compareAndSet(false, true)) {
            registry.fail(state, "login_busy",
                    "小天才正在完成另一个登录，请稍后重试。",
                    System.currentTimeMillis());
            return;
        }
        try {
            Class<?> accountManagerClass = loadHostClass(
                    "com.xtc.account.thirdlogin.WXAccountManager");
            Object accountManager = XposedHelpers.getStaticObjectField(
                    accountManagerClass, "Hawaii");
            if (accountManager == null) {
                throw new IllegalStateException(
                        "WXAccountManager singleton is unavailable");
            }
            Object listener = createHostLoginListener(state);
            pendingOfficialState = state;
            registry.mark(state, AuthorizationSnapshot.LAUNCHING_WECHAT,
                    AuthorizationSnapshot.WAITING_FOR_WECHAT, System.currentTimeMillis());
            XposedHelpers.callMethod(
                    accountManager, "Ukraine", activity, listener);
            recordDiagnostic("delegated authorization to WXAccountManager");
        } catch (Throwable error) {
            recordDiagnostic("WXAccountManager launch failed: "
                    + Log.getStackTraceString(error));
            registry.fail(state, "host_incompatible",
                    "小天才官方微信登录未能启动，请查看 LSPosed 日志。",
                    System.currentTimeMillis());
            pendingOfficialState = null;
            activeTransferredState = null;
            releaseHostLogin();
        }
    }

    private Object createHostLoginListener(final String state) throws Throwable {
        final Class<?> listenerClass = loadHostClass(
                "com.xtc.component.api.account.callback.OnLoginListener");
        return Proxy.newProxyInstance(listenerClass.getClassLoader(),
                new Class<?>[]{listenerClass}, (proxy, method, args) -> {
                    String name = method.getName();
                    if ("onSuccess".equals(name)) {
                        recordDiagnostic("official host login success");
                        officialHostSessionRetries = 0;
                        Context context = AndroidAppHelper.currentApplication();
                        if (context == null) {
                            registry.fail(state, "host_context_unavailable",
                                    "小天才登录成功，但应用上下文已经不可用。",
                                    System.currentTimeMillis());
                            pendingOfficialState = null;
                            releaseHostLogin();
                            return null;
                        }
                        try {
                            Object service = loadMobileService(context);
                            Class<?> mobileAccountClass = loadHostClass(
                                    "com.xtc.component.api.account.bean.MobileAccount");
                            mainHandler.postDelayed(() -> completeHostLogin(
                                    BridgeContract.wireState(state),
                                    service, mobileAccountClass), 300L);
                        } catch (Throwable error) {
                            recordDiagnostic("host account service unavailable: "
                                    + error.getClass().getSimpleName());
                            registry.fail(state, "session_unavailable",
                                    "小天才登录成功，但无法读取账号会话。",
                                    System.currentTimeMillis());
                            pendingOfficialState = null;
                            releaseHostLogin();
                        }
                        return null;
                    }
                    if ("onFailed".equals(name)) {
                        Object failure = args != null && args.length > 0 ? args[0] : null;
                        String message = failureMessage(failure);
                        recordDiagnostic("official host login failed: " + message);
                        registry.fail(state, "host_login_failed",
                                message.isEmpty() ? "小天才未能完成微信登录。"
                                        : "小天才未能完成微信登录：" + message,
                                System.currentTimeMillis());
                        pendingOfficialState = null;
                        mainHandler.post(BridgeRuntime.this::releaseHostLogin);
                        return null;
                    }
                    if ("hashCode".equals(name)) return System.identityHashCode(proxy);
                    if ("equals".equals(name)) return proxy == args[0];
                    if ("toString".equals(name)) return "JZOfficialWechatLoginListener";
                    return null;
                });
    }

}
