#import "PAKitSafeAreaViewController.h"
#import "PAKitLoadingView.h"
#import <WebKit/WebKit.h>

NSNotificationName const PAKitPageDidDismissNotification = @"PAKitPageDidDismissNotification";
static char PAKitInitialWebLoadContext;

@interface PAKitSafeAreaViewController ()
@property(nonatomic, strong) UIViewController *contentController;
@property(nonatomic, strong) PAKitLoadingView *pageLoadingView;
@property(nonatomic, strong) WKWebView *observedWebView;
@property(nonatomic) BOOL hasAppeared;
@property(nonatomic) BOOL observedPageLoad;
@property(nonatomic) BOOL pageRevealed;
@property(nonatomic) BOOL pageLoadingTimeoutScheduled;
@end

@implementation PAKitSafeAreaViewController

+ (UIViewController *)controllerForPresentation:(UIViewController *)controller
{
    // The vendor only exposes PA.h. Recognize its current page class without
    // importing private headers, altering methods or changing the SDK binary.
    Class pageClass = NSClassFromString(@"PAWebViewController");
    UIViewController *page = controller;
    if ([controller isKindOfClass:UINavigationController.class])
        page = ((UINavigationController *)controller).topViewController;
    if (pageClass == Nil || ![page isKindOfClass:pageClass])
        return controller;

    PAKitSafeAreaViewController *container = [self new];
    container.contentController = controller;
    container.modalPresentationStyle = UIModalPresentationFullScreen;
    container.modalTransitionStyle = controller.modalTransitionStyle;
    return container;
}

- (void)viewDidLoad
{
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.blackColor;

    // Give the entire SDK page a smaller viewport. Scroll insets alone would
    // leave fixed-position H5 controls underneath the status bar / island.
    UIView *viewport = [UIView new];
    viewport.translatesAutoresizingMaskIntoConstraints = NO;
    viewport.clipsToBounds = YES;
    [self.view addSubview:viewport];
    BOOL useSafeArea = [NSBundle.mainBundle.infoDictionary[@"PAKitSafeAreaEnabled"] boolValue];
    UILayoutGuide *safeArea = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [viewport.topAnchor constraintEqualToAnchor:(useSafeArea ? safeArea.topAnchor : self.view.topAnchor)],
        [viewport.bottomAnchor constraintEqualToAnchor:(useSafeArea ? safeArea.bottomAnchor : self.view.bottomAnchor)],
        [viewport.leadingAnchor constraintEqualToAnchor:(useSafeArea ? safeArea.leadingAnchor : self.view.leadingAnchor)],
        [viewport.trailingAnchor constraintEqualToAnchor:(useSafeArea ? safeArea.trailingAnchor : self.view.trailingAnchor)],
    ]];

    UIViewController *content = self.contentController;
    [self addChildViewController:content];
    content.view.translatesAutoresizingMaskIntoConstraints = NO;
    [viewport addSubview:content.view];
    [NSLayoutConstraint activateConstraints:@[
        [content.view.topAnchor constraintEqualToAnchor:viewport.topAnchor],
        [content.view.bottomAnchor constraintEqualToAnchor:viewport.bottomAnchor],
        [content.view.leadingAnchor constraintEqualToAnchor:viewport.leadingAnchor],
        [content.view.trailingAnchor constraintEqualToAnchor:viewport.trailingAnchor],
    ]];
    [content didMoveToParentViewController:self];

    // The host covers the SDK's initial web navigation as well as the config request.
    if ([NSBundle.mainBundle.infoDictionary[@"PAKitStartupLoadingEnabled"] boolValue])
    {
        self.pageLoadingView = [[PAKitLoadingView alloc] initWithFrame:self.view.bounds];
        self.pageLoadingView.accessibilityIdentifier = @"PAKitPageLoading";
        [self.view addSubview:self.pageLoadingView];
        [self observeInitialWebViewIfNeeded];
    }
    else
    {
        self.pageRevealed = YES;
    }
}

- (void)viewDidLayoutSubviews
{
    [super viewDidLayoutSubviews];
    [self observeInitialWebViewIfNeeded];
}

