package @@PACKAGE@@;

import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import com.pakit.sdk.PA;
import @@BASE_ACTIVITY@@;
import java.util.UUID;

/** Merge into the verified existing host; do not replace unrelated startup logic. */
public final class GpSdkActivity extends @@BASE_ACTIVITY_SIMPLE@@ {
    private static final String TAG = "GpPaSdk";
    private static final PA.PAEventListener EVENT_LISTENER = GpAdjustTracker::onPaEvent;
    private boolean sdkStarted;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
    }

    @Override
    protected void onResume() {
        super.onResume();
        PA.setEventListener(EVENT_LISTENER);
        if (!sdkStarted) {
            sdkStarted = true;
            getWindow().getDecorView().post(this::startSdk);
        }
    }

    private void startSdk() {
        if (isFinishing() || isDestroyed()) return;
        try {
            // AF UID/GAID are not Adjust ADID. Use runtime providers if already present.
            PA.setPa("", "");
            Log.i(TAG, "Starting PA " + @@PA_COORDINATE@@ + "; mode=" + @@PA_MODE@@
                    + "; package=" + getPackageName());
            PA.st(@@PA_MODE@@, @@PA_ATT@@, installationId(),
                    status -> Log.i(TAG, "PA startup status=" + status), this);
        } catch (RuntimeException | LinkageError error) {
            Log.e(TAG, "PA startup failed", error);
        }
    }

    private String installationId() {
        // Only for a host without a native account provider: persistent installation identity.
        SharedPreferences preferences = getSharedPreferences("pa_identity", MODE_PRIVATE);
        String uid = preferences.getString("installation_id", "");
        if (uid == null || uid.isEmpty()) {
            uid = "install-" + UUID.randomUUID();
            preferences.edit().putString("installation_id", uid).apply();
        }
        return uid;
    }
    // The global listener captures no Activity. An old onDestroy must not clear a new host's listener.
}
