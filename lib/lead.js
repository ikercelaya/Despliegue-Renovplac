const { extractSpanishPhone } = require("./phone");

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const NAME_INTRO = /\b(?:me llamo|mi nombre es|soy)\s+([^.,;!?]{2,80})/i;
const ASKED_NAME = /\b(c[oó]mo te llamas|nombre|datos personales|datos de contacto|localice|localizarte|a qui[eé]n pregunto)\b/i;
const ASKED_LOCATION = /\b(c[oó]digo postal|cp|ubicaci[oó]n|zona|localidad|d[oó]nde)\b/i;
const CONTACT_FIELD_REGEX = /\b(tel(?:[eé]fono)?|movil|m[oó]vil|whatsapp|email|e-mail|correo(?:\s+electr[oó]nico)?)\b/i;
const NAME_FIELD_REGEX = /\b(nombre(?:\s+completo)?|me llamo|mi nombre es|soy)\b/i;
const OWNER_PERMISSION_REGEX = /\b(propietar|due[nÃ±]|duen|permiso|autoriz|titular|vivienda|casa|piso|local)\b/i;

const WORK_TYPES = [
  ["Reforma integral", /reforma integral|casa completa|vivienda completa|piso completo/i],
  ["Baño completo", /ba[nñ]o|aseo|ducha|plato de ducha|sanitario|sanitarios|mampara|inodoro|lavabo|alicatad|azulej|fontaner[ií]a|desag[uü]e/i],
  ["Cocina", /cocina/i],
  ["Piscina", /piscina|depuradora|gresite/i],
  ["Terraza", /terraza|patio/i],
  ["Fachada", /fachada|monocapa/i],
  ["Pladur", /pladur|falso techo|trasdosado|tabique/i],
  ["Suelo o pavimento", /suelo|pavimento|porcel[aá]nico|solado/i],
  ["Pintura", /pintar|pintura/i],
  ["Muro", /muro|valla|cerramiento/i],
  ["Local comercial", /local/i],
  ["Comunidad", /comunidad|propietarios/i],
];

