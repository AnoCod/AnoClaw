/**
 * Basic Computer Use Test
 * 
 * This script demonstrates basic mouse and keyboard operations.
 * Run with: node examples/basic-test.js
 */

const { mouse, keyboard, screen, Key, Point } = require('nut-js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runBasicTest() {
  console.log('=== Computer Use Basic Test ===\n');
  
  try {
    // Test 1: Get screen dimensions
    console.log('1. Getting screen dimensions...');
    const screenWidth = await screen.width();
    const screenHeight = await screen.height();
    console.log(`   Screen size: ${screenWidth}x${screenHeight}\n`);
    
    // Test 2: Move mouse to center
    console.log('2. Moving mouse to screen center...');
    const centerX = screenWidth / 2;
    const centerY = screenHeight / 2;
    await mouse.setPosition(new Point(centerX, centerY));
    await sleep(500);
    console.log(`   Mouse moved to (${centerX}, ${centerY})\n`);
    
    // Test 3: Get current mouse position
    console.log('3. Getting current mouse position...');
    const currentPosition = await mouse.getPosition();
    console.log(`   Current position: (${currentPosition.x}, ${currentPosition.y})\n`);
    
    // Test 4: Mouse click
    console.log('4. Performing mouse click...');
    await mouse.leftClick();
    await sleep(200);
    console.log('   Left click performed\n');
    
    // Test 5: Keyboard input
    console.log('5. Testing keyboard input...');
    // Open Run dialog (Win+R)
    await keyboard.pressKey(Key.LeftWindows, Key.R);
    await sleep(500);
    console.log('   Opened Run dialog');
    
    // Type a command
    await keyboard.type('notepad');
    await sleep(200);
    console.log('   Typed "notepad"');
    
    // Press Enter
    await keyboard.pressKey(Key.Enter);
    await sleep(1000);
    console.log('   Pressed Enter\n');
    
    // Test 6: Take screenshot
    console.log('6. Taking screenshot...');
    const screenshot = await screen.capture();
    console.log(`   Screenshot captured: ${screenshot.width}x${screenshot.height}\n`);
    
    console.log('=== All tests completed successfully! ===');
    
  } catch (error) {
    console.error('Test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
runBasicTest();
