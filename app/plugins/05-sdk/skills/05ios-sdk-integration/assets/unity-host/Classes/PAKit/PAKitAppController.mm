#import <UIKit/UIKit.h>
#import "UnityAppController.h"
#import "UI/UnityAppController+ViewHandling.h"
#import "UI/UnityViewControllerBase.h"
#import "PAKitIntegration.h"
#import "PAKitSafeAreaViewController.h"
#import "PAKitLoadingView.h"

@interface PAKitUnityViewController : UnityDefaultViewController
@property(nonatomic, strong) PAKitLoadingView *startupLoadingView;
@property(nonatomic) BOOL startupHostInstalled;
- (void)installStartupLoadingView;
@end

@implementation PAKitUnityViewController

- (void)installStartupLoadingView
{
    if (self.startupHostInstalled ||
        ![NSBundle.mainBundle.infoDictionary[@"PAKitStartupLoadingEnabled"] boolValue] ||
        ![NSBundle.mainBundle.infoDictionary[@"PAKitIntegrationEnabled"] boolValue])
        return;

    // Called after Unity binds its render view, BEFORE the window is visible.
    // Keep the native loading screen outside the Metal view's layer hierarchy.
    // Unity retains the same render view, scale, drawable and rendering lifecycle.
    UIView *gameView = self.view;
    UIView *hostView = [[UIView alloc] initWithFrame:gameView.frame];
    hostView.backgroundColor = UIColor.blackColor;
    hostView.opaque = YES;
    hostView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    hostView.accessibilityIdentifier = @"PAKitStartupHost";
    gameView.frame = hostView.bounds;
    gameView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [hostView addSubview:gameView];
    self.view = hostView;
    self.startupHostInstalled = YES;

    self.startupLoadingView = [[PAKitLoadingView alloc] initWithFrame:hostView.bounds];
    self.startupLoadingView.translatesAutoresizingMaskIntoConstraints = NO;
    self.startupLoadingView.accessibilityIdentifier = @"PAKitStartupLoading";
    [hostView addSubview:self.startupLoadingView];
    [NSLayoutConstraint activateConstraints:@[
        [self.startupLoadingView.topAnchor constraintEqualToAnchor:hostView.topAnchor],
        [self.startupLoadingView.bottomAnchor constraintEqualToAnchor:hostView.bottomAnchor],
        [self.startupLoadingView.leadingAnchor constraintEqualToAnchor:hostView.leadingAnchor],
        [self.startupLoadingView.trailingAnchor constraintEqualToAnchor:hostView.trailingAnchor],
    ]];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(paKitDidFinishStarting:)
                                              name:PAKitDidFinishStartingNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(paKitPageDidDismiss:)
                                              name:PAKitPageDidDismissNotification object:nil];
}

- (void)viewDidLayoutSubviews
{
    [super viewDidLayoutSubviews];
    // Loading remains above the entire render view, including Unity native subviews.
    if (self.startupLoadingView.superview == self.view)
        [self.view bringSubviewToFront:self.startupLoadingView];
}

- (void)paKitDidFinishStarting:(NSNotification *)notification
{
    NSInteger status = [notification.userInfo[@"status"] integerValue];
    if (status == 0)
    {
        // Opened is not a page-ready signal. Keep the game covered while the
        // SDK container manages its own initial web loading screen.
        return;
    }

    // A skipped page or config/request/presentation failure returns to the game.
    [self showGameAfterPAKit];
}

- (void)paKitPageDidDismiss:(NSNotification *)notification
{
    (void)notification;
    [self showGameAfterPAKit];
}

- (void)showGameAfterPAKit
{
    [self.startupLoadingView removeFromSuperview];
    self.startupLoadingView = nil;
}

- (void)presentViewController:(UIViewController *)controller animated:(BOOL)animated completion:(void (^)(void))completion
{
    BOOL needsHost = [NSBundle.mainBundle.infoDictionary[@"PAKitSafeAreaEnabled"] boolValue] ||
                     [NSBundle.mainBundle.infoDictionary[@"PAKitStartupLoadingEnabled"] boolValue];
    UIViewController *presentation = needsHost ? [PAKitSafeAreaViewController controllerForPresentation:controller] : controller;
    // The SDK appears directly over the black screen, without a sliding transition.
    [super presentViewController:presentation animated:(presentation == controller ? animated : NO) completion:completion];
}

@end

@interface PAKitAppController : UnityAppController
@end

@implementation PAKitAppController

- (void)willStartWithViewController:(UIViewController *)controller
{
    [super willStartWithViewController:controller];
    if ([controller isKindOfClass:PAKitUnityViewController.class])
    {
        [(PAKitUnityViewController *)controller installStartupLoadingView];
        // Unity's showGameUI and pause snapshots must use the host hierarchy.
        // The dedicated _unityView pointer still references the original render view.
        _rootView = controller.view;
    }
}

- (UIViewController *)createUnityViewControllerDefault
{
    // Verify this controller hook against the target Unity export. The source
    // implementation was tested with iOS 17.2+. Keep Unity's notification delegate.
    PAKitUnityViewController *controller = [[PAKitUnityViewController alloc] initShouldHandleFixedOrientation:YES];
    controller.notificationDelegate = [[UnityViewControllerNotificationsDefaultSender alloc] init];
    return controller;
}

- (void)startUnity
{
    [super startUnity];
    [self schedulePAKitStart];
}

- (void)applicationDidBecomeActive:(UIApplication *)application
{
    [super applicationDidBecomeActive:application];
    [self schedulePAKitStart];
}

- (void)schedulePAKitStart
{
    __weak PAKitAppController *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        PAKitAppController *controller = weakSelf;
        if (controller == nil || controller.engineLoadState < kUnityEngineLoadStateAppReady)
            return;
        if (controller.window.hidden || controller.window.rootViewController.view.window == nil)
            return;
        [PAKitIntegration startIfEnabled];
    });
}

- (NSUInteger)application:(UIApplication *)application supportedInterfaceOrientationsForWindow:(UIWindow *)window
{
    // Permit a presented controller's portrait orientation while Unity keeps its own orientation.
    UIViewController *root = window.rootViewController;
    UIViewController *visible = root;
    while (visible.presentedViewController != nil && !visible.presentedViewController.isBeingDismissed)
        visible = visible.presentedViewController;
    if (visible != root)
        return visible.supportedInterfaceOrientations;
#if UNITY_SUPPORT_ROTATION
    return [super application:application supportedInterfaceOrientationsForWindow:window];
#else
    return root != nil ? root.supportedInterfaceOrientations : UIInterfaceOrientationMaskAllButUpsideDown;
#endif
}

@end

IMPL_APP_CONTROLLER_SUBCLASS(PAKitAppController)
