# Computer Use - Usage Examples

## Basic Examples

### Example 1: Open Calculator and Calculate

```javascript
const { keyboard, mouse, Key, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function openCalculatorAndCalculate() {
  // Open Calculator
  await keyboard.pressKey(Key.LeftWindows);
  await sleep(500);
  await keyboard.type('calculator');
  await sleep(300);
  await keyboard.pressKey(Key.Enter);
  await sleep(1000);
  
  // Calculate 15 * 27
  await keyboard.type('15');
  await keyboard.pressKey(Key.Multiply);  // * key
  await keyboard.type('27');
  await keyboard.pressKey(Key.Enter);
  
  // Wait for result
  await sleep(500);
  
  // Take screenshot to capture result
  const { screen } = require('nut-js');
  const result = await screen.capture();
  console.log('Calculation complete!');
}

openCalculatorAndCalculate().catch(console.error);
```

### Example 2: Automated File Operations

```javascript
const { keyboard, Key } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function createAndSaveFile() {
  // Open Notepad
  await keyboard.pressKey(Key.LeftWindows);
  await sleep(500);
  await keyboard.type('notepad');
  await sleep(300);
  await keyboard.pressKey(Key.Enter);
  await sleep(1000);
  
  // Type content
  await keyboard.type('This is an automated file creation.\n');
  await sleep(200);
  await keyboard.type('Created by AI Agent using Computer Use skill.\n');
  await sleep(200);
  await keyboard.type('Date: ' + new Date().toLocaleDateString());
  
  // Save file (Ctrl+S)
  await keyboard.pressKey(Key.LeftControl, Key.S);
  await sleep(500);
  
  // Enter filename
  await keyboard.type('auto-created-file.txt');
  await sleep(200);
  await keyboard.pressKey(Key.Enter);
  await sleep(300);
  
  // Handle "Save As" dialog if it appears
  await keyboard.pressKey(Key.Enter);
  await sleep(500);
  
  console.log('File created successfully!');
}

createAndSaveFile().catch(console.error);
```

---

## Intermediate Examples

### Example 3: Screenshot and OCR

```javascript
const { screen, Point } = require('nut-js');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const fs = require('fs').promises;

async function captureAndRecognizeText() {
  // Capture full screen
  const screenshot = await screen.capture();
  
  // Save full screenshot
  await sharp(screenshot.rawData, {
    raw: { 
      width: screenshot.width, 
      height: screenshot.height, 
      channels: 4 
    }
  }).png().toFile('full-screenshot.png');
  
  console.log('Full screenshot saved');
  
  // Capture and OCR specific region (top-left 400x200)
  const region = await screen.captureRegion(0, 0, 400, 200);
  
  // Save region
  await sharp(region.rawData, {
    raw: { 
      width: region.width, 
      height: region.height, 
      channels: 4 
    }
  }).png().toFile('region-screenshot.png');
  
  // OCR the region
  const buffer = await sharp(region.rawData, {
    raw: { 
      width: region.width, 
      height: region.height, 
      channels: 4 
    }
  }).png().toBuffer();
  
  const { data: { text } } = await Tesseract.recognize(buffer, 'eng');
  
  console.log('Recognized text:');
  console.log(text);
  
  return text;
}

captureAndRecognizeText().catch(console.error);
```

### Example 4: Window Management

```javascript
const { Window, mouse, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function manageWindows() {
  // List all windows
  const windows = await Window.list();
  
  console.log('Open windows:');
  for (const win of windows) {
    const bounds = await win.getBounds();
    console.log(`- ${win.title} (${bounds.width}x${bounds.height})`);
  }
  
  // Find Notepad window
  const notepad = windows.find(w => w.title.includes('Notepad'));
  
  if (notepad) {
    // Bring to front and focus
    await notepad.bringToFront();
    await notepad.focus();
    
    // Move window
    await notepad.setPosition(new Point(100, 100));
    
    // Resize window
    await notepad.setSize({ width: 800, height: 600 });
    
    console.log('Notepad window managed!');
  } else {
    console.log('Notepad not found');
  }
}

manageWindows().catch(console.error);
```

### Example 5: Wait for UI Element

