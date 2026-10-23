// "numero" y "WhatsApp" solos no cuentan: pueden ser el numero de la calle o la ubicacion de WhatsApp.
const PHONE_KEYWORDS = /\b(tel[eé]fono|m[oó]vil|n[uú]mero (?:de )?(?:tel[eé]fono|m[oó]vil|contacto|whats(?:app)?)|mi whats(?:app)? es|ll[aá]mame|llamarme)\b/i;
const PHONE_REQUEST_REGEX = /\b(tel[eé]fono|m[oó]vil|n[uú]mero (?:de )?(?:tel[eé]fono|m[oó]vil|contacto|whats(?:app)?))\b/i;
// Direcciones: calle, codigo postal seguido del pueblo, portal, piso...
const ADDRESS_HINT = /\b(calle|carrer|c\/|avda|avenida|av\.|plaza|pza|pla[cç]a|camino|cam[ií]|partida|urbanizaci[oó]n|urb\.|pol[ií]gono|portal|piso|puerta)\b|\b\d{5}\s+[a-zà-ÿ]/i;
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
  if (ADDRESS_HINT.test(raw) && !hasCountryPrefix && !hasPhoneKeyword) {
    return { attempted: false, valid: false, normalized: null };
  }
  const mostlyPhoneChars = /^[+\d\s().-]+$/.test(raw);
  const plausiblePhoneLength = digits.length >= 9 && digits.length <= 12;

  const attempted =
    hasCountryPrefix ||
    (hasPhoneKeyword && digits.length > 0) ||
    (mostlyPhoneChars && plausiblePhoneLength);

  return { attempted, valid: false, normalized: null };
}

// Respuesta que solo puede ser un telefono: cifras, espacios, + y guiones (al menos 4 cifras).
function looksLikeBarePhoneAttempt(value) {
  const raw = String(value || "").trim();
  return /^[+\d\s().-]+$/.test(raw) && raw.replace(/\D/g, "").length >= 4;
}

module.exports = {
  INVALID_PHONE_REPLY,
  PHONE_REQUEST_REGEX,
  extractSpanishPhone,
  getPhoneSubmissionStatus,
  looksLikeBarePhoneAttempt,
  normalizeSpanishPhone,
};