const WORK_TYPE_PRIORITY = new Map([
  ["Reforma integral", 100],
  ["Baño completo", 90],
  ["Cocina", 85],
  ["Piscina", 85],
  ["Local comercial", 80],
  ["Pladur", 70],
  ["Fachada", 65],
  ["Terraza", 60],
  ["Muro", 55],
  ["Suelo o pavimento", 50],
  ["Comunidad", 45],
  ["Pintura", 20],
]);

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isLikelyInvalidCustomerName(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;

  const normalized = stripAccents(raw);
  const words = normalized.split(/\s+/).filter(Boolean);

  if (raw.length < 2 || raw.length > 70) return true;
  if (words.length > 5) return true;
  if (/\d|@|https?:\/\//i.test(raw)) return true;
  if (/^de\b/i.test(normalized)) return true;
  if (OWNER_PERMISSION_REGEX.test(normalized)) return true;
  if (/^(acepto|si|sí|no|hola|buenas|gracias|ok|vale|perfecto|genial)$/i.test(raw)) return true;
  if (/\b(si|vale|ok|correcto|perfecto|genial|claro|todo|incluido|incluida|de acuerdo)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(bano|cocina|piscina|reforma|presupuesto|completo|ducha|mampara|sanitario|sanitarios|alicatado|solado|fontaneria|electricidad|materiales?|acabados?|calidades?)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(quiero|necesito|tengo|tenemos|tiene|incluye|incluir|incluimos|confirmo|seria|sería|plazo|urgencia|metros?|m2|semanas?|manana|mañana|tarde|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|para|por|con|sin|tambien|también|y)\b/i.test(normalized)) {
    return true;
  }
  return false;
}

function normalizeWorkType(value) {
  const workType = String(value || "").trim();
  if (!workType) return null;
  const normalized = stripAccents(workType);
  if (/^bano completo$/i.test(normalized)) return "Baño completo";
  if (/^reforma integral$/i.test(normalized)) return "Reforma integral";
  const known = WORK_TYPES.find(([label]) => stripAccents(label) === normalized);
  if (known) return known[0];
  return workType;
}

function getWorkTypePriority(value) {
  const normalized = normalizeWorkType(value);
  return normalized ? (WORK_TYPE_PRIORITY.get(normalized) || 0) : 0;
}

function shouldReplaceWorkType(current, next) {
  const normalizedNext = normalizeWorkType(next);
  if (!normalizedNext) return false;
  const normalizedCurrent = normalizeWorkType(current);
  if (!normalizedCurrent) return true;
  if (normalizedCurrent === normalizedNext) return false;
  return getWorkTypePriority(normalizedNext) > getWorkTypePriority(normalizedCurrent);
}

function cleanName(value) {
  const name = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[:\-\s]+|[:\-\s]+$/g, "")
    .trim();

  if (isLikelyInvalidCustomerName(name)) return null;
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

function botAskedForContactData(messages) {
  if (!Array.isArray(messages)) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const text = lastAssistant?.content || "";
  return ASKED_NAME.test(text) && CONTACT_FIELD_REGEX.test(text);
}

function botAskedForLocation(messages) {
  if (!Array.isArray(messages)) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return ASKED_LOCATION.test(lastAssistant?.content || "");
}

function botAskedForOwnerPermission(messages) {
  if (!Array.isArray(messages)) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return OWNER_PERMISSION_REGEX.test(lastAssistant?.content || "");
}

function removeContactDetails(value) {
  return String(value || "")
    .replace(EMAIL_REGEX, " ")
    .replace(/(?:\+34\s*)?(?:\d[\s.-]*){9,}/g, " ")
    .replace(/\b(?:mi\s+)?(?:nombre(?:\s+completo)?|tel(?:[eé]fono)?|movil|m[oó]vil|whatsapp|email|e-mail|correo(?:\s+electr[oó]nico)?)\s*(?:es|:|-)?/gi, " ")
    .replace(/[,:;|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLabeledName(text) {
  if (!NAME_FIELD_REGEX.test(text)) return null;
  const match = /\b(?:nombre(?:\s+completo)?|me llamo|mi nombre es|soy)\s*(?:es|:|-)?\s*([^,;\n]{2,120})/i.exec(text);
  if (!match) return null;
  return cleanName(removeContactDetails(match[1]));
}

function extractName(message, messages) {
  const text = String(message || "").trim();
  if (botAskedForOwnerPermission(messages)) return null;

  const intro = NAME_INTRO.exec(text);
  if (intro) return cleanName(removeContactDetails(intro[1]));

  const labeledName = extractLabeledName(text);
  if (labeledName) return labeledName;

  if (botAskedForName(messages)) {
    const candidate = removeContactDetails(text);
    if (botAskedForContactData(messages) && !candidate && (extractEmail(text) || extractSpanishPhone(text))) {
      return null;
    }
    return cleanName(candidate || text);
  }

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
  const currentNameIsInvalid = isLikelyInvalidCustomerName(conv.customer_name);

  if (currentNameIsInvalid) patch.customer_name = null;

  const name = (!conv.customer_name || currentNameIsInvalid) ? extractName(message, messages) : null;
  const email = !conv.customer_email ? extractEmail(message) : null;
  const phone = !conv.customer_phone ? extractSpanishPhone(message) : null;
  const postalCode = !conv.customer_postal_code ? extractPostalCode(message, messages) : null;
  const workType = inferWorkType(message);

  if (name) patch.customer_name = name;
  if (email) patch.customer_email = email;
  if (phone) patch.customer_phone = phone;
  if (postalCode) patch.customer_postal_code = postalCode;
  if (workType && shouldReplaceWorkType(conv.work_type, workType)) {
    patch.work_type = normalizeWorkType(workType);
  }
  return patch;
}

function buildLeadPatchFromMessages(conv, messages) {
  const patch = {};
  const working = { ...conv };
  const seen = [];

  if (isLikelyInvalidCustomerName(working.customer_name)) {
    patch.customer_name = null;
    working.customer_name = null;
  }

  const normalizedWorkType = normalizeWorkType(working.work_type);
  if (working.work_type && normalizedWorkType !== working.work_type) {
    patch.work_type = normalizedWorkType;
    working.work_type = normalizedWorkType;
  }

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

module.exports = {
  buildLeadPatch,
  buildLeadPatchFromMessages,
  isLikelyInvalidCustomerName,
  normalizeWorkType,
};