```javascript
const { screen, mouse, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForElementAndClick(templatePath, options = {}) {
  const { 
    timeout = 10000, 
    confidence = 0.8,
    clickOffset = { x: 0, y: 0 }
  } = options;
  
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const location = await screen.findOnScreen(templatePath, { confidence });
      
      // Element found, click it
      await mouse.setPosition(new Point(
        location.x + clickOffset.x,
        location.y + clickOffset.y
      ));
      await sleep(100);
      await mouse.leftClick();
      
      console.log(`Clicked element at (${location.x}, ${location.y})`);
      return location;
    } catch (e) {
      // Element not found yet, wait and try again
      await sleep(500);
    }
  }
  
  throw new Error(`Element not found within ${timeout}ms`);
}

// Usage
waitForElementAndClick('./assets/submit-button.png')
  .then(() => console.log('Button clicked!'))
  .catch(console.error);
```

---

## Advanced Examples

### Example 6: Form Filling Automation

```javascript
const { keyboard, mouse, Key, Point, Window } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class FormFiller {
  constructor() {
    this.fieldDelay = 100;
  }
  
  async clickField(x, y) {
    await mouse.setPosition(new Point(x, y));
    await sleep(100);
    await mouse.leftClick();
    await sleep(this.fieldDelay);
    
    // Select all existing text
    await keyboard.pressKey(Key.LeftControl, Key.A);
    await sleep(50);
  }
  
  async fillTextField(x, y, value) {
    await this.clickField(x, y);
    await keyboard.type(value);
  }
  
  async fillPasswordField(x, y, value) {
    await this.clickField(x, y);
    await keyboard.type(value);
  }
  
  async selectDropdown(x, y, optionText) {
    await this.clickField(x, y);
    await sleep(200);
    await keyboard.type(optionText);
    await sleep(100);
    await keyboard.pressKey(Key.Enter);
  }
  
  async submitForm(submitButtonX, submitButtonY) {
    await mouse.setPosition(new Point(submitButtonX, submitButtonY));
    await sleep(100);
    await mouse.leftClick();
  }
}

async function fillRegistrationForm() {
  const form = new FormFiller();
  
  // Assume form fields are at these coordinates
  // (In real use, you'd detect these dynamically)
  await form.fillTextField(300, 200, 'John Doe');
  await form.fillTextField(300, 250, 'john@example.com');
  await form.fillPasswordField(300, 300, 'securePassword123');
  await form.selectDropdown(300, 350, 'United States');
  await form.fillTextField(300, 400, '123 Main Street');
  
  // Submit
  await form.submitForm(300, 450);
  
  console.log('Form submitted!');
}

fillRegistrationForm().catch(console.error);
```

### Example 7: Automated Testing

```javascript
const { keyboard, mouse, screen, Key, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class AutomatedTester {
  constructor() {
    this.results = [];
  }
  
  async assertTextExists(expectedText, region) {
    const { data: { text } } = await Tesseract.recognize(
      await screen.captureRegion(region.x, region.y, region.width, region.height),
      'eng'
    );
    
    const passed = text.includes(expectedText);
    this.results.push({
      test: `Text "${expectedText}" exists`,
      passed,
      actual: text
    });
    
    return passed;
  }
  
  async assertColorAt(expectedColor, x, y, tolerance = 30) {
    const actualColor = await screen.getColorAt(new Point(x, y));
    const passed = 
      Math.abs(actualColor.r - expectedColor.r) < tolerance &&
      Math.abs(actualColor.g - expectedColor.g) < tolerance &&
      Math.abs(actualColor.b - expectedColor.b) < tolerance;
    
    this.results.push({
      test: `Color at (${x},${y})`,
      passed,
      expected: expectedColor,
      actual: actualColor
    });
    
    return passed;
  }
  
  async clickAndVerify(x, y, expectedChange, timeout = 5000) {
    // Capture state before click
    const before = await screen.capture();
    
    // Click
    await mouse.setPosition(new Point(x, y));
    await sleep(100);
    await mouse.leftClick();
    
    // Wait for change
    await sleep(500);
    
    // Capture state after
    const after = await screen.capture();
    
    // Compare (simplified - real implementation would use template matching)
    const passed = !this.imagesEqual(before, after);
    
    this.results.push({
      test: `Click at (${x},${y}) causes change`,
      passed
    });
    
    return passed;
  }
  
  imagesEqual(img1, img2) {
    // Simplified comparison
    return img1.width === img2.width && img1.height === img2.height;
  }
  
  generateReport() {
    const passed = this.results.filter(r => r.passed).length;
    const total = this.results.length;
    
    return {
      summary: `${passed}/${total} tests passed`,
      details: this.results
    };
  }
}

// Usage
async function runTests() {
  const tester = new AutomatedTester();
  
  await tester.assertTextExists('Welcome', { x: 0, y: 0, width: 400, height: 100 });
  await tester.assertColorAt({ r: 0, g: 120, b: 215 }, 50, 50);
  await tester.clickAndVerify(200, 300, 'button_clicked');
  
  const report = tester.generateReport();
  console.log(report.summary);
  console.log(JSON.stringify(report.details, null, 2));
}

runTests().catch(console.error);
```

