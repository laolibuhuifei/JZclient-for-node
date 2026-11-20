package com.zxi2233.wechatbridge;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;

import androidx.activity.ComponentActivity;

/**
 * Native, local-only UI for the login bridge.
 *
 * <p>The class stays in Java because the Xposed host runtime references this
 * activity and its historical intent contract. The interface itself is
 * Jetpack Compose.</p>
 */
public final class MainActivity extends ComponentActivity {
    public static final String ACTION_SHOW_CREDENTIAL =
            "com.zxi2233.wechatbridge.action.SHOW_CREDENTIAL";
    public static final String ACTION_AUTHORIZE =
            "com.zxi2233.wechatbridge.action.AUTHORIZE";
    public static final String DEEP_LINK_SCHEME = "jzloginbridge";
    public static final String DEEP_LINK_HOST = "authorize";
    public static final String EXTRA_STATE = "credential_state";
    public static final String EXTRA_SESSION = "credential_session";
    public static final String EXTRA_ORIGIN = "credential_origin";
    public static final String EXTRA_WECHAT_ERROR_CODE = "wechat_error_code";
    public static final String EXTRA_WECHAT_ERROR = "wechat_error";
    public static final String EXTRA_CAPTURED_AT = "captured_at";
    public static final String EXTRA_HOST_VERSION = "host_version";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        ComposeBridgeUi.attach(
                this,
                () -> setIntent(new Intent(this, MainActivity.class))
        );
        consumeLaunchIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        consumeLaunchIntent(intent);
    }

    private void consumeLaunchIntent(Intent intent) {
        if (intent == null) return;
        if (isDeepLink(intent)) {
            String state = intent.getData() == null
                    ? null : intent.getData().getQueryParameter("state");
            if (!BridgeContract.isValidState(state)) {
                JzLoginBridgeState.INSTANCE.clear();
                return;
            }
            JzLoginBridgeState.INSTANCE.markRequest(state);
            openXiaotiancai();
            // Do not retain the one-time state in the activity launch intent.
            setIntent(new Intent(this, MainActivity.class));
            return;
        }
        if (ACTION_SHOW_CREDENTIAL.equals(intent.getAction())
                || intent.hasExtra(EXTRA_SESSION)
                || intent.hasExtra(EXTRA_STATE)) {
            boolean hasSession = !safeExtra(intent, EXTRA_SESSION).isEmpty();
            String origin = safeExtra(intent, EXTRA_ORIGIN);
            JzLoginBridgeState.INSTANCE.applyResult(
                    intent.getAction(),
                    safeExtra(intent, EXTRA_STATE),
                    hasSession,
                    origin,
                    safeExtra(intent, EXTRA_WECHAT_ERROR),
                    intent.getIntExtra(EXTRA_WECHAT_ERROR_CODE, 0),
                    intent.getLongExtra(EXTRA_CAPTURED_AT, 0L),
                    safeExtra(intent, EXTRA_HOST_VERSION)
            );
            // The Compose UI keeps only a status summary. Remove the raw
            // session and state from the launch intent immediately.
            intent.removeExtra(EXTRA_SESSION);
            intent.removeExtra(EXTRA_STATE);
            setIntent(new Intent(this, MainActivity.class));
        }
    }

    private boolean isDeepLink(Intent intent) {
        return Intent.ACTION_VIEW.equals(intent.getAction())
                && intent.getData() != null
                && DEEP_LINK_SCHEME.equals(intent.getData().getScheme())
                && DEEP_LINK_HOST.equals(intent.getData().getHost());
    }

    private void openXiaotiancai() {
        final Intent launch = getPackageManager().getLaunchIntentForPackage(
                BridgeContract.HOST_PACKAGE);
        if (launch == null) {
            JzLoginBridgeState.INSTANCE.reportHostUnavailable();
            return;
        }
        String state = JzLoginBridgeState.INSTANCE.pendingRequest();
        if (BridgeContract.isValidState(state)) {
            String origin = getIntent().getData() == null
                    ? null : getIntent().getData().getQueryParameter("origin");
            launch.setAction(BridgeContract.HOST_AUTH_ACTION);
            launch.putExtra(BridgeContract.EXTRA_DEEP_LINK_STATE, state);
            if (origin != null && !origin.isEmpty()) {
                launch.putExtra(BridgeContract.EXTRA_DEEP_LINK_ORIGIN, origin);
            }
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            startActivity(launch);
            JzLoginBridgeState.INSTANCE.markHostOpening();
        } catch (RuntimeException error) {
            JzLoginBridgeState.INSTANCE.reportHostUnavailable();
        }
    }

    private static String safeExtra(Intent intent, String name) {
        String value = intent.getStringExtra(name);
        return value == null ? "" : value;
    }

}
