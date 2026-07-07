---
name: computer-use
description: "Control local desktop apps through Computer Use. Use for tasks that require reading or operating app UI by clicking, typing, scrolling, dragging, pressing keys, or setting values. Covers mouse control, keyboard input, screen capture, window management, and automation scripting. Always use BrowserAgent for browser operations."
---

# Computer Use Skill

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

## Overview

This skill enables AI agents to control Windows desktop applications through simulated mouse and keyboard operations. Use this for automating UI interactions, reading screen content, and performing desktop tasks.

**IMPORTANT**: This skill is for desktop applications only. For browser automation, use the BrowserAgent instead.

---

## Quick Start

### Prerequisites

```bash
# Install required packages
npm install nut-js @nut-tree/nut-js
npm install tesseract.js  # For OCR
npm install sharp  # For image processing
```

### Basic Usage

```javascript
const { mouse, keyboard, screen } = require('nut-js');

// Click at coordinates
await mouse.setPosition(new Point(100, 200));
await mouse.leftClick();

// Type text
await keyboard.type('Hello World');

// Press key combination
await keyboard.pressKey(Key.LeftControl, Key.C);
```

---

## Mouse Control

### Click Operations

```javascript
// Left click
await mouse.leftClick();

// Right click
await mouse.rightClick();

// Double click
await mouse.leftClick();
await sleep(50);
await mouse.leftClick();

// Click with modifiers
await keyboard.pressKey(Key.LeftShift);
await mouse.leftClick();
await keyboard.releaseKey(Key.LeftShift);
```

### Movement

```javascript
// Move to absolute position
await mouse.setPosition(new Point(x, y));

// Move relative to current position
await mouse.move(new Point(dx, dy));

// Smooth movement (human-like)
for (let i = 0; i <= steps; i++) {
  await mouse.setPosition(new Point(startX + (endX - startX) * i / steps, 
                                     startY + (endY - startY) * i / steps));
  await sleep(10);
}
```

### Drag and Drop

```javascript
// Drag from point A to point B
await mouse.setPosition(new Point(startX, startY));
await mouse.leftButtonDown();
await sleep(100);
await mouse.setPosition(new Point(endX, endY));
await mouse.leftButtonUp();
```

### Scroll

```javascript
// Scroll up
await mouse.scrollUp(3);

// Scroll down
await mouse.scrollDown(3);
```

---

## Keyboard Control

### Text Input

```javascript
// Type a string
await keyboard.type('Hello World');

// Type with delay between characters
for (const char of 'Slow typing') {
  await keyboard.type(char);
  await sleep(50);
}
```

### Key Press

```javascript
// Press single key
await keyboard.pressKey(Key.Enter);

// Press and release
await keyboard.pressKey(Key.A);
await keyboard.releaseKey(Key.A);

// Key combinations
await keyboard.pressKey(Key.LeftControl, Key.C);  // Ctrl+C
await keyboard.pressKey(Key.LeftAlt, Key.F4);     // Alt+F4
await keyboard.pressKey(Key.LeftWindows, Key.D);  // Win+D
```

### Special Keys

Common key constants (nut-js Key enum):
- `Key.Enter` - Enter/Return
- `Key.Tab` - Tab
- `Key.Escape` - Escape
- `Key.Backspace` - Backspace
- `Key.Delete` - Delete
- `Key.Up`, `Key.Down`, `Key.Left`, `Key.Right` - Arrow keys
- `Key.F1` - `Key.F12` - Function keys
- `Key.LeftControl`, `Key.LeftShift`, `Key.LeftAlt`, `Key.LeftSuper` - Modifiers

---

## Screen Operations

### Screenshot

```javascript
const { screen } = require('nut-js');

// Capture full screen
const screenshot = await screen.capture();

// Capture specific region
const region = await screen.captureRegion(x, y, width, height);

// Save to file
const sharp = require('sharp');
await sharp(screenshot.rawData, { 
  raw: { width: screenshot.width, height: screenshot.height, channels: 4 }
}).toFile('screenshot.png');
```

### OCR (Text Recognition)

```javascript
const Tesseract = require('tesseract.js');

async function ocrScreen(x, y, width, height) {
  const region = await screen.captureRegion(x, y, width, height);
  const imageData = await sharp(region.rawData, {
    raw: { width: region.width, height: region.height, channels: 4 }
  }).png().toBuffer();
  
  const { data: { text } } = await Tesseract.recognize(imageData, 'eng');
  return text;
}
```

### Color Detection

```javascript
// Get pixel color at position
const color = await screen.getColorAt(new Point(x, y));
// Returns { r: 255, g: 0, b: 0 }
```

---

## Window Management

### Find Windows

```javascript
const { Window } = require('nut-js');

// Find window by title
const windows = await Window.list();
const targetWindow = windows.find(w => w.title.includes('Notepad'));

// Focus window
await targetWindow.focus();

// Get window bounds
const bounds = await targetWindow.getBounds();
```

### Window Operations

