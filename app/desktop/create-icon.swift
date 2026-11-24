import AppKit
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for (name, size) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let scale = CGFloat(size) / 1024
    let transform = AffineTransform(scale: scale)
    (transform as NSAffineTransform).concat()
    let background = NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 200, yRadius: 200)
    NSColor(calibratedRed: 0.10, green: 0.15, blue: 0.22, alpha: 1).setFill()
    background.fill()
    for rect in [NSRect(x: 245, y: 515, width: 235, height: 235), NSRect(x: 245, y: 245, width: 235, height: 235), NSRect(x: 515, y: 245, width: 235, height: 235)] {
        NSColor.white.setFill()
        NSBezierPath(roundedRect: rect, xRadius: 48, yRadius: 48).fill()
    }
    NSColor(calibratedRed: 0.98, green: 0.68, blue: 0.32, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 515, y: 515, width: 235, height: 235), xRadius: 48, yRadius: 48).fill()
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name + ".png"))
}
