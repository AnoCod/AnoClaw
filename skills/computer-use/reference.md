# Computer Use - Reference Documentation

## API Reference

### Mouse Class

#### Properties
- `mouse.position` - Current mouse position (Point)
- `mouse.config` - Configuration object

#### Methods

```javascript
// Movement
await mouse.setPosition(point: Point): Promise<void>
await mouse.move(path: Point[]): Promise<void>
await mouse.move(path: Point[], options?: MoveOptions): Promise<void>

// Click
await mouse.leftClick(): Promise<void>
await mouse.rightClick(): Promise<void>
await mouse.scrollUp(amount: number): Promise<void>
await mouse.scrollDown(amount: number): Promise<void>
await mouse.scrollLeft(amount: number): Promise<void>
await mouse.scrollRight(amount: number): Promise<void>

// Button state
await mouse.leftButtonDown(): Promise<void>
await mouse.leftButtonUp(): Promise<void>
await mouse.rightButtonDown(): Promise<void>
await mouse.rightButtonUp(): Promise<void>
await mouse.leftMouseButtonState(): Promise<boolean>
await mouse.rightMouseButtonState(): Promise<boolean>
```

#### MoveOptions
```typescript
interface MoveOptions {
  speed?: number;        // Pixels per second
  ease?: EaseFunction;   // Easing function
  steps?: number;        // Number of intermediate points
}
```

---

### Keyboard Class

#### Methods

```javascript
// Text input
await keyboard.type(text: string): Promise<void>
await keyboard.type(text: string, delay: number): Promise<void>

// Key press
await keyboard.pressKey(...keys: Key[]): Promise<void>
await keyboard.releaseKey(...keys: Key[]): Promise<void>
await keyboard.releaseAllKeys(): Promise<void>

// Get state
await keyboard.getState(): Promise<KeyboardState>
```

#### Key Enum Values

**Letters**
- `Key.A` through `Key.Z`

**Numbers**
- `Key.Num0` through `Key.Num9`
- `Key.Keypad0` through `Key.Keypad9`

**Function Keys**
- `Key.F1` through `Key.F12`
- `Key.F13` through `Key.F24`

**Modifiers**
- `Key.LeftShift`, `Key.RightShift`
- `Key.LeftControl`, `Key.RightControl`
- `Key.LeftAlt`, `Key.RightAlt`
- `Key.LeftSuper`, `Key.RightSuper` (Windows/Command key)

**Navigation**
- `Key.Up`, `Key.Down`, `Key.Left`, `Key.Right`
- `Key.Home`, `Key.End`
- `Key.PageUp`, `Key.PageDown`

**Editing**
- `Key.Enter`, `Key.Return`
- `Key.Tab`
- `Key.Backspace`
- `Key.Delete`
- `Key.Insert`
- `Key.Escape`

**Misc**
- `Key.Space`
- `Key.CapsLock`
- `Key.NumLock`
- `Key.ScrollLock`
- `Key.PrintScreen`
- `Key.Pause`

---

### Screen Class

#### Methods

```javascript
// Capture
await screen.capture(): Promise<ScreenImage>
await screen.captureRegion(x: number, y: number, width: number, height: number): Promise<ScreenImage>
await screen.highlightRegion(x: number, y: number, width: number, height: number): Promise<void>

// Query
await screen.width(): Promise<number>
await screen.height(): Promise<number>
await screen.dpi(): Promise<number>
await screen.captureNumber(): Promise<number>
await screen.findOnScreen(template: Image, options?: FindOnScreenOptions): Promise<Point>
await screen.findAllOnScreen(template: Image, options?: FindOnScreenOptions): Promise<Point[]>

// Color
await screen.getColorAt(point: Point): Promise<Color>
await screen.rgbAt(point: Point): Promise<{r: number, g: number, b: number}>
await screen.rgbaAt(point: Point): Promise<{r: number, g: number, b: number, a: number}>
```

#### ScreenImage Interface
```typescript
interface ScreenImage {
  rawData: Buffer;
  width: number;
  height: number;
  byteWidth: number;
  bitsPerPixel: number;
  bytesPerPixel: number;
}
```

#### FindOnScreenOptions
```typescript
interface FindOnScreenOptions {
  confidence?: number;      // 0-1, similarity threshold
  region?: Region;          // Search within region
  searchRegion?: Region;    // Alternative region specification
  multi?: boolean;          // Find all occurrences
  provider?: string;        // Image matching algorithm
}
```

---

### Window Class

#### Static Methods
```javascript
await Window.list(): Promise<Window[]>
await Window.getActive(): Promise<Window>
await Window.getByTitle(title: string): Promise<Window | null>
await Window.getByProcessName(processName: string): Promise<Window[]>
```

#### Instance Properties
- `window.title` - Window title (string)
- `window.processId` - Process ID (number)
- `window.handle` - Window handle (number)

#### Instance Methods
```javascript
// Focus
await window.focus(): Promise<void>
await window.bringToFront(): Promise<void>
await window.minimize(): Promise<void>
await window.maximize(): Promise<void>
await window.restore(): Promise<void>
await window.close(): Promise<void>

// Position & Size
await window.getPosition(): Promise<Point>
await window.setPosition(point: Point): Promise<void>
await window.getSize(): Promise<Size>
await window.setSize(size: Size): Promise<void>
await window.getBounds(): Promise<Region>
await window.isResizable(): Promise<boolean>
await window.isMinimized(): Promise<boolean>
await window.isMaximized(): Promise<boolean>
await window.isActive(): Promise<boolean>

// State
await window.isWindow(): Promise<boolean>
await window.getNativeHandle(): Promise<number>
```

