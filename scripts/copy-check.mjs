#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const banned = ['Layer 4', 'Layer 3', 'Layer 2', 'Layer 1', 'P5', 'P4', 'P3', 'P2', 'P1'];
let failed = false;
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) {
      const text = fs.readFileSync(full, 'utf8');
      for (const term of banned) {
        // word-boundary-ish check
        if (text.includes(term)) {
          // allow in copy.ts? no; report
          console.error(`Banned term "${term}" found in ${path.relative(root, full)}`);
          failed = true;
        }
      }
    }
  }
}
walk(path.join(root, 'src/renderer'));
if (failed) process.exit(1);
console.log('Copy check PASS.');
process.exit(0);
