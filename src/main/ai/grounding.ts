// What: rejects model-written numbers absent from structured, locally computed statistics.
// Why: PGN text is untrusted and cannot be allowed to forge a computed-data marker.
// Removed: injected PGN numbers, leading-dot decimals, and rounded large integers could pass as grounded.
const NUMBER = /(?<![\d.])[-+]?(?:\d[\d,]*(?:\.\d*)?|\.\d[\d,]*)(?:[eE][-+]?\d+)?/g;
/**
 * A whole chess move token such as `e4`, `Rc8`, `exd5`, `Nbd7`, or `e8=Q+`. Its digits name squares,
 * not quantities, so the token is removed before numbers are checked, in the output and in the stats.
 * Squares come from PGN text, so counting them would let untrusted input widen the allowlist.
 * The token must stand alone: `1e8` or `abc5` is not a move, and its digits stay checked. Sentence
 * punctuation may follow (`Rc8.`), but a decimal may not (`e4.5` stays a number).
 */
const MOVE_TOKEN = /(?<![A-Za-z0-9])(?:[KQRBN][a-h]?[1-8]?x?|[a-h]x)?[a-h][1-8](?:=[QRBN])?[+#]?(?![A-Za-z0-9]|[.,]\d)/g;
const VALID_COMMA_NUMBER = /^[-+]?(?:\d+(?:,\d{3})*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const UNICODE_NEGATIVE_NUMBER = /[\u2212\uFE63\uFF0D]\s*\p{Nd}/u;

/** Degree words between the verb and the state adjective must not hide a direct claim. */
const DEGREE = String.raw`(?:(?:very|really|so|quite|extremely|incredibly|completely|totally|rather|pretty|somewhat|slightly|a little|a bit|kind of|sort of)\s+)?`;
const STATE = String.raw`(?:anxious|nervous|stressed|panicked|panicking|afraid|scared|angry|frustrated|upset|overwhelmed|tilted|calm|relaxed|focused|distracted|tired|exhausted)`;
/** Markdown emphasis around a state adjective must not hide the claim. */
const EMPHASIS = String.raw`(?:\*{1,3}|_{1,3}|~{2})?`;

/**
 * A fixed, deliberately narrow list. It catches diagnostic vocabulary and direct claims about the
 * player's mind or body; it does not try to police tone, and measured pulse language stays allowed.
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bdiagnos(?:e|ed|es|ing|is|tic)\b/i,
  /\b(?:medical|clinical|clinically)\b/i,
  /\b(?:disorder|syndrome|disease|illness|symptom|symptoms)\b/i,
  /\b(?:therapy|treatment|medication|medications|prescription|prescriptions)\b/i,
  /\b(?:hypertens(?:ion|ive)|arrhythmi(?:a|c)|cardiac|cardiovascular)\b/i,
  /\b(?:heart disease|blood pressure|stress response)\b/i,
  /\b(?:cortisol|adrenaline|adrenal|fight or flight)\b/i,
  /\b(?:diabetes|diabetic|cancer|asthma|epilepsy|migraine|stroke|infection|insomnia|fatigue|burnout|exhaustion|dehydration|concussion|dementia|alzheimer'?s|parkinson'?s|thyroid|hormonal|inflammation|nausea|headache|ulcer|fever|chronic pain)\b/i,
  /\bmental health\b/i,
  /\byou (?:have|had|suffer from|are suffering from|were suffering from|have been diagnosed with|were diagnosed with|are being treated for|are dealing with)\b[^.!?\n]{0,60}\b(?:condition|disorder|disease|syndrome|illness|insomnia|fatigue|burnout|exhaustion|dehydration|concussion|dementia|parkinson'?s|alzheimer'?s|thyroid|inflammation|nausea|headache|ulcer|fever|pain)\b/i,
  /\b(?:anxiety|anxious|depression|depressed|panic attack|ptsd|adhd|autism)\b/i,
  new RegExp(String.raw`\byou(?:['’]re| are) ${DEGREE}${EMPHASIS}\s*${STATE}\b${EMPHASIS}`, 'i'),
  new RegExp(String.raw`\byou (?:seem|look|appear|sound|remain|stay) ${DEGREE}${EMPHASIS}\s*${STATE}\b${EMPHASIS}`, 'i'),
  new RegExp(String.raw`\byou (?:were|felt|seemed|looked|appeared|got|became|stayed|remained|sounded|feel|feels) ${DEGREE}${EMPHASIS}\s*${STATE}\b${EMPHASIS}`, 'i'),
  /\byou (?:must|might|may) have (?:been|felt) (?:anxious|nervous|stressed|panicked|overwhelmed|tilted|calm|relaxed)\b/i,
  /\byou (?:were|felt|seemed|looked|appeared) (?:in|under) (?:stress|pressure|distress)\b/i,
  /\byou (?:panicked|tilted|choked|froze)\b/i,
  /\byour (?:anxiety|stress|nerves|emotions|emotional state|mental state|physical state|mood|frame of mind|brain|body|nervous system)\b/i,
  new RegExp(String.raw`\b(?:felt|feeling) ${DEGREE}${EMPHASIS}\s*${STATE}\b${EMPHASIS}`, 'i'),
];

export class GroundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroundingError';
  }
}

/**
 * `names` are player names the stats carry (the scoped player). Their digits are part of a name, not a
 * quantity: they neither widen the allowlist nor need allowing when the reading names the player.
 */
export function groundInsight(stats: unknown, output: string, names: readonly string[] = []): string {
  assertSupportedNotation(output);
  assertNoClaims(output);
  const quantities = withoutNames(output, names).replace(MOVE_TOKEN, ' ');
  for (const match of quantities.matchAll(NUMBER)) {
    const token = withoutSentencePunctuation(match[0]);
    if (token.includes(',') && !VALID_COMMA_NUMBER.test(token)) {
      throw new GroundingError(`The AI response contained a malformed number: ${match[0]}. Nothing in the report changed.`);
    }
  }
  const serialized = withoutNames(
    JSON.stringify(stats, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)) ?? '',
    names,
  ).replace(MOVE_TOKEN, ' ');
  const allowed = new Set([...serialized.matchAll(NUMBER)].map((match) => canonicalDecimal(withoutSentencePunctuation(match[0]))));
  for (const match of quantities.matchAll(NUMBER)) {
    const token = withoutSentencePunctuation(match[0]);
    if (!allowed.has(canonicalDecimal(token))) {
      throw new GroundingError(`The AI response introduced a number that is not in the session data: ${token}. Nothing in the report changed.`);
    }
  }
  return output;
}

/** Replaces each whole, case-insensitive occurrence of a name with a space. */
function withoutNames(text: string, names: readonly string[]): string {
  let result = text;
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'gi'), ' ');
  }
  return result;
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
  // Newlines and tabs are word separators in prose. Detect claims across them while returning the
  // original text unchanged from groundInsight.
  const normalized = text.replace(/\s+/g, ' ');
  for (const pattern of CLAIM_PATTERNS) {
    if (pattern.test(normalized)) {
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