### Example 8: Desktop Automation Script Recorder

```javascript
const { keyboard, mouse, screen, Key, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fs = require('fs').promises;

class ActionRecorder {
  constructor() {
    this.actions = [];
    this.recording = false;
    this.startTime = null;
  }
  
  startRecording() {
    this.recording = true;
    this.actions = [];
    this.startTime = Date.now();
    console.log('Recording started...');
  }
  
  stopRecording() {
    this.recording = false;
    console.log(`Recording stopped. ${this.actions.length} actions captured.`);
    return this.actions;
  }
  
  recordAction(type, params) {
    if (!this.recording) return;
    
    this.actions.push({
      type,
      params,
      timestamp: Date.now() - this.startTime
    });
  }
  
  async saveRecording(filename) {
    const script = this.generateScript();
    await fs.writeFile(filename, script);
    console.log(`Recording saved to ${filename}`);
  }
  
  generateScript() {
    let script = `const { keyboard, mouse, Key, Point } = require('nut-js');\n`;
    script += `const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));\n\n`;
    script += `async function replay() {\n`;
    
    let lastTimestamp = 0;
    for (const action of this.actions) {
      const delay = action.timestamp - lastTimestamp;
      if (delay > 0) {
        script += `  await sleep(${delay});\n`;
      }
      
      switch (action.type) {
        case 'click':
          script += `  await mouse.setPosition(new Point(${action.params.x}, ${action.params.y}));\n`;
          script += `  await mouse.leftClick();\n`;
          break;
        case 'type':
          script += `  await keyboard.type('${action.params.text.replace(/'/g, "\\'")}');\n`;
          break;
        case 'keypress':
          script += `  await keyboard.pressKey(${action.params.keys.join(', ')});\n`;
          break;
      }
      
      lastTimestamp = action.timestamp;
    }
    
    script += `}\n\nreplay().catch(console.error);`;
    return script;
  }
}

// Example usage with event listeners
const recorder = new ActionRecorder();

// In real implementation, you'd hook into system events
// This is a simplified simulation
async function simulateRecording() {
  recorder.startRecording();
  
  // Simulate some actions
  await sleep(100);
  recorder.recordAction('click', { x: 100, y: 200 });
  
  await sleep(500);
  recorder.recordAction('type', { text: 'Hello World' });
  
  await sleep(200);
  recorder.recordAction('keypress', { keys: ['Key.Enter'] });
  
  recorder.stopRecording();
  await recorder.saveRecording('recorded-action.js');
}