- (void)viewDidAppear:(BOOL)animated
{
    [super viewDidAppear:animated];
    self.hasAppeared = YES;
    [self observeInitialWebViewIfNeeded];
    [self updateInitialPageLoading];

    if (self.pageRevealed || self.pageLoadingTimeoutScheduled)
        return;
    self.pageLoadingTimeoutScheduled = YES;
    // A stalled first document follows the same fallback as a failed SDK request.
    __weak PAKitSafeAreaViewController *weakSelf = self;
    NSTimeInterval pageTimeout = [NSBundle.mainBundle.infoDictionary[@"PAKitInitialPageTimeoutSeconds"] doubleValue];
    if (pageTimeout <= 0)
        pageTimeout = 60;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(pageTimeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        PAKitSafeAreaViewController *controller = weakSelf;
        if (controller != nil && !controller.pageRevealed && controller.presentingViewController != nil)
        {
            NSLog(@"[PAKit] Initial page loading timed out; returning to the game.");
            [controller.presentingViewController dismissViewControllerAnimated:NO completion:nil];
        }
    });
}

- (void)viewDidDisappear:(BOOL)animated
{
    [super viewDidDisappear:animated];
    self.hasAppeared = NO;
    if (self.isBeingDismissed || self.presentingViewController == nil)
        [NSNotificationCenter.defaultCenter postNotificationName:PAKitPageDidDismissNotification object:self];
}

- (WKWebView *)firstWebViewInView:(UIView *)view
{
    if ([view isKindOfClass:WKWebView.class])
        return (WKWebView *)view;
    for (UIView *subview in view.subviews)
    {
        WKWebView *webView = [self firstWebViewInView:subview];
        if (webView != nil)
            return webView;
    }
    return nil;
}

- (void)observeInitialWebViewIfNeeded
{
    if (self.pageRevealed || self.observedWebView != nil)
        return;
    WKWebView *webView = [self firstWebViewInView:self.contentController.view];
    if (webView == nil)
        return;

    // Only observe public WebKit state. Leave the vendor's navigation delegate,
    // JavaScript bridge and web view configuration untouched.
    self.observedWebView = webView;
    for (NSString *key in @[@"loading", @"estimatedProgress", @"URL"])
        [webView addObserver:self forKeyPath:key options:NSKeyValueObservingOptionInitial | NSKeyValueObservingOptionNew
                    context:&PAKitInitialWebLoadContext];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                      change:(NSDictionary<NSKeyValueChangeKey, id> *)change context:(void *)context
{
    if (context != &PAKitInitialWebLoadContext)
    {
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
        return;
    }
    // Initial KVO can run synchronously while observers are being installed.
    // Defer evaluation so observer removal can never interrupt registration.
    __weak PAKitSafeAreaViewController *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf updateInitialPageLoading]; });
}

- (void)updateInitialPageLoading
{
    WKWebView *webView = self.observedWebView;
    if (self.pageRevealed || webView == nil)
        return;
    if (webView.loading || (webView.URL != nil && webView.estimatedProgress > 0.0))
        self.observedPageLoad = YES;
    // A newly constructed WKWebView starts with loading=NO; that is not success.
    // Wait for a completed first document and a visible container, never status=0 alone.
    if (!self.hasAppeared || !self.observedPageLoad || webView.loading ||
        webView.URL == nil || webView.estimatedProgress < 1.0)
        return;

    self.pageRevealed = YES;
    [self stopObservingInitialWebView];
    [self.pageLoadingView removeFromSuperview];
    self.pageLoadingView = nil;
}

- (void)stopObservingInitialWebView
{
    if (self.observedWebView == nil)
        return;
    for (NSString *key in @[@"loading", @"estimatedProgress", @"URL"])
        [self.observedWebView removeObserver:self forKeyPath:key context:&PAKitInitialWebLoadContext];
    self.observedWebView = nil;
}

- (void)dealloc
{
    [self stopObservingInitialWebView];
}

- (BOOL)prefersStatusBarHidden
{
    return NO;
}

- (UIStatusBarStyle)preferredStatusBarStyle
{
    return UIStatusBarStyleLightContent;
}

- (UIInterfaceOrientationMask)supportedInterfaceOrientations
{
    return self.contentController.supportedInterfaceOrientations;
}

- (UIInterfaceOrientation)preferredInterfaceOrientationForPresentation
{
    return self.contentController.preferredInterfaceOrientationForPresentation;
}

- (BOOL)shouldAutorotate
{
    return self.contentController.shouldAutorotate;
}

@end
