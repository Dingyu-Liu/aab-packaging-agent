#import "PAKitIntegration.h"
#import "PAKitAdjustIntegration.h"
#import "PA.h"
#import <UIKit/UIKit.h>
#import <AppTrackingTransparency/AppTrackingTransparency.h>
#import <AdSupport/AdSupport.h>

NSNotificationName const PAKitDidReceiveEventNotification = @"PAKitDidReceiveEventNotification";
NSNotificationName const PAKitDidFinishStartingNotification = @"PAKitDidFinishStartingNotification";

@implementation PAKitIntegration

+ (void)startIfEnabled
{
    NSAssert(NSThread.isMainThread, @"PAKit must start on the main thread.");
    if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive)
        return;

    // Host-side switch for temporarily disabling SDK startup.
    if (![NSBundle.mainBundle.infoDictionary[@"PAKitIntegrationEnabled"] boolValue])
    {
        static dispatch_once_t disabledNotice;
        dispatch_once(&disabledNotice, ^{
            NSLog(@"[PAKit] Startup disabled by PAKitIntegrationEnabled.");
        });
        return;
    }

    // didBecomeActive may run again while ATT is still resolving. Wait for its
    // completion before presenting the SDK's WebView or clipboard prompt.
    static BOOL trackingRequestInFlight = NO;
    static BOOL requestedTrackingThisLaunch = NO;
    if (trackingRequestInFlight)
        return;

    ATTrackingManagerAuthorizationStatus trackingStatus = ATTrackingManager.trackingAuthorizationStatus;
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    if (trackingStatus != ATTrackingManagerAuthorizationStatusAuthorized)
        [defaults removeObjectForKey:@"IDFA"];

    if (trackingStatus == ATTrackingManagerAuthorizationStatusNotDetermined && !requestedTrackingThisLaunch)
    {
        requestedTrackingThisLaunch = YES;
        trackingRequestInFlight = YES;
        [ATTrackingManager requestTrackingAuthorizationWithCompletionHandler:^(ATTrackingManagerAuthorizationStatus status) {
            (void)status;
            // The system may complete off the main thread or while the app is
            // inactive. startIfEnabled rechecks both activity and current consent.
            dispatch_async(dispatch_get_main_queue(), ^{
                trackingRequestInFlight = NO;
                [self startIfEnabled];
            });
        }];
        return;
    }

    NSString *idfa = nil;
    if (trackingStatus == ATTrackingManagerAuthorizationStatusAuthorized)
    {
        NSString *candidate = ASIdentifierManager.sharedManager.advertisingIdentifier.UUIDString;
        if (candidate.length > 0 && ![candidate isEqualToString:@"00000000-0000-0000-0000-000000000000"])
            idfa = candidate;
    }
    if (idfa != nil)
        [defaults setObject:idfa forKey:@"IDFA"];
    else
        [defaults removeObjectForKey:@"IDFA"];

    // Refresh the identifier on foreground entry; never reuse the cached IDFA
    // as authorization. There is no AppsFlyer identifier configured in this app.
    // ATT is resolved (or unavailable) before Adjust can collect identifiers.
    [PAKitAdjustIntegration startIfNeeded];
    [PA setPa:nil b:idfa];

    static dispatch_once_t startOnce;
    dispatch_once(&startOnce, ^{
        [PA setEventCallback:^(NSString *eventName, NSDictionary *params) {
            if (![eventName isKindOfClass:NSString.class] || eventName.length == 0)
                return;
            // Keep business data intact; do not log identifiers, payment details or JSON.
            NSMutableDictionary *event = [@{@"eventName": eventName} mutableCopy];
            if (params != nil)
                event[@"params"] = params;
            dispatch_async(dispatch_get_main_queue(), ^{
                [PAKitAdjustIntegration trackEvent:eventName parameters:params];
                [NSNotificationCenter.defaultCenter postNotificationName:PAKitDidReceiveEventNotification
                                                                  object:nil
                                                                userInfo:event];
            });
        }];

        // This is an installation identifier, not an authenticated account ID.
        NSString *uid = [NSUserDefaults.standardUserDefaults stringForKey:@"PAKitInstallationID"];
        if (uid.length == 0)
        {
            uid = NSUUID.UUID.UUIDString;
            [NSUserDefaults.standardUserDefaults setObject:uid forKey:@"PAKitInstallationID"];
        }

        // Mode 0 uses the real config endpoint embedded in the vendor library.
        [PA st:__PAKIT_START_MODE__ a:(NSInteger)trackingStatus u:uid c:^(NSInteger status) {
            dispatch_async(dispatch_get_main_queue(), ^{
                NSLog(@"[PAKit] Start completed, status=%ld (0 opened, 1 skipped, 2 request failed, 3 parse failed, 4 presentation failed).", (long)status);
                [NSNotificationCenter.defaultCenter postNotificationName:PAKitDidFinishStartingNotification
                                                                  object:nil
                                                                userInfo:@{@"status": @(status)}];
            });
        }];
    });
}

@end
