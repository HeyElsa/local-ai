// Hides personal details from cloud models. A detail is swapped for a placeholder
// before sending and put back in the answer, so only this computer sees the real value.

function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Order matters: long, specific patterns run first so a shorter one cannot take part of a match.
const PATTERNS = [
  ['KEY', /\b(?:sk|pk|rk|mr-live|mr-test|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza|glpat)[-_][A-Za-z0-9_-]{12,}\b|\bAKIA[A-Z0-9]{16}\b|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g],
  ['EMAIL', /\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
  ['IBAN', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g],
  ['CARD', /\b\d(?:[ -]?\d){12,18}\b/g, (m) => passesLuhn(m.replace(/\D/g, ''))],
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['PHONE', /(?<![\w+])\+\d{1,3}[\s.-]?\(?\d[\d\s().-]{6,}\d\b|(?<![\w.-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g],
];

const LABELS = { KEY: 'key', EMAIL: 'email address', IBAN: 'bank account', CARD: 'card number', SSN: 'ID number', PHONE: 'phone number' };

// `masks` maps each real value to its placeholder and is kept with the chat, so a
// detail keeps the same placeholder for the whole conversation.
export function maskText(text, masks) {
  if (!text) return text;
  let out = text;
  // Values seen earlier in the chat may appear in a form the patterns would not catch again.
  for (const [value, token] of Object.entries(masks)) out = out.split(value).join(token);
  for (const [type, pattern, accept] of PATTERNS) {
    out = out.replace(pattern, (match) => {
      if (accept && !accept(match)) return match;
      // The same new detail twice in one message keeps one placeholder.
      if (masks[match]) return masks[match];
      const used = Object.values(masks).filter((t) => t.startsWith(`[${type} `)).length;
      const token = `[${type} ${used + 1}]`;
      masks[match] = token;
      return token;
    });
  }
  return out;
}

// Where a link points: [text](here), [text](<here>), <https://here> and "[name]: here" lines.
const LINK_TARGET = /\]\(\s*<[^>\n]*>[^)\n]*\)|\]\([^)\n]*\)|<[a-z][a-z0-9+.-]*:[^>\n]*>|^[ \t]*\[[^\]\n]+\]:.*$/gim;
// Email and phone links open your own mail or phone app, so they send nothing to a website.
const HARMLESS_TARGET = /^(\]\(\s*<?|<|[ \t]*\[[^\]\n]+\]:\s*<?)\s*(mailto|tel):/i;

// Details are put back in what you read, but never inside a web address: a model that was
// tricked could otherwise write a link that hands your details to a website when you click it.
export function unmaskText(text, masks) {
  if (!text || !masks) return text;
  const restore = (part) => {
    let out = part;
    for (const [value, token] of Object.entries(masks)) out = out.split(token).join(value);
    return out;
  };
  let out = '';
  let at = 0;
  for (const m of text.matchAll(LINK_TARGET)) {
    out += restore(text.slice(at, m.index)) + (HARMLESS_TARGET.test(m[0]) ? restore(m[0]) : m[0]);
    at = m.index + m[0].length;
  }
  return out + restore(text.slice(at));
}

// Words for what was hidden in one message, such as "1 email address and 2 phone numbers".
export function describeHidden(text) {
  const counts = {};
  for (const m of (text || '').matchAll(/\[([A-Z]+) \d+\]/g)) {
    if (LABELS[m[1]]) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([type, n]) => {
    const label = LABELS[type];
    return `${n} ${label}${n === 1 ? '' : label.endsWith('s') ? 'es' : 's'}`;
  });
  if (parts.length < 2) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