```javascript
// Move window
await targetWindow.setPosition(new Point(100, 100));

// Resize window
await targetWindow.setSize(new Size(800, 600));

// Maximize/Minimize
await targetWindow.maximize();
await targetWindow.minimize();

// Close window
await targetWindow.close();
```

---

## Utility Functions

### Sleep/Delay

```javascript
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Wait for UI element
await sleep(500);
```

### Wait for Image on Screen

```javascript
async function waitForImage(templatePath, timeout = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const screenshot = await screen.capture();
    // Implement template matching here
    const found = await matchTemplate(screenshot, templatePath);
    if (found) return found;
    await sleep(100);
  }
  throw new Error('Image not found within timeout');
}
```

### Coordinate Helpers

```javascript
// Get screen center
const screenWidth = await screen.width();
const screenHeight = await screen.height();
const centerX = screenWidth / 2;
const centerY = screenHeight / 2;

// Relative to active window
const activeWindow = await Window.getActive();
const bounds = await activeWindow.getBounds();
```

---

## Automation Patterns

### Sequential Actions

```javascript
async function automateWorkflow() {
  // Step 1: Open application
  await keyboard.pressKey(Key.LeftWindows);
  await sleep(500);
  await keyboard.type('notepad');
  await keyboard.pressKey(Key.Enter);
  await sleep(1000);
  
  // Step 2: Type content
  await keyboard.type('Hello from AI Agent!');
  
  // Step 3: Save file
  await keyboard.pressKey(Key.LeftControl, Key.S);
  await sleep(500);
  await keyboard.type('test.txt');
  await keyboard.pressKey(Key.Enter);
}
```

### Conditional Logic

```javascript
async function smartAction() {
  const color = await screen.getColorAt(new Point(100, 100));
  
  if (color.r > 200 && color.g < 50) {
    // Red button detected - click it
    await mouse.setPosition(new Point(100, 100));
    await mouse.leftClick();
  } else {
    // Different state - wait
    await sleep(1000);
  }
}
```

### Error Recovery

```javascript
async function robustAction() {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await performAction();
      return true;
    } catch (error) {
      console.log(`Attempt ${i + 1} failed: ${error.message}`);
      await sleep(1000);
      // Try to recover - press Escape, close dialogs, etc.
      await keyboard.pressKey(Key.Escape);
    }
  }
  throw new Error('Action failed after max retries');
}
```

---

## Example Scripts

### Open Notepad and Type

```javascript
const { mouse, keyboard, Key } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  // Open Start Menu
  await keyboard.pressKey(Key.LeftWindows);
  await sleep(500);
  
  // Search for Notepad
  await keyboard.type('notepad');
  await sleep(300);
  await keyboard.pressKey(Key.Enter);
  await sleep(1000);
  
  // Type in Notepad
  await keyboard.type('Hello from Computer Use Skill!');
  await sleep(500);
  
  // Save with Ctrl+S
  await keyboard.pressKey(Key.LeftControl, Key.S);
  await sleep(500);
}

main().catch(console.error);
```

### Take Screenshot and OCR

```javascript
const { screen, Point } = require('nut-js');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

async function captureAndRead() {
  // Capture screen
  const screenshot = await screen.capture();
  
  // Save image
  await sharp(screenshot.rawData, {
    raw: { width: screenshot.width, height: screenshot.height, channels: 4 }
  }).png().toFile('capture.png');
  
  // OCR specific region (top-left 200x100)
  const region = await screen.captureRegion(0, 0, 200, 100);
  const buffer = await sharp(region.rawData, {
    raw: { width: region.width, height: region.height, channels: 4 }
  }).png().toBuffer();
  
  const { data: { text } } = await Tesseract.recognize(buffer, 'eng');
  console.log('Recognized text:', text);
  
  return text;
}

captureAndRead().catch(console.error);
```

---

## Safety Guidelines

1. **Always verify coordinates** before clicking - wrong coordinates can cause unintended actions
2. **Add delays** between actions to allow UI to respond (200-500ms typical)
3. **Use screenshots** to verify current state before critical operations
4. **Implement timeouts** to prevent infinite waits
5. **Handle errors gracefully** - don't leave mouse button pressed or keys held
6. **Test on non-production** systems first
7. **Avoid sensitive operations** (like file deletion) without explicit confirmation

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| Mouse not moving | Check if another app has input lock |
| Keys not registering | Ensure target window has focus |
| Screenshot fails | Run with appropriate permissions |
| OCR inaccurate | Improve lighting, use higher resolution |

### Debug Mode

```javascript
// Enable verbose logging
process.env.DEBUG = 'nut-js:*';

// Log all actions
const originalSetPosition = mouse.setPosition.bind(mouse);
mouse.setPosition = async (point) => {
  console.log(`Mouse moving to: ${point.x}, ${point.y}`);
  return originalSetPosition(point);
};
```

---

## Additional Resources

- For detailed API documentation, see [reference.md](reference.md)
- For more examples, see [examples.md](examples.md)
- nut-js documentation: https://nutjs.dev/
