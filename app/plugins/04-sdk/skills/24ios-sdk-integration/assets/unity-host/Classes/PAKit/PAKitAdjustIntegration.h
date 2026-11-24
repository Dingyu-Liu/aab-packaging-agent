#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Adjust's delivery result, on the main thread. Contains success, eventToken,
/// optional eventName, and willRetry for failures; never contains the H5 payload.
FOUNDATION_EXPORT NSNotificationName const PAKitAdjustDidTrackEventNotification;

@interface PAKitAdjustIntegration : NSObject

/// Initialize the production Adjust SDK once, after the host has resolved ATT.
+ (void)startIfNeeded;

/// Map a PAKit business callback to its configured Adjust event token.
/// Events without a configured token are left to the host's existing callback.
+ (void)trackEvent:(NSString *)eventName parameters:(nullable NSDictionary *)parameters;

@end

NS_ASSUME_NONNULL_END
