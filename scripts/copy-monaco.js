// Copy node_modules/monaco-editor/min/vs/ → src/public/monaco/vs/
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const SRC = 'node_modules/monaco-editor/min/vs';
const DEST = 'src/public/monaco/vs';

if (!existsSync(SRC)) {
  console.error('monaco-editor not found in node_modules. Run: npm install');
  process.exit(1);
}

if (existsSync(DEST)) rmSync(DEST, { recursive: true });
mkdirSync('src/public/monaco', { recursive: true });
cpSync(SRC, DEST, { recursive: true });
console.log('Monaco editor copied to src/public/monaco/vs/');
