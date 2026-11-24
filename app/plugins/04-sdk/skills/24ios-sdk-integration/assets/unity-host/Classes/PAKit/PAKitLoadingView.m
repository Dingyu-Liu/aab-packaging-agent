#import "PAKitLoadingView.h"

@implementation PAKitLoadingView

- (instancetype)initWithFrame:(CGRect)frame
{
    self = [super initWithFrame:frame];
    if (self)
    {
        self.backgroundColor = UIColor.blackColor;
        self.opaque = YES;
        self.contentMode = UIViewContentModeRedraw;
        self.userInteractionEnabled = YES;
        self.accessibilityViewIsModal = YES;
        self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;

        UILabel *label = [UILabel new];
        label.text = @"Loading…";
        label.textColor = UIColor.whiteColor;
        label.font = [UIFont systemFontOfSize:26.0 weight:UIFontWeightSemibold];
        label.textAlignment = NSTextAlignmentCenter;
        label.numberOfLines = 0;
        label.accessibilityIdentifier = @"PAKitLoadingTitle";
        label.translatesAutoresizingMaskIntoConstraints = NO;
        [self addSubview:label];
        [NSLayoutConstraint activateConstraints:@[
            [label.centerXAnchor constraintEqualToAnchor:self.centerXAnchor],
            [label.centerYAnchor constraintEqualToAnchor:self.centerYAnchor],
            [label.widthAnchor constraintLessThanOrEqualToAnchor:self.widthAnchor constant:-48.0],
        ]];
    }
    return self;
}

- (void)drawRect:(CGRect)rect
{
    // Draw opaque black pixels as well as setting backgroundColor. The loading
    // screen must keep its own content when the render surface is initialized.
    CGContextRef context = UIGraphicsGetCurrentContext();
    if (context == NULL)
        return;
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextSetRGBFillColor(context, 0.0, 0.0, 0.0, 1.0);
    CGContextFillRect(context, self.bounds);
}

@end
