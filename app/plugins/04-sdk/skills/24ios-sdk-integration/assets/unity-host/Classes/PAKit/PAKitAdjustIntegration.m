#import "PAKitAdjustIntegration.h"
#import <AdjustSdk/AdjustSdk.h>
#import <math.h>

NSNotificationName const PAKitAdjustDidTrackEventNotification = @"PAKitAdjustDidTrackEventNotification";

static NSDictionary<NSString *, NSString *> *PAKitAdjustEventTokens(void)
{
    return @{
__ADJUST_EVENT_MAP__
    };
}

static BOOL PAKitPaymentExplicitlyFailed(id value)
{
    if ([value isKindOfClass:NSNumber.class])
        return ![value boolValue];
    if ([value isKindOfClass:NSString.class])
    {
        NSString *normalized = [[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] lowercaseString];
        return [@[@"0", @"false", @"no"] containsObject:normalized];
    }
    return NO;
}

static BOOL PAKitRevenue(id amount, id currencyValue, double *revenue, NSString **currency)
{
    if (![currencyValue isKindOfClass:NSString.class])
        return NO;
    NSString *code = [[currencyValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] uppercaseString];
    if (code.length != 3 || [code rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ"].invertedSet].location != NSNotFound)
        return NO;

    double value = 0;
    if ([amount isKindOfClass:NSNumber.class])
    {
        if (CFGetTypeID((__bridge CFTypeRef)amount) == CFBooleanGetTypeID())
            return NO;
        value = [amount doubleValue];
    }
    else if ([amount isKindOfClass:NSString.class])
    {
        NSScanner *scanner = [NSScanner scannerWithString:amount];
        scanner.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
        if (![scanner scanDouble:&value])
            return NO;
        [scanner scanCharactersFromSet:NSCharacterSet.whitespaceAndNewlineCharacterSet intoString:NULL];
        if (!scanner.isAtEnd)
            return NO;
    }
    else
        return NO;

    if (!isfinite(value) || value <= 0)
        return NO;
    *revenue = value;
    *currency = code;
    return YES;
}

@interface PAKitAdjustIntegration () <AdjustDelegate>
@end

@implementation PAKitAdjustIntegration

+ (instancetype)sharedIntegration
{
    static PAKitAdjustIntegration *integration;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ integration = [self new]; });
    return integration;
}

+ (void)startIfNeeded
{
    NSAssert(NSThread.isMainThread, @"Initialize Adjust on the main thread after ATT.");
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        ADJConfig *config = [[ADJConfig alloc] initWithAppToken:@"__ADJUST_APP_TOKEN__"
                                                 environment:__ADJUST_ENVIRONMENT__];
        config.logLevel = ADJLogLevelWarn;
        config.delegate = [self sharedIntegration];
        [Adjust initSdk:config];
    });
}

+ (void)trackEvent:(NSString *)eventName parameters:(NSDictionary *)parameters
{
    NSAssert(NSThread.isMainThread, @"Track Adjust events on the main thread.");
    if (![eventName isKindOfClass:NSString.class])
        return;
    NSString *token = PAKitAdjustEventTokens()[eventName];
    if (token == nil)
        return;
    NSDictionary *params = [parameters isKindOfClass:NSDictionary.class] ? parameters : @{};
    BOOL firstRecharge = [eventName isEqualToString:@"firstrecharge"];
    // A callback explicitly marked unsuccessful must not count as a first payment.
    // When success is absent, the business event name remains authoritative.
    if (firstRecharge && PAKitPaymentExplicitlyFailed(params[@"success"]))
        return;

    [self startIfNeeded];
    ADJEvent *event = [[ADJEvent alloc] initWithEventToken:token];
    [event addCallbackParameter:@"pa_event" value:eventName];
    if (firstRecharge)
    {
        double revenue;
        NSString *currency;
        // The bridge amount is in currency units, not cents. Invalid or absent
        // revenue fields still permit the event; they do not fabricate revenue.
        if (PAKitRevenue(params[@"amount"], params[@"currency"], &revenue, &currency))
            [event setRevenue:revenue currency:currency];
    }
    [Adjust trackEvent:event];
}

- (void)adjustEventTrackingSucceeded:(ADJEventSuccess *)response
{
    [self publishResultForToken:response.eventToken success:YES willRetry:NO];
}

- (void)adjustEventTrackingFailed:(ADJEventFailure *)response
{
    [self publishResultForToken:response.eventToken success:NO willRetry:response.willRetry];
}

- (void)publishResultForToken:(NSString *)token success:(BOOL)success willRetry:(BOOL)willRetry
{
    NSMutableDictionary *result = [@{@"success": @(success)} mutableCopy];
    if (token.length > 0)
    {
        result[@"eventToken"] = token;
        NSString *eventName = [[PAKitAdjustEventTokens() allKeysForObject:token] firstObject];
        if (eventName != nil)
            result[@"eventName"] = eventName;
    }
    if (!success)
        result[@"willRetry"] = @(willRetry);
    // Adjust owns its retry queue. Reporting the result must not re-submit the
    // event or send an undocumented acknowledgement to the WebView.
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSNotificationCenter.defaultCenter postNotificationName:PAKitAdjustDidTrackEventNotification
                                                          object:nil
                                                        userInfo:result];
    });
}

@end
