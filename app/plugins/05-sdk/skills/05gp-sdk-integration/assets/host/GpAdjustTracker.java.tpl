package @@PACKAGE@@;

import android.app.Application;
import android.util.Log;
import com.adjust.sdk.Adjust;
import com.adjust.sdk.AdjustConfig;
import com.adjust.sdk.AdjustEvent;
import com.adjust.sdk.LogLevel;

final class GpAdjustTracker {
    private static final String TAG = "GpAdjust";
    private static final String APP_TOKEN = @@APP_TOKEN@@;
    private GpAdjustTracker() {}

    static void initialize(Application application) {
        AdjustConfig config = new AdjustConfig(application, APP_TOKEN,
                AdjustConfig.ENVIRONMENT_@@ADJUST_ENV@@);
        config.setLogLevel(LogLevel.WARN);
        config.setOnEventTrackingSucceededListener(result ->
                Log.i(TAG, "Adjust event acknowledged: " + result.callbackId));
        config.setOnEventTrackingFailedListener(result ->
                Log.w(TAG, "Adjust event failed: " + result.callbackId + "; willRetry=" + result.willRetry));
        config.setOnSessionTrackingSucceededListener(result -> Log.i(TAG, "Adjust session acknowledged"));
        config.setOnSessionTrackingFailedListener(result ->
                Log.w(TAG, "Adjust session failed; willRetry=" + result.willRetry));
        // This API shape uses the verified 5.8.0 lifecycle provider; inspect other versions first.
        Adjust.initSdk(config);
        Log.i(TAG, "Adjust initialization requested; environment=" + @@ADJUST_ENV_STRING@@);
    }

    static void onPaEvent(String eventName, String paramsJson) {
        Log.i(TAG, "PA event received: " + eventName + "; JSON length="
                + (paramsJson == null ? 0 : paramsJson.length()));
        if (eventName == null) return;
        String token = tokenForEvent(eventName);
        if (token == null) {
            Log.i(TAG, "PA event has no configured Adjust token: " + eventName);
            return;
        }
        try {
            AdjustEvent event = new AdjustEvent(token);
            // Correlates callbacks. It is not a transaction deduplication ID.
            event.setCallbackId(eventName);
            // Counts only. Revenue/transaction data require the actual business contract.
            Adjust.trackEvent(event);
            Log.i(TAG, "Event submitted to Adjust SDK: " + eventName);
        } catch (RuntimeException error) {
            Log.e(TAG, "Could not submit Adjust event: " + eventName, error);
        }
    }

    private static String tokenForEvent(String eventName) {
        switch (eventName) {
@@EVENT_CASES@@
            default: return null;
        }
    }
}