simulateRecording().catch(console.error);
```

---

## Real-World Use Cases

### Use Case 1: Application Installer Automation

```javascript
const { keyboard, mouse, Key, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function automateInstaller() {
  // Wait for installer to load
  await sleep(2000);
  
  // Click "Next" button (assuming bottom-right)
  await mouse.setPosition(new Point(700, 500));
  await sleep(100);
  await mouse.leftClick();
  await sleep(1000);
  
  // Accept license agreement checkbox
  await mouse.setPosition(new Point(250, 350));
  await sleep(100);
  await mouse.leftClick();
  await sleep(500);
  
  // Click "Next"
  await mouse.setPosition(new Point(700, 500));
  await sleep(100);
  await mouse.leftClick();
  await sleep(1000);
  
  // Choose installation directory (keep default)
  await mouse.setPosition(new Point(700, 500));
  await sleep(100);
  await mouse.leftClick();
  await sleep(1000);
  
  // Start installation
  await mouse.setPosition(new Point(700, 500));
  await sleep(100);
  await mouse.leftClick();
  
  // Wait for installation to complete
  await sleep(10000);
  
  // Finish
  await mouse.setPosition(new Point(700, 500));
  await sleep(100);
  await mouse.leftClick();
  
  console.log('Installation automated!');
}
```

### Use Case 2: Data Entry from Spreadsheet

```javascript
const { keyboard, Key } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const data = [
  { name: 'John', email: 'john@example.com', phone: '555-0101' },
  { name: 'Jane', email: 'jane@example.com', phone: '555-0102' },
  { name: 'Bob', email: 'bob@example.com', phone: '555-0103' },
];

async function enterData(record, fieldPositions) {
  // Name field
  await mouse.setPosition(fieldPositions.name);
  await sleep(100);
  await mouse.leftClick();
  await keyboard.type(record.name);
  
  // Tab to next field
  await keyboard.pressKey(Key.Tab);
  await sleep(100);
  
  // Email field
  await keyboard.type(record.email);
  
  // Tab to next field
  await keyboard.pressKey(Key.Tab);
  await sleep(100);
  
  // Phone field
  await keyboard.type(record.phone);
  
  // Submit (Enter)
  await keyboard.pressKey(Key.Enter);
  await sleep(500);
}

async function bulkDataEntry() {
  const fieldPositions = {
    name: { x: 300, y: 200 },
    email: { x: 300, y: 250 },
    phone: { x: 300, y: 300 },
  };
  
  for (const record of data) {
    await enterData(record, fieldPositions);
    console.log(`Entered: ${record.name}`);
  }
  
  console.log('All data entered!');
}

bulkDataEntry().catch(console.error);
```

### Use Case 3: Automated Report Generation

```javascript
const { keyboard, mouse, screen, Key, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const sharp = require('sharp');

async function generateReport() {
  // Open reporting application
  await keyboard.pressKey(Key.LeftWindows);
  await sleep(500);
  await keyboard.type('report software');
  await sleep(300);
  await keyboard.pressKey(Key.Enter);
  await sleep(2000);
  
  // Select date range
  await mouse.setPosition(new Point(300, 150));
  await sleep(100);
  await mouse.leftClick();
  await keyboard.type('01/01/2026');
  
  await mouse.setPosition(new Point(450, 150));
  await sleep(100);
  await mouse.leftClick();
  await keyboard.type('12/31/2026');
  
  // Generate report
  await mouse.setPosition(new Point(500, 300));
  await sleep(100);
  await mouse.leftClick();
  await sleep(3000);
  
  // Capture report screenshot
  const screenshot = await screen.capture();
  const reportImage = await sharp(screenshot.rawData, {
    raw: { 
      width: screenshot.width, 
      height: screenshot.height, 
      channels: 4 
    }
  }).png().toBuffer();
  
  await sharp(reportImage).toFile(`report-${Date.now()}.png`);
  
  // Export to PDF if available
  await keyboard.pressKey(Key.LeftControl, Key.P);  // Print dialog
  await sleep(1000);
  
  // Select PDF printer (if available)
  // This would need to be customized based on your system
  
  console.log('Report generated!');
}

generateReport().catch(console.error);
```

---

## Tips for Effective Automation

1. **Always add delays** - UI needs time to respond
2. **Verify before acting** - Take screenshots to confirm state
3. **Handle errors** - Add retry logic for flaky operations
4. **Use unique selectors** - Don't rely on absolute coordinates when possible
5. **Test incrementally** - Verify each step works before combining
6. **Log actions** - Help debug when things go wrong
7. **Keep scripts modular** - Break complex automations into functions
8. **Use constants** - Define coordinates and timeouts as named values
