#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Delivered on the main thread. userInfo: eventName (NSString), params (NSDictionary, optional).
/// Observe this notification to forward SDK business events to your analytics provider.
FOUNDATION_EXPORT NSNotificationName const PAKitDidReceiveEventNotification;

/// Delivered on the main thread. userInfo: status (NSNumber), using PA.h status values.
FOUNDATION_EXPORT NSNotificationName const PAKitDidFinishStartingNotification;

@interface PAKitIntegration : NSObject

/// Call on the main thread after Unity's window is visible and the app is active.
/// Requests ATT when undetermined, then starts with IDFA only when authorized.
/// Starts once per process, only when PAKitIntegrationEnabled is YES in the app Info.plist.
+ (void)startIfEnabled;

@end

NS_ASSUME_NONNULL_END
