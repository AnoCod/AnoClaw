/**
 * Installation Script for Computer Use Skill
 * 
 * This script helps install dependencies and set up the skill.
 * Run with: node scripts/install.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('=== Computer Use Skill Installer ===\n');

// Check if we're in the right directory
const currentDir = process.cwd();
const skillDir = path.basename(currentDir);

if (skillDir !== 'computer-use') {
  console.log('Please run this script from the computer-use skill directory:');
  console.log('cd .qoder/skills/computer-use');
  console.log('node scripts/install.js\n');
  process.exit(1);
}

// Check Node.js version
console.log('1. Checking Node.js version...');
try {
  const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
  const versionNumber = parseInt(nodeVersion.replace('v', '').split('.')[0]);
  
  if (versionNumber < 16) {
    console.log('   ✗ Node.js 16 or higher is required');
    console.log('   Current version:', nodeVersion);
    console.log('   Please update Node.js: https://nodejs.org/\n');
    process.exit(1);
  }
  
  console.log('   ✓ Node.js version:', nodeVersion, '\n');
} catch (error) {
  console.log('   ✗ Could not check Node.js version');
  console.log('   Please ensure Node.js is installed\n');
  process.exit(1);
}

// Check package.json
console.log('2. Checking package.json...');
if (!fs.existsSync('package.json')) {
  console.log('   ✗ package.json not found\n');
  process.exit(1);
}
console.log('   ✓ package.json found\n');

// Install dependencies
console.log('3. Installing dependencies...');
try {
  console.log('   Running npm install...');
  execSync('npm install', { stdio: 'inherit' });
  console.log('   ✓ Dependencies installed successfully\n');
} catch (error) {
  console.log('   ✗ Failed to install dependencies');
  console.log('   Error:', error.message);
  console.log('\n   Try running manually:');
  console.log('   npm install\n');
  process.exit(1);
}

// Verify installation
console.log('4. Verifying installation...');
const requiredModules = ['nut-js', 'sharp', 'tesseract.js'];
let allInstalled = true;

for (const module of requiredModules) {
  try {
    require.resolve(module);
    console.log(`   ✓ ${module} installed`);
  } catch (error) {
    console.log(`   ✗ ${module} not found`);
    allInstalled = false;
  }
}

if (!allInstalled) {
  console.log('\n   Some modules may not be installed correctly');
  console.log('   Try running: npm install --force\n');
}

// Create screenshots directory
console.log('\n5. Creating screenshots directory...');
const screenshotsDir = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  console.log('   ✓ Created screenshots directory\n');
} else {
  console.log('   ✓ Screenshots directory exists\n');
}

// Final message
console.log('=== Installation Complete! ===\n');
console.log('You can now use the Computer Use skill.');
console.log('\nQuick start:');
console.log('  node examples/basic-test.js  # Run basic test');
console.log('  node examples/demo.js        # Run full demo');
console.log('\nFor documentation, see:');
console.log('  SKILL.md       # Main skill documentation');
console.log('  reference.md   # API reference');
console.log('  examples.md    # More examples');
console.log('\nHappy automating! 🖱️ ⌨️\n');
