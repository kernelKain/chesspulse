// What: rejects model-written numbers absent from structured, locally computed statistics.
// Why: PGN text is untrusted and cannot be allowed to forge a computed-data marker.
// Removed: injected PGN numbers, leading-dot decimals, and rounded large integers could pass as grounded.
const NUMBER = /(?<![\d.])[-+]?(?:\d[\d,]*(?:\.\d*)?|\.\d[\d,]*)(?:[eE][-+]?\d+)?/g;
const VALID_COMMA_NUMBER = /^[-+]?(?:\d+(?:,\d{3})*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const UNICODE_NEGATIVE_NUMBER = /[\u2212\uFE63\uFF0D]\s*\p{Nd}/u;

export function groundInsight(stats: unknown, output: string): string {
  assertSupportedNotation(output);
  for (const match of output.matchAll(NUMBER)) {
    const token = withoutSentencePunctuation(match[0]);
    if (token.includes(',') && !VALID_COMMA_NUMBER.test(token)) {
      throw new Error(`The AI response contained a malformed number: ${match[0]}. Nothing in the report changed.`);
    }
  }
  const serialized = JSON.stringify(stats, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)) ?? '';
  const allowed = new Set([...serialized.matchAll(NUMBER)].map((match) => canonicalDecimal(withoutSentencePunctuation(match[0]))));
  for (const match of output.matchAll(NUMBER)) {
    const token = withoutSentencePunctuation(match[0]);
    if (!allowed.has(canonicalDecimal(token))) {
      throw new Error(`The AI response introduced a number that is not in the session data: ${token}. Nothing in the report changed.`);
    }
  }
  return output;
}

function assertSupportedNotation(text: string): void {
  const unicodeNegative = text.match(UNICODE_NEGATIVE_NUMBER);
  const unicodeDigit = [...text].find((character) => /\p{Nd}/u.test(character) && !/[0-9]/.test(character));
  const unsupported = unicodeNegative?.[0] ?? unicodeDigit;
  if (unsupported) {
    throw new Error(`The AI response used unsupported numeric notation: ${unsupported}. Nothing in the report changed.`);
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
