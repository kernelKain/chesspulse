#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const tokensCss = fs.readFileSync(path.join(root, 'src/renderer/tokens.css'), 'utf8');
const stylesCss = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');

const tokenMap = new Map();
const rootMatch = tokensCss.match(/:root\s*\{([\s\S]*?)\}/);
if (rootMatch) {
  for (const m of rootMatch[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokenMap.set('--' + m[1], m[2].trim());
  }
}

function resolveColor(value) {
  value = value.trim().replace(/;$/, '');
  const varMatch = value.match(/^var\((--[a-z0-9-]+)\)$/);
  if (varMatch) {
    const resolved = tokenMap.get(varMatch[1]);
    if (resolved) return resolveColor(resolved);
  }
  return value;
}

function hexToRgb(hex) {
  hex = hex.trim();
  if (hex.startsWith('#')) {
    if (hex.length === 4) {
      hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    }
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  return null;
}

function luminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

const pairs = new Map();
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = ruleRe.exec(stylesCss)) !== null) {
  const selector = m[1].trim();
  const block = m[2];
  const colorMatch = block.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
  const bgMatch = block.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/);
  if (colorMatch && bgMatch) {
    const fg = resolveColor(colorMatch[1]);
    const bg = resolveColor(bgMatch[1]);
    const key = fg + '|' + bg;
    if (!pairs.has(key)) pairs.set(key, { fg, bg, selectors: [] });
    pairs.get(key).selectors.push(selector);
  }
}

const curated = [
  ['--text', '--bg'],
  ['--text', '--surface'],
  ['--muted', '--bg'],
  ['--muted', '--surface'],
  ['--accent', '--bg'],
  ['--accent', '--surface'],
  ['--ok', '--bg'],
  ['--ok', '--surface'],
  ['--warn', '--bg'],
  ['--warn', '--surface'],
  ['--danger', '--bg'],
  ['--danger', '--surface'],
  ['--focus', '--bg'],
];
for (const [fgToken, bgToken] of curated) {
  const fg = tokenMap.get(fgToken);
  const bg = tokenMap.get(bgToken);
  if (fg && bg) {
    const key = fg + '|' + bg;
    if (!pairs.has(key)) pairs.set(key, { fg, bg, selectors: ['(token pair)'] });
  }
}

let failed = false;
console.log('ChessPulse contrast check (WCAG 2.2 AA)');
for (const { fg, bg, selectors } of pairs.values()) {
  const fgRgb = hexToRgb(fg);
  const bgRgb = hexToRgb(bg);
  if (!fgRgb || !bgRgb) continue;
  const ratio = contrast(fgRgb, bgRgb);
  const ok = ratio >= 4.5;
  if (!ok) failed = true;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${fg} on ${bg}  ${ratio.toFixed(2)}  ${status}  (${selectors.slice(0, 2).join(', ')})`);
}

if (failed) {
  console.error('\nContrast check FAILED: one or more pairs below 4.5:1.');
  process.exit(1);
}
console.log('\nContrast check PASS.');
process.exit(0);
