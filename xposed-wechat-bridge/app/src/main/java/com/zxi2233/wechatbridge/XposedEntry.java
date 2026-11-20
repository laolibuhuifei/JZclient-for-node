package com.zxi2233.wechatbridge;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

public final class XposedEntry implements IXposedHookLoadPackage {
    private static final String TAG = "[JzLoginBridge] ";

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam loadPackageParam) {
        XposedBridge.log(TAG + "entry invoked: package=" + loadPackageParam.packageName
                + ", process=" + loadPackageParam.processName);
        if (!BridgeContract.HOST_PACKAGE.equals(loadPackageParam.packageName)) return;
        // A second app process would try to bind the same loopback port. The
        // XTC login activities and WXEntryActivity both live in the main process.
        if (loadPackageParam.processName != null
                && !BridgeContract.HOST_PACKAGE.equals(loadPackageParam.processName)) {
            return;
        }
        try {
            new BridgeRuntime(loadPackageParam.classLoader).install();
            XposedBridge.log(TAG + "loaded in " + BridgeContract.HOST_PACKAGE);
        } catch (Throwable error) {
            XposedBridge.log(TAG + "initialization failed: "
                    + android.util.Log.getStackTraceString(error));
        }
    }
}
