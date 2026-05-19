const PHONE_KEYWORDS = /\b(tel[eé]fono|m[oó]vil|whats(?:app)?|n[uú]mero|contacto|ll[aá]mame|llamarme)\b/i;
const VALID_SPANISH_PHONE = /^(?:\+34)?[6-9]\d{8}$/;

const INVALID_PHONE_REPLY =
  "El teléfono no me queda claro. Pásamelo con 9 cifras, por ejemplo 612 345 678, o con prefijo +34: +34 612 345 678.";

function compactPhone(value) {
  return String(value || "").replace(/\s+/g, "");
}

function normalizeSpanishPhone(value) {
  const raw = String(value || "");
  const compact = compactPhone(raw);
  if (!VALID_SPANISH_PHONE.test(compact)) return null;
  return compact;
}

function extractSpanishPhone(value) {
  const raw = String(value || "");
  const exact = normalizeSpanishPhone(raw);
  if (exact) return exact;

  const candidates = /(^|[^\d+])((?:\+34\s*)?[6-9](?:\s*\d){8})(?!\s*\d)/g;
  let match;
  while ((match = candidates.exec(raw)) !== null) {
    const normalized = normalizeSpanishPhone(match[2]);
    if (normalized) return normalized;
  }
  return null;
}

function getPhoneSubmissionStatus(value) {
  const raw = String(value || "").trim();
  if (!raw) return { attempted: false, valid: false, normalized: null };

  const normalized = extractSpanishPhone(raw);
  if (normalized) return { attempted: true, valid: true, normalized };

  const digits = raw.replace(/\D/g, "");
  const hasCountryPrefix = /\+34/.test(raw);
  const hasPhoneKeyword = PHONE_KEYWORDS.test(raw);
  const mostlyPhoneChars = /^[+\d\s().-]+$/.test(raw);
  const plausiblePhoneLength = digits.length >= 9 && digits.length <= 12;

  const attempted =
    hasCountryPrefix ||
    (hasPhoneKeyword && digits.length > 0) ||
    (mostlyPhoneChars && plausiblePhoneLength);

  return { attempted, valid: false, normalized: null };
}

module.exports = { INVALID_PHONE_REPLY, extractSpanishPhone, getPhoneSubmissionStatus, normalizeSpanishPhone };
