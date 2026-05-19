const { extractSpanishPhone } = require("./phone");

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const NAME_INTRO = /\b(?:me llamo|mi nombre es|soy)\s+([^.,;!?]{2,80})/i;
const ASKED_NAME = /\b(c[oó]mo te llamas|nombre|localice|localizarte|a qui[eé]n pregunto)\b/i;
const ASKED_LOCATION = /\b(c[oó]digo postal|cp|ubicaci[oó]n|zona|localidad|d[oó]nde)\b/i;

const WORK_TYPES = [
  ["reforma integral", /reforma integral|casa completa|vivienda completa/i],
  ["Bano completo", /ba[nñ]o|ducha|sanitario|mampara/i],
  ["Cocina", /cocina/i],
  ["Piscina", /piscina|depuradora|gresite/i],
  ["Terraza", /terraza|patio/i],
  ["Fachada", /fachada|monocapa/i],
  ["Pladur", /pladur|falso techo|trasdosado|tabique/i],
  ["Pintura", /pintar|pintura/i],
  ["Suelo o pavimento", /suelo|pavimento|porcel[aá]nico|solado/i],
  ["Muro", /muro|valla|cerramiento/i],
  ["Local comercial", /local/i],
  ["Comunidad", /comunidad|propietarios/i],
];

function cleanName(value) {
  const name = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[:\-–—\s]+|[:\-–—\s]+$/g, "")
    .trim();

  if (name.length < 2 || name.length > 70) return null;
  if (/\d|@|https?:\/\//i.test(name)) return null;
  if (/^(acepto|si|s[ií]|no|hola|buenas|gracias)$/i.test(name)) return null;
  if (!/^[a-zA-ZÀ-ÿ' -]+$/.test(name)) return null;
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function botAskedForName(messages) {
  if (!Array.isArray(messages)) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return ASKED_NAME.test(lastAssistant?.content || "");
}

function botAskedForLocation(messages) {
  if (!Array.isArray(messages)) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return ASKED_LOCATION.test(lastAssistant?.content || "");
}

function stripContactData(value) {
  let text = String(value || "");
  const phone = extractSpanishPhone(text);
  if (phone) {
    const phoneDigits = phone.replace(/^\+34/, "");
    const spacedPhone = phoneDigits.split("").join("\\s*");
    text = text.replace(new RegExp(`(?:\\+34\\s*)?${spacedPhone}`, "g"), " ");
  }
  return text
    .replace(EMAIL_REGEX, " ")
    .replace(/\b(nombre|me llamo|tel[eé]fono|m[oó]vil|whats(?:app)?|email|correo)\b\s*(es|:)?/gi, " ")
    .replace(/[,:;|/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractName(message, messages) {
  const text = String(message || "").trim();
  const intro = NAME_INTRO.exec(text);
  if (intro) return cleanName(intro[1]);
  if (botAskedForName(messages)) return cleanName(text) || cleanName(stripContactData(text));
  return null;
}

function extractEmail(message) {
  const match = EMAIL_REGEX.exec(String(message || ""));
  return match ? match[0].toLowerCase() : null;
}

function extractPostalCode(message, messages) {
  const text = String(message || "");
  const match = /(?:^|\D)([0-5]\d{4})(?!\d)/.exec(text);
  if (!match) return null;
  if (/\b(cp|c[oó]digo postal)\b/i.test(text) || botAskedForLocation(messages)) {
    return match[1];
  }
  return null;
}

function inferWorkType(message) {
  const text = String(message || "");
  for (const [label, pattern] of WORK_TYPES) {
    if (pattern.test(text)) return label;
  }
  return null;
}

function buildLeadPatch(conv, message, messages) {
  const patch = {};
  const name = !conv.customer_name ? extractName(message, messages) : null;
  const email = !conv.customer_email ? extractEmail(message) : null;
  const phone = !conv.customer_phone ? extractSpanishPhone(message) : null;
  const postalCode = !conv.customer_postal_code ? extractPostalCode(message, messages) : null;
  const workType = !conv.work_type ? inferWorkType(message) : null;

  if (name) patch.customer_name = name;
  if (email) patch.customer_email = email;
  if (phone) patch.customer_phone = phone;
  if (postalCode) patch.customer_postal_code = postalCode;
  if (workType) patch.work_type = workType;
  return patch;
}

function buildLeadPatchFromMessages(conv, messages) {
  const patch = {};
  const working = { ...conv };
  const seen = [];

  for (const msg of messages || []) {
    if (msg.role === "user") {
      const next = buildLeadPatch(working, msg.content, seen);
      Object.assign(patch, next);
      Object.assign(working, next);
    }
    seen.push(msg);
  }

  return patch;
}

module.exports = { buildLeadPatch, buildLeadPatchFromMessages };
