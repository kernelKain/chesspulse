// What: rejects model-written numbers absent from structured, locally computed statistics.
// Why: PGN text is untrusted and cannot be allowed to forge a computed-data marker.
// Removed: injected PGN numbers, leading-dot decimals, and rounded large integers could pass as grounded.
const NUMBER = /(?<![\d.])[-+]?(?:\d[\d,]*(?:\.\d*)?|\.\d[\d,]*)(?:[eE][-+]?\d+)?/g;
const VALID_COMMA_NUMBER = /^[-+]?(?:\d+(?:,\d{3})*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const UNICODE_NEGATIVE_NUMBER = /[\u2212\uFE63\uFF0D]\s*\p{Nd}/u;

/**
 * A fixed, deliberately narrow list. It catches diagnostic vocabulary and direct claims about the
 * player's mind or body; it does not try to police tone, and measured pulse language stays allowed.
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bdiagnos(?:e|ed|es|ing|is|tic)\b/i,
  /\b(?:medical|clinical|clinically)\b/i,
  /\b(?:disorder|syndrome|disease|illness|symptom|symptoms)\b/i,
  /\b(?:therapy|treatment|medication|medications|prescription|prescriptions)\b/i,
  /\b(?:hypertension|arrhythmia|cardiac|cardiovascular)\b/i,
  /\b(?:heart rate|heart disease|blood pressure|stress response)\b/i,
  /\b(?:cortisol|adrenaline|adrenal|fight or flight)\b/i,
  /\b(?:diabetes|diabetic|cancer|asthma|epilepsy|migraine|stroke|infection)\b/i,
  /\bmental health\b/i,
  /\b(?:anxiety|anxious|depression|depressed|panic attack|ptsd|adhd|autism)\b/i,
  /\byou(?:['’]re| are) (?:anxious|nervous|stressed|panicked|panicking|afraid|scared|angry|frustrated|upset|overwhelmed|tilted|calm|relaxed|focused|distracted|tired|exhausted)\b/i,
  /\byou (?:seem|look|appear|sound|remain|stay) (?:anxious|nervous|stressed|panicked|overwhelmed|tilted|calm|relaxed|focused|distracted|tired|exhausted)\b/i,
  /\byou (?:were|felt|seemed|looked|appeared|got|became|stayed|remained|sounded) (?:anxious|nervous|stressed|panicked|panicking|afraid|scared|angry|frustrated|upset|overwhelmed|tilted|calm|relaxed|focused|distracted|tired|exhausted)\b/i,
  /\byou (?:must|might|may) have (?:been|felt) (?:anxious|nervous|stressed|panicked|overwhelmed|tilted|calm|relaxed)\b/i,
  /\byou (?:were|felt|seemed|looked|appeared) (?:in|under) (?:stress|pressure|distress)\b/i,
  /\byou (?:panicked|tilted|choked|froze)\b/i,
  /\byour (?:anxiety|stress|nerves|emotions|emotional state|mental state|physical state|mood|frame of mind|brain|body|nervous system)\b/i,
  /\b(?:felt|feeling) (?:anxious|nervous|stressed|panicked|overwhelmed|tilted)\b/i,
];

export class GroundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroundingError';
  }
}

export function groundInsight(stats: unknown, output: string): string {
  assertSupportedNotation(output);
  assertNoClaims(output);
  for (const match of output.matchAll(NUMBER)) {
    const token = withoutSentencePunctuation(match[0]);
    if (token.includes(',') && !VALID_COMMA_NUMBER.test(token)) {
      throw new GroundingError(`The AI response contained a malformed number: ${match[0]}. Nothing in the report changed.`);
    }
  }
  const serialized = JSON.stringify(stats, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)) ?? '';
  const allowed = new Set([...serialized.matchAll(NUMBER)].map((match) => canonicalDecimal(withoutSentencePunctuation(match[0]))));
  for (const match of output.matchAll(NUMBER)) {
    const token = withoutSentencePunctuation(match[0]);
    if (!allowed.has(canonicalDecimal(token))) {
      throw new GroundingError(`The AI response introduced a number that is not in the session data: ${token}. Nothing in the report changed.`);
    }
  }
  return output;
}

function assertSupportedNotation(text: string): void {
  const unicodeNegative = text.match(UNICODE_NEGATIVE_NUMBER);
  const unicodeDigit = [...text].find((character) => /\p{Nd}/u.test(character) && !/[0-9]/.test(character));
  const unsupported = unicodeNegative?.[0] ?? unicodeDigit;
  if (unsupported) {
    throw new GroundingError(`The AI response used unsupported numeric notation: ${unsupported}. Nothing in the report changed.`);
  }
}

function assertNoClaims(text: string): void {
  for (const pattern of CLAIM_PATTERNS) {
    if (pattern.test(text)) {
      throw new GroundingError('The AI response made a diagnostic or mental-state claim. Nothing in the report changed.');
    }
  }
}

function withoutSentencePunctuation(token: string): string {
  return token.replace(/[.,]+$/, '');
}

/** Canonical sign/significant-digits/exponent comparison avoids IEEE-754 rounding. */
function canonicalDecimal(token: string): string {
  let text = token.replaceAll(',', '');
  let sign = '';
  if (text.startsWith('+') || text.startsWith('-')) {
    sign = text[0] === '-' ? '-' : '';
    text = text.slice(1);
  }
  const [mantissa, exponentText] = text.split(/[eE]/);
  const dot = mantissa.indexOf('.');
  const fractionDigits = dot < 0 ? 0 : mantissa.length - dot - 1;
  let digits = mantissa.replace('.', '').replace(/^0+/, '');
  if (!digits) return '0';
  const trailingZeros = digits.match(/0+$/)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailingZeros);
  const scale = BigInt(exponentText ?? '0') - BigInt(fractionDigits) + BigInt(trailingZeros);
  return `${sign}${digits}e${scale.toString()}`;
}
