#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSNotificationName const PAKitPageDidDismissNotification;

/// Host-owned presentation adapter. Only PAKit's page controller is contained;
/// alerts and other native presentations are returned unchanged.
@interface PAKitSafeAreaViewController : UIViewController
+ (UIViewController *)controllerForPresentation:(UIViewController *)controller;
@end

NS_ASSUME_NONNULL_END
