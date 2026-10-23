#import <AppKit/AppKit.h>

// Public AppKit geometry, in logical points (not Retina pixels). No camera,
// screen recording, Accessibility permissions, or private APIs are involved.
int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSMutableArray *displays = [NSMutableArray array];
    if (@available(macOS 12.0, *)) {
      for (NSScreen *screen in NSScreen.screens) {
        CGFloat height = screen.safeAreaInsets.top;
        NSRect left = screen.auxiliaryTopLeftArea;
        NSRect right = screen.auxiliaryTopRightArea;
        CGFloat width = NSMinX(right) - NSMaxX(left);
        if (height <= 0 || NSIsEmptyRect(left) || NSIsEmptyRect(right) || width <= 0) continue;
        [displays addObject:@{
          @"id": screen.deviceDescription[@"NSScreenNumber"],
          @"width": @(width),
          @"height": @(height),
          @"centerX": @((NSMaxX(left) + NSMinX(right)) / 2 - NSMinX(screen.frame))
        }];
      }
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:displays options:0 error:nil];
    if (!data) return 1;
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
  }
  return 0;
}
