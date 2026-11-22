// What: fails when an internal label or a competing term reaches the page copy.
// Why: W5/S56 removed phase/“Layer” language and kept one term per concept; a test keeps it out.
// Removed: the next screen could reintroduce "Layer 4" or call the game a "match".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BANNED_TERMS = ['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'P1', 'P2', 'P3', 'P4', 'P5'];

/** Words that compete with the product's chosen terms. Checked against the copy module only. */
export const COMPETING_TERMS = ['heart rate', 'HRV', 'match'];

function walk(directory, extensions, found) {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) walk(full, extensions, found);
    else if (extensions.some((extension) => full.endsWith(extension))) found.push(full);
  }
}

export function findBannedTerms(root) {
  const files = [];
  walk(path.join(root, 'src', 'renderer'), ['.ts', '.tsx'], files);
  const hits = [];
  for (const file of files.filter((candidate) => !candidate.includes('.test.'))) {
    const text = readFileSync(file, 'utf8');
    for (const term of BANNED_TERMS) {
      if (text.includes(term)) hits.push(`${path.relative(root, file)}: ${term}`);
    }
  }
  return hits;
}

export function findCompetingTerms(root) {
  const copyFiles = [
    path.join(root, 'src', 'renderer', 'copy.ts'),
    path.join(root, 'src', 'shared', 'onboarding.ts'),
    path.join(root, 'src', 'shared', 'errors.ts'),
    path.join(root, 'src', 'shared', 'sensing.ts'),
    path.join(root, 'src', 'shared', 'setup.ts'),
    path.join(root, 'src', 'shared', 'session-list.ts'),
    path.join(root, 'src', 'shared', 'flow.ts'),
    path.join(root, 'src', 'shared', 'timeline.ts'),
    path.join(root, 'src', 'main', 'analysis', 'paste.ts'),
    path.join(root, 'src', 'main', 'session-stop.ts'),
  ];
  const hits = [];
  for (const file of copyFiles) {
    const text = stringLiterals(readFileSync(file, 'utf8')).toLowerCase();
    for (const term of COMPETING_TERMS) {
      const pattern = new RegExp(`\\b${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (pattern.test(text)) hits.push(`${path.relative(root, file)}: ${term}`);
    }
  }
  return hits;
}

/** Comments and code identifiers are not copy; only quoted/template contents are scanned. */
function stringLiterals(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  return [...withoutComments.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)]
    .map((match) => match[2])
    .join('\n');
}

export function runCopyCheck(root) {
  const banned = findBannedTerms(root);
  const competing = findCompetingTerms(root);
  if (banned.length > 0) {
    console.error('Banned internal terms found:');
    for (const hit of banned) console.error(`  ${hit}`);
  }
  if (competing.length > 0) {
    console.error('Competing terms found in copy:');
    for (const hit of competing) console.error(`  ${hit}`);
  }
  if (banned.length === 0 && competing.length === 0) console.log('Copy check PASS.');
  return banned.length === 0 && competing.length === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(import.meta.dirname, '..');
  process.exit(runCopyCheck(root) ? 0 : 1);
}
