package @@PACKAGE@@;

import android.app.Application;

/** Merge initialize() into an existing Application instead of registering a second one. */
public final class GpSdkApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        GpAdjustTracker.initialize(this);
    }
}