---

## Advanced Patterns

### Template Matching

```javascript
const { screen, Point, Region } = require('nut-js');
const fs = require('fs');

async function findButton(buttonImagePath, options = {}) {
  const { confidence = 0.8, timeout = 5000 } = options;
  
  const template = fs.readFileSync(buttonImagePath);
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const location = await screen.findOnScreen(template, { confidence });
      return location;
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  throw new Error(`Button not found within ${timeout}ms`);
}

// Usage
const buttonPos = await findButton('./assets/submit-button.png');
await mouse.setPosition(buttonPos);
await mouse.leftClick();
```

### Coordinate System

```javascript
// Screen coordinates
// (0,0) is top-left corner
// x increases to the right
// y increases downward

// Get screen dimensions
const screenWidth = await screen.width();
const screenHeight = await screen.height();

// Calculate relative positions
const centerX = screenWidth / 2;
const bottomCenterY = screenHeight * 0.8;

// Offset from window
async function clickRelativeToWindow(windowTitle, offsetX, offsetY) {
  const window = await Window.getByTitle(windowTitle);
  if (!window) throw new Error(`Window "${windowTitle}" not found`);
  
  await window.focus();
  const bounds = await window.getBounds();
  
  await mouse.setPosition(new Point(
    bounds.x + offsetX,
    bounds.y + offsetY
  ));
  await mouse.leftClick();
}
```

### Image Comparison

```javascript
const sharp = require('sharp');

async function imagesSimilar(img1Buffer, img2Buffer, threshold = 0.95) {
  const img1 = await sharp(img1Buffer).raw().toBuffer();
  const img2 = await sharp(img2Buffer).raw().toBuffer();
  
  let matching = 0;
  const total = img1.length;
  
  for (let i = 0; i < total; i += 4) {  // RGBA
    const diff = Math.abs(img1[i] - img2[i]) + 
                 Math.abs(img1[i+1] - img2[i+1]) + 
                 Math.abs(img1[i+2] - img2[i+2]);
    if (diff < 30) matching++;  // Color tolerance
  }
  
  return (matching / (total / 4)) >= threshold;
}
```

---

## Platform-Specific Notes (Windows)

### Permissions
- Some operations may require Administrator privileges
- UAC prompts may block automation
- Run with appropriate permissions for target applications

### DPI Scaling
```javascript
// Account for Windows DPI scaling
const dpi = await screen.dpi();
const scaleFactor = dpi / 96;  // 96 DPI is 100% scale

// Adjust coordinates
const adjustedX = Math.round(x * scaleFactor);
const adjustedY = Math.round(y * scaleFactor);
```

### Common Windows Shortcuts
```javascript
// System
await keyboard.pressKey(Key.LeftWindows);           // Start Menu
await keyboard.pressKey(Key.LeftWindows, Key.D);    // Show Desktop
await keyboard.pressKey(Key.LeftWindows, Key.L);    // Lock Screen
await keyboard.pressKey(Key.LeftAlt, Key.F4);       // Close Active Window
await keyboard.pressKey(Key.Alt, Key.Tab);          // Switch Windows

// Explorer
await keyboard.pressKey(Key.LeftControl, Key.L);    // Address Bar
await keyboard.pressKey(Key.F5);                     // Refresh
await keyboard.pressKey(Key.LeftAlt, Key.Up);       // Go Up

// Text Editing
await keyboard.pressKey(Key.LeftControl, Key.A);    // Select All
await keyboard.pressKey(Key.LeftControl, Key.C);    // Copy
await keyboard.pressKey(Key.LeftControl, Key.V);    // Paste
await keyboard.pressKey(Key.LeftControl, Key.X);    // Cut
await keyboard.pressKey(Key.LeftControl, Key.Z);    // Undo
await keyboard.pressKey(Key.LeftControl, Key.Y);    // Redo
```

---

## Error Handling

```javascript
const { mouse, keyboard, screen, Window, Key, Point } = require('nut-js');

class ComputerUseError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function safeClick(x, y, options = {}) {
  const { timeout = 1000, retries = 3 } = options;
  
  for (let i = 0; i < retries; i++) {
    try {
      await Promise.race([
        (async () => {
          await mouse.setPosition(new Point(x, y));
          await new Promise(r => setTimeout(r, 100)); // Small delay
          await mouse.leftClick();
        })(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new ComputerUseError(
            'Click timed out', 'TIMEOUT', { x, y }
          )), timeout)
        )
      ]);
      return true;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 500));
    }
  }
}
```

---

## Configuration

### Mouse Configuration
```javascript
mouse.config = {
  ...mouse.config,
  autoDelay: 100,        // Delay between actions (ms)
  mouseSpeed: 1000,      // Movement speed (pixels/sec)
};
```

### Keyboard Configuration
```javascript
keyboard.config = {
  ...keyboard.config,
  delay: 50,             // Delay between keystrokes (ms)
  interval: 30,          // Interval for repeated keys (ms)
};
```

### Screen Configuration
```javascript
screen.config = {
  ...screen.config,
  confidence: 0.8,       // Default confidence for findOnScreen
  resourceDirectory: './assets',  // Default template directory
};
```

---

## Performance Tips

1. **Batch operations** - Group related mouse/keyboard actions
2. **Minimize screenshots** - Cache when possible
3. **Use regions** - Don't capture full screen for small elements
4. **Add appropriate delays** - Too fast = missed UI, too slow = inefficient
5. **Cache window handles** - Reuse when interacting with same window
6. **Profile bottlenecks** - Use console.time/timeEnd

```javascript
console.time('operation');
// ... your code ...
console.timeEnd('operation');
```
