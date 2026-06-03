require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");

const { supabase, SUPABASE_URL } = require("./lib/db");
const { sendEmail } = require("./lib/email");
const { buildSystemPrompt } = require("./lib/prompt");
const { runConversation } = require("./lib/claude");
const { INVALID_PHONE_REPLY, getPhoneSubmissionStatus, normalizeSpanishPhone } = require("./lib/phone");
const {
  buildLeadPatch,
  buildLeadPatchFromMessages,
  isLikelyInvalidCustomerName,
  normalizeWorkType,
} = require("./lib/lead");
const wa = require("./lib/whatsapp");

const app = express();
const port = process.env.PORT || 3000;
const PUBLIC_URL = getPublicUrl();
const DEFAULT_ADMIN_PASSWORD = "Renovepl@c1234";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
const FORM_SECRET = process.env.FORM_SECRET || "";
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || "romeroluis2001@gmail.com";
const BUDGET_ACCEPTED_EMAIL = process.env.BUDGET_ACCEPTED_EMAIL || "romeroluis2001@gmail.com";
const ADMIN_RECOVERY_EMAIL = process.env.ADMIN_RECOVERY_EMAIL || COMPANY_EMAIL;
const HUMAN_HANDOFF_EMAIL = process.env.HUMAN_HANDOFF_EMAIL || COMPANY_EMAIL;
const COMPANY_NAME = "Luis Eduardo Romero Martinelli";
const WHATSAPP_HISTORY_LIMIT = Number(process.env.WHATSAPP_HISTORY_LIMIT || 6);
const WHATSAPP_IMAGE_HISTORY_LIMIT = Number(process.env.WHATSAPP_IMAGE_HISTORY_LIMIT || 1);
const WHATSAPP_MAX_TOKENS = Number(process.env.WHATSAPP_MAX_TOKENS || 420);
const WHATSAPP_FAST_GREETING_ENABLED = process.env.WHATSAPP_FAST_GREETING_ENABLED !== "0";
const WHATSAPP_FORM_TEMPLATE_NAME = String(process.env.WHATSAPP_FORM_TEMPLATE_NAME || "").trim();
const WHATSAPP_FORM_TEMPLATE_LANG = String(process.env.WHATSAPP_FORM_TEMPLATE_LANG || "es").trim();
const WHATSAPP_FORM_TEMPLATE_PARAMS = String(
  process.env.WHATSAPP_FORM_TEMPLATE_PARAMS || "nombre_cliente,tipo_reforma,codigo_postal"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const MIN_BUDGET_AMOUNT_EUR = 600;
const ACCEPT_BUDGET_REGEX = /^\s*(acepto|si\s+acepto|s[ií]\s+acepto|quiero\s+aceptar|aceptar)\b/i;

app.use(express.json({
  limit: "8mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Form-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

// ---------- Helpers ----------

function normalizePublicUrl(value) {
  const clean = String(value || "").trim().replace(/\/+$/, "");
  if (!clean) return "";
  return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
}

function isLocalPublicUrl(value) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(value || "");
}

function getPublicUrl() {
  const configured = normalizePublicUrl(process.env.PUBLIC_URL);
  if (configured && !isLocalPublicUrl(configured)) return configured;

  const vercelProductionUrl = normalizePublicUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if (vercelProductionUrl) return vercelProductionUrl;

  const vercelDeploymentUrl = normalizePublicUrl(process.env.VERCEL_URL);
  if (vercelDeploymentUrl) return vercelDeploymentUrl;

  return configured || `http://localhost:${port}`;
}

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function generateConfirmationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashConfirmationToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizeFormKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeTemplateParameterName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseMaybeJsonText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !/^[\[{]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const FORM_VALUE_KEYS = new Set([
  "value",
  "value_raw",
  "raw_value",
  "default_value",
  "selected",
  "selected_label",
  "selected_value",
  "selected_text",
  "choice",
  "choice_label",
  "option_label",
  "field_value",
  "display_value",
  "raw",
  "answer",
  "text",
  "content",
]);

function isFormMetadataKey(key) {
  return /^(id|key|name|label|title|type|placeholder|required|css|class|description|choices|options|settings|props|attributes|admin_label|adminlabel|field_id|fieldid|form_id|formid)$/i.test(String(key || ""));
}

function formValueToText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") {
    const parsed = parseMaybeJsonText(value);
    if (parsed !== null) return formValueToText(parsed);
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formValueToText(item))
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  const direct = firstNonEmptyValue(
    value.value,
    value.value_raw,
    value.raw_value,
    value.default_value,
    value.selected,
    value.selected_label,
    value.selected_value,
    value.selected_text,
    value.choice,
    value.choice_label,
    value.option_label,
    value.field_value,
    value.display_value,
    value.raw,
    value.answer,
    value.text,
    value.content
  );

  if (direct) return direct;

  const nameParts = firstNonEmptyValue(value.first, value.first_name, value.firstname) || "";
  const lastParts = firstNonEmptyValue(value.last, value.last_name, value.lastname) || "";
  const combinedName = `${nameParts} ${lastParts}`.replace(/\s+/g, " ").trim();
  if (combinedName) return combinedName;

  return Object.entries(value)
    .filter(([key]) => !FORM_VALUE_KEYS.has(key) && !isFormMetadataKey(key))
    .map(([, child]) => formValueToText(child))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function firstNonEmptyValue(...values) {
  let fallback = "";
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = formValueToText(value);
    if (!fallback) fallback = text;
    if (text) return text;
  }
  return fallback || undefined;
}

function collectFormFields(value, prefix = "", out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value !== "object") {
    const parsed = parseMaybeJsonText(value);
    if (parsed !== null) return collectFormFields(parsed, prefix, out);
    if (prefix) out.push({ key: prefix, value: String(value).trim() });
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFormFields(item, `${prefix} ${index}`.trim(), out));
    return out;
  }

  const maybeValue = firstNonEmptyValue(
    value.value,
    value.value_raw,
    value.raw_value,
    value.default_value,
    value.selected,
    value.selected_label,
    value.selected_value,
    value.selected_text,
    value.choice,
    value.choice_label,
    value.option_label,
    value.field_value,
    value.display_value,
    value.raw,
    value.answer,
    value.text,
    value.content
  );
  if (maybeValue !== undefined) {
    const keys = [
      prefix,
      value.name,
      value.label,
      value.title,
      value.id,
      value.key,
    ].filter(Boolean);
    keys.forEach((key) => out.push({ key: String(key), value: String(maybeValue).trim() }));
  }

  Object.entries(value).forEach(([key, child]) => {
    if (FORM_VALUE_KEYS.has(key)) return;
    collectFormFields(child, `${prefix} ${key}`.trim(), out);
  });
  return out;
}

function readFormValue(body, aliases) {
  const normalizedAliases = aliases.map(normalizeFormKey);

  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body)) {
      const normalizedKey = normalizeFormKey(key);
      if (!normalizedAliases.includes(normalizedKey)) continue;
      const direct = formValueToText(value);
      if (direct) return direct;
    }
  }

  const fields = collectFormFields(body);
  const hasValue = (field) => String(field?.value || "").trim() !== "";
  const exact = fields.find((field) => hasValue(field) && normalizedAliases.includes(normalizeFormKey(field.key)));
  if (exact?.value) return exact.value;
  const partial = fields.find((field) => {
    if (!hasValue(field)) return false;
    const key = normalizeFormKey(field.key);
    return normalizedAliases.some((alias) => key.includes(alias) || alias.includes(key));
  });
  return partial?.value || "";
}

function normalizePostalCode(value) {
  const match = String(value || "").match(/\b(\d{5})\b/);
  if (!match) return "";
  const cp = match[1];
  return /^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/.test(cp) ? cp : "";
}

function rawBodyToText(rawBody) {
  if (!rawBody) return "";
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  if (!raw.trim()) return "";
  const plusAsSpace = raw.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
}

function readPostalCodeFromRawForm(rawBody, phone) {
  const text = rawBodyToText(rawBody);
  if (!text) return "";

  const phoneDigits = isReliablePhoneDigits(phone) ? String(phone || "").replace(/\D/g, "") : "";
  const matches = [...text.matchAll(/\b(0[1-9]|[1-4]\d|5[0-2])\d{3}\b/g)].map((match) => match[0]);
  if (!matches.length) return "";

  const withPostalContext = matches.find((cp) => {
    if (phoneDigits && phoneDigits.includes(cp)) return false;
    const index = text.indexOf(cp);
    const around = normalizeLooseText(text.slice(Math.max(0, index - 90), index + 90));
    return /\b(cp|codigo postal|codigopostal|postal code|postalcode|postcode|zip)\b/.test(around);
  });
  if (withPostalContext) return withPostalContext;

  return matches.find((cp) => !phoneDigits || !phoneDigits.includes(cp)) || "";
}

function isReliablePhoneDigits(value) {
  return /^(?:34)?[6-9]\d{8}$/.test(String(value || "").replace(/\D/g, ""));
}

function readPostalCodeFromForm(body, phone, rawBody) {
  const direct = normalizePostalCode(readFormValue(body, [
    "postal_code",
    "postal code",
    "postal-code",
    "codigo postal",
    "codigo_postal",
    "codigo-postal",
    "codigopostal",
    "codigo postal cliente",
    "codigo_postal_cliente",
    "codigo-postal-cliente",
    "cp",
    "c.p.",
    "cp cliente",
    "zip_code",
    "zip-code",
    "post_code",
    "post-code",
    "postcode",
    "postalcode",
    "zip",
  ]));
  if (direct) return direct;

  const rawPhoneDigits = String(phone || "").replace(/\D/g, "");
  const phoneDigits = isReliablePhoneDigits(rawPhoneDigits) ? rawPhoneDigits : "";
  const fields = collectFormFields(body);
  const keyed = fields.find((field) => {
    const key = normalizeFormKey(field.key);
    return /(codigopostal|postalcode|postcode|zipcode|cp)/.test(key) && normalizePostalCode(field.value);
  });
  if (keyed) return normalizePostalCode(keyed.value);

  const loose = fields.find((field) => {
    const cp = normalizePostalCode(field.value);
    if (!cp) return false;
    const digits = String(field.value || "").replace(/\D/g, "");
    return digits !== phoneDigits && (!phoneDigits || !phoneDigits.includes(cp));
  });
  if (loose) return normalizePostalCode(loose.value);

  const serialized = JSON.stringify(body || {});
  const matches = [...serialized.matchAll(/\b(0[1-9]|[1-4]\d|5[0-2])\d{3}\b/g)]
    .map((match) => match[0]);
  const fallback = matches.find((cp) => !phoneDigits || !phoneDigits.includes(cp));
  return fallback || readPostalCodeFromRawForm(rawBody, phone);
}

function isPlaceholderFormValue(value) {
  const text = normalizeFormKey(value);
  return !text || /^(seleccionaunaopcion|seleccioneunaopcion|eligeunaopcion|opcion|none|null|undefined)$/.test(text);
}

function inferWorkTypeFromText(value) {
  const text = normalizeLooseText(value);
  if (!text || isPlaceholderFormValue(text)) return "";
  const hasSpecificWorkSignal = /\b(reforma integral|vivienda completa|casa completa|piso completo|bano|banos|ducha|duchas|plato de ducha|sanitario|sanitarios|mampara|aseo|inodoro|lavabo|alicatado|alicatar|azulejo|azulejos|fontaneria|desague|desagues|cocina|cocinas|piscina|piscinas|depuradora|gresite|pladur|falso techo|trasdosado|tabique|fachada|fachadas|monocapa|terraza|patio|exterior|exteriores|suelo|suelos|pavimento|porcelanico|solado|local comercial|local|comunidad|comunidades)\b/.test(text);
  if (/\b(reforma integral|vivienda completa|casa completa|piso completo)\b/.test(text)) return "Reforma integral";
  if (/\b(bano|banos|ducha|duchas|plato de ducha|sanitario|sanitarios|mampara|aseo|inodoro|lavabo|alicatado|alicatar|azulejo|azulejos|fontaneria|desague|desagues)\b/.test(text)) return "Baño completo";
  if (/\b(cocina|cocinas)\b/.test(text)) return "Cocina";
  if (/\b(piscina|piscinas|depuradora|gresite)\b/.test(text)) return "Piscina";
  if (/\b(pladur|falso techo|trasdosado|tabique)\b/.test(text)) return "Pladur";
  if (/\b(fachada|fachadas|monocapa)\b/.test(text)) return "Fachada";
  if (/\b(terraza|patio|exterior|exteriores)\b/.test(text)) return "Terraza";
  if (/\b(suelo|suelos|pavimento|porcelanico|solado)\b/.test(text)) return "Suelo o pavimento";
  if (/\b(pintura|pintar)\b/.test(text) && !hasSpecificWorkSignal) return "Pintura";
  if (/\b(local comercial|local)\b/.test(text)) return "Local comercial";
  if (/\b(comunidad|comunidades|propietarios)\b/.test(text)) return "Comunidad";
  return "";
}

function readWorkTypeFromRawForm(rawBody) {
  const text = rawBodyToText(rawBody);
  if (!text) return "";
  return inferWorkTypeFromText(text);
}

function readWorkTypeFromForm(body, rawBody) {
  const direct = readFormValue(body, [
    "work_type",
    "work type",
    "tipo trabajo",
    "tipo de trabajo",
    "tipo_reforma",
    "tipo reforma",
    "tipo de reforma",
    "tipo_obra",
    "tipo obra",
    "tipo de obra",
    "servicio",
    "servicios",
    "reforma",
    "obra",
    "trabajo",
    "opcion",
    "selecciona una opcion",
    "selecciona una opción",
  ]).trim();
  if (direct && !isPlaceholderFormValue(direct)) {
    return inferWorkTypeFromText(direct) || normalizeWorkType(direct) || direct;
  }

  const fields = collectFormFields(body);
  for (const field of fields) {
    const value = String(field.value || "").trim();
    if (!value || isPlaceholderFormValue(value)) continue;
    if (normalizeEmail(value) || normalizePostalCode(value) || normalizePhoneForWhatsapp(value)) continue;
    const inferred = inferWorkTypeFromText(`${field.key} ${value}`);
    if (inferred) return inferred;
    const normalized = normalizeWorkType(value);
    if (normalized && normalizeFormKey(normalized) !== normalizeFormKey(value)) return normalized;
    const loose = normalizeLooseText(value);
    if (/\b(bano|baño|cocina|piscina|pladur|pintura|fachada|terraza|suelo|pavimento|reforma integral|vivienda|local|comunidad)\b/.test(loose)) {
      return normalized || value;
    }
  }

  const inferredSerialized = inferWorkTypeFromText(JSON.stringify(body || ""));
  if (inferredSerialized) return inferredSerialized;

  const serialized = normalizeLooseText(JSON.stringify(body || {}));
  const known = [
    "reforma integral",
    "bano completo",
    "baño completo",
    "cocina",
    "piscina",
    "pladur",
    "pintura",
    "fachada",
    "terraza",
    "suelo",
    "pavimento",
    "local comercial",
    "comunidad",
  ].find((item) => serialized.includes(normalizeLooseText(item)));
  if (known) return normalizeWorkType(known) || known;
  return readWorkTypeFromRawForm(rawBody);
}

function normalizePhoneForWhatsapp(value) {
  const digitsOnly = String(value || "").replace(/\D/g, "");
  if (/^34[6-9]\d{8}$/.test(digitsOnly)) return digitsOnly;
  if (/^[6-9]\d{8}$/.test(digitsOnly)) return `34${digitsOnly}`;

  const normalized = normalizeSpanishPhone(value);
  if (!normalized) return "";
  const digits = normalized.replace(/\D/g, "");
  return digits.length === 9 ? `34${digits}` : digits;
}

function buildFormWhatsappGreeting({ name, workType, postalCode, message }) {
  const firstName = String(name || "").trim().split(/\s+/)[0] || "";
  const introName = firstName ? ` ${firstName}` : "";
  const workText = workType ? ` sobre ${String(workType).toLowerCase()}` : "";
  const zoneText = postalCode ? ` Tengo anotado el codigo postal ${postalCode}.` : "";
  const cleanMessage = String(message || "").replace(/\s+/g, " ").trim();
  const messageText = cleanMessage ? ` Tambien tengo anotado: "${cleanMessage.slice(0, 220)}".` : "";
  return (
    `Hola${introName}, soy Renovebot, el asistente de Renoveplac. Hemos recibido tu solicitud${workText} desde la web.` +
    `${zoneText}${messageText}\n\n` +
    "Para continuar con tu presupuesto, respondeme por aqui con cualquier detalle que falte: medidas aproximadas, estado actual, fotos o plazo que buscas."
  );
}

function buildFormLeadSummary({ name, email, phone, whatsappPhone, postalCode, workType, message }) {
  return [
    `Nombre: ${name || "(sin nombre)"}`,
    `Email: ${email || "(sin email)"}`,
    `Telefono: ${whatsappPhone || phone || "(sin telefono)"}`,
    `Codigo postal: ${postalCode || "(sin CP)"}`,
    `Tipo de obra: ${workType || "(no especificado)"}`,
    "",
    "Mensaje del formulario:",
    message || "(sin mensaje)",
  ].join("\n");
}

function isUsefulFormSnapshotField(field) {
  const key = normalizeFormKey(field?.key);
  const value = String(field?.value || "").replace(/\s+/g, " ").trim();
  if (!key || !value || value.length > 180) return false;
  if (/(secret|token|captcha|recaptcha|nonce|submit|page|url|ip|useragent|browser|fecha|date|time|formid|entryid)/.test(key)) {
    return false;
  }
  if (/^(on|off|true|false|null|undefined|0|1)$/i.test(value)) return false;
  return true;
}

function buildFormInitialMessage(formData, body) {
  const lines = [];
  if (formData.message) {
    lines.push(`Mensaje del cliente: ${formData.message}`);
    lines.push("");
  }

  lines.push("Datos recibidos desde el formulario web:");
  lines.push(`- Nombre: ${formData.name || "(no detectado)"}`);
  lines.push(`- Email: ${formData.email || "(no detectado)"}`);
  lines.push(`- Telefono: ${formData.whatsappPhone || formData.phone || "(no detectado)"}`);
  lines.push(`- Tipo de reforma: ${formData.workType || "(no detectado)"}`);
  lines.push(`- Codigo postal: ${formData.postalCode || "(no detectado)"}`);

  const snapshot = [];
  const seen = new Set();
  for (const field of collectFormFields(body)) {
    if (!isUsefulFormSnapshotField(field)) continue;
    const key = String(field.key || "").replace(/\s+/g, " ").trim().slice(0, 70);
    const value = String(field.value || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const id = `${normalizeFormKey(key)}:${normalizeFormKey(value)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    snapshot.push(`${key}: ${value}`);
    if (snapshot.length >= 10) break;
  }
  if (snapshot.length) {
    lines.push("");
    lines.push("Campos detectados:");
    snapshot.forEach((item) => lines.push(`- ${item}`));
  }

  return lines.join("\n");
}

function getFormTemplateParamValue(param, formData) {
  const key = normalizeFormKey(param);
  const firstName = String(formData.name || "").trim().split(/\s+/)[0] || "cliente";
  const postalCode =
    formData.postalCode ||
    normalizePostalCode(formData.message) ||
    normalizePostalCode(formData.initialMessage);
  const workType =
    formData.workType ||
    inferWorkTypeFromText(formData.message) ||
    inferWorkTypeFromText(formData.initialMessage);
  const values = {
    name: formData.name,
    nombre: formData.name,
    nombrecliente: formData.name,
    firstname: firstName,
    primernombre: firstName,
    email: formData.email,
    correo: formData.email,
    phone: formData.whatsappPhone || formData.phone,
    telefono: formData.whatsappPhone || formData.phone,
    whatsapp: formData.whatsappPhone || formData.phone,
    postalcode: postalCode,
    codigopostal: postalCode,
    codigopostalcliente: postalCode,
    codigo: postalCode,
    postal: postalCode,
    postcode: postalCode,
    zipcode: postalCode,
    zona: postalCode,
    cp: postalCode,
    worktype: workType,
    tipotrabajo: workType,
    tiporeforma: workType,
    tipodeobra: workType,
    tipo: workType,
    servicio: workType,
    obra: workType,
    reforma: workType,
    message: formData.message,
    mensaje: formData.message,
  };
  const value = values[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    if (["postalcode", "codigopostal", "codigopostalcliente", "codigo", "postal", "postcode", "zipcode", "zona", "cp"].includes(key)) return "tu zona";
    if (["worktype", "tipotrabajo", "tiporeforma", "tipodeobra", "tipo", "servicio", "obra", "reforma"].includes(key)) return "tu reforma";
    if (["name", "nombre", "nombrecliente", "firstname", "primernombre"].includes(key)) return firstName || "cliente";
    return "-";
  }
  return String(value).trim().slice(0, 900);
}

function buildFormTemplateParams(formData) {
  return WHATSAPP_FORM_TEMPLATE_PARAMS.map((param) => {
    const name = String(param || "").trim();
    const text = getFormTemplateParamValue(name, formData);
    if (!name || /^\d+$/.test(name)) return text;
    return { parameter_name: normalizeTemplateParameterName(name), text };
  });
}

async function sendFormWhatsappStart(formData, greeting) {
  if (!formData.whatsappPhone) return { sent: false, method: "none", reason: "missing_phone" };

  if (WHATSAPP_FORM_TEMPLATE_NAME) {
    const templateResult = await wa.sendTemplate(
      formData.whatsappPhone,
      WHATSAPP_FORM_TEMPLATE_NAME,
      WHATSAPP_FORM_TEMPLATE_LANG,
      buildFormTemplateParams(formData)
    );
    if (templateResult.ok) return { sent: true, method: "template", result: templateResult };
    console.warn(
      `[form] No se pudo enviar plantilla WhatsApp ${WHATSAPP_FORM_TEMPLATE_NAME} a ${formData.whatsappPhone}:`,
      JSON.stringify(templateResult.error || templateResult)
    );
  }

  const textResult = await wa.sendText(formData.whatsappPhone, greeting);
  if (textResult.ok) return { sent: true, method: "text", result: textResult };
  return { sent: false, method: WHATSAPP_FORM_TEMPLATE_NAME ? "template_then_text" : "text", result: textResult };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidAdminSecret(value) {
  const secret = String(value || "");
  return !!secret && (secret === ADMIN_PASSWORD || secret === DEFAULT_ADMIN_PASSWORD);
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!isValidAdminSecret(token)) {
    return res.status(401).json({ error: "No autorizado." });
  }
  return next();
}

function isSupabaseConnectionError(error) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.cause?.message,
    error?.stack,
  ].filter(Boolean).join(" ");
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Failed to parse URL/i.test(text);
}

function dbConnectionErrorPayload(error) {
  return {
    error:
      "No se pudo conectar con Supabase. Revisa en Vercel que SUPABASE_URL y SUPABASE_SERVICE_KEY apunten al proyecto correcto.",
    detail: error?.message || "Supabase connection failed",
    supabaseHost: (() => {
      try {
        return SUPABASE_URL ? new URL(SUPABASE_URL).host : "";
      } catch (_err) {
        return "";
      }
    })(),
  };
}

async function loadConversation(conversationId) {
  if (!conversationId) return null;
  const { data: conv, error } = await supabase
    .from("bot_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !conv) return null;
  const { data: msgs } = await supabase
    .from("bot_messages")
    .select("id, role, content, image_url, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const messages = msgs || [];
  const enriched = { ...conv, messages };
  await updateLeadData(enriched, buildLeadPatchFromMessages(enriched, messages));
  return enriched;
}

async function loadByToken(token) {
  if (!token) return null;
  const { data, error } = await supabase
    .from("bot_conversations")
    .select("id")
    .eq("access_token", token)
    .maybeSingle();
  if (error || !data) return null;
  return loadConversation(data.id);
}

function buildContext(conv) {
  const parts = [];
  if (conv.customer_name) parts.push(`Nombre del cliente: ${conv.customer_name}`);
  if (conv.customer_email) parts.push(`Email: ${conv.customer_email}`);
  if (conv.customer_phone) parts.push(`Teléfono: ${conv.customer_phone}`);
  if (conv.customer_postal_code) parts.push(`Código postal: ${conv.customer_postal_code}`);
  if (conv.work_type) parts.push(`Tipo de obra indicado en formulario: ${conv.work_type}`);
  if (conv.initial_message) parts.push(`Mensaje original del formulario: ${conv.initial_message}`);
  return parts.join("\n");
}

function toAnthropicMessages(messages) {
  return messages
    .filter((m) => m && (m.content || m.image_url) && (m.role === "user" || m.role === "assistant" || m.role === "admin"))
    .map((m) => {
      const role = m.role === "user" ? "user" : "assistant";
      const text = String(m.content || "").slice(0, 6000);
      if (m.image_url && m.role === "user") {
        const blocks = [];
        if (text) blocks.push({ type: "text", text });
        blocks.push({ type: "image", source: { type: "url", url: m.image_url } });
        return { role, content: blocks };
      }
      return { role, content: text };
    });
}

function recentMessages(messages, limit) {
  if (!Array.isArray(messages)) return [];
  const n = Math.max(1, Number(limit) || 24);
  return messages.slice(-n);
}

function prepareWhatsappModelMessages(messages, options = {}) {
  const recent = recentMessages(messages, WHATSAPP_HISTORY_LIMIT);
  let remainingImages = Math.max(0, Number(WHATSAPP_IMAGE_HISTORY_LIMIT) || 0);
  if (options.forceLatestUserImage) remainingImages = Math.max(remainingImages, 1);

  const prepared = recent.map((msg) => ({ ...msg }));
  for (let i = prepared.length - 1; i >= 0; i -= 1) {
    const msg = prepared[i];
    if (!msg?.image_url || msg.role !== "user") continue;
    if (remainingImages > 0) {
      remainingImages -= 1;
      continue;
    }
    prepared[i] = {
      ...msg,
      image_url: null,
      content:
        msg.content && msg.content !== "(imagen)"
          ? `${msg.content}\n(Foto anterior omitida para responder mas rapido.)`
          : "(Foto anterior omitida para responder mas rapido.)",
    };
  }
  return prepared;
}

function getFastWhatsappGreetingReply(message, conv) {
  if (!WHATSAPP_FAST_GREETING_ENABLED) return "";
  const text = normalizeLooseText(message).replace(/[^a-z0-9\s]/g, "").trim();
  if (!/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hello|hi)(\s+(que tal|como estas))?$/.test(text)) return "";
  const priorUserMessages = (conv?.messages || []).filter((msg) => msg.role === "user").length;
  if (priorUserMessages > 0) return "";
  return "Hola, soy Renovebot, de Renoveplac. Cuentame que reforma tienes en mente y en que zona seria.";
}

function getFirstName(conv) {
  return String(conv?.customer_name || "").trim().split(/\s+/)[0] || "";
}

function getLastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  const lastAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
  return String(lastAssistant?.content || "");
}

function isSimpleWhatsappPing(message) {
  const text = normalizeLooseText(message).replace(/[^a-z0-9\s]/g, "").trim();
  return /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hello|hi|sigo por aqui|estas ahi|hay alguien)$/.test(text);
}

function getFastWhatsappPendingReply(message, conv) {
  if (!WHATSAPP_FAST_GREETING_ENABLED || !isSimpleWhatsappPing(message)) return "";

  const lastAssistant = getLastAssistantText(conv?.messages || []);
  const pending = normalizeLooseText(lastAssistant);
  if (!pending) return "";

  const firstName = getFirstName(conv);
  const greeting = firstName ? `Hola ${firstName}.` : "Hola.";

  if (/\b(email|correo|e-mail|enlace|confirmacion|confirmar)\b/.test(pending)) {
    return `${greeting}\n\nPara seguir necesito que confirmes el email desde el enlace que te he enviado. En cuanto lo abras, el presupuesto aparecera en el chat.`;
  }
  if (/\bfotos?\b|\bimagenes?\b|\badjunt/.test(pending)) {
    return `${greeting}\n\nCuando puedas, enviame las fotos que te pedia para poder preparar el presupuesto con mas precision.`;
  }
  if (/\btelefono|movil|whatsapp|numero\b/.test(pending)) {
    return `${greeting}\n\nPara seguir necesito tu telefono con 9 cifras, por ejemplo 612 345 678, o con prefijo +34.`;
  }
  if (/\bcodigo postal\b|\bcp\b/.test(pending)) {
    return `${greeting}\n\nPara continuar necesito el codigo postal de la vivienda donde seria la reforma.`;
  }
  if (/\bnombre\b|\bcomo te llamas\b|\blocalice\b|\blocalizarte\b/.test(pending)) {
    return `${greeting}\n\nPara dejar tus datos bien registrados necesito tu nombre completo.`;
  }
  if (/\bpropietari[oa]\b|\bduen[oa]\b|\bpermiso\b|\bautorizacion\b/.test(pending)) {
    return `${greeting}\n\nAntes de prepararte presupuesto necesito confirmarte: eres propietario o tienes permiso del dueño para hacer la reforma?`;
  }
  if (/\bmedidas?\b|\bdimensiones?\b|\bmetros?\b|\bm2\b|\btamano\b/.test(pending)) {
    return `${greeting}\n\nPara poder orientarte bien necesito las medidas aproximadas de la reforma. Si no las tienes exactas, dime una estimacion.`;
  }
  if (/\bacabado\b|\bcalidad\b|\bbasico\b|\bmedio\b|\balto\b/.test(pending)) {
    return `${greeting}\n\nPara calcularlo mejor necesito saber que nivel de acabado buscas: basico, medio o alto.`;
  }

  return "";
}

function botRecentlyAskedForPhone(messages) {
  if (!Array.isArray(messages)) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return /\b(tel[eé]fono|m[oó]vil|whats(?:app)?|n[uú]mero)\b/i.test(lastAssistant?.content || "");
}

async function updateLeadData(conv, patch) {
  const nullableLeadFields = new Set(["customer_name"]);
  const cleanPatch = Object.fromEntries(
    Object.entries(patch || {}).filter(([key, value]) =>
      value !== undefined && value !== "" && (value !== null || nullableLeadFields.has(key))
    )
  );
  if (!conv?.id || Object.keys(cleanPatch).length === 0) return conv;

  const { error } = await supabase
    .from("bot_conversations")
    .update(cleanPatch)
    .eq("id", conv.id);
  if (error) {
    console.warn(`[lead] No se pudieron actualizar datos del cliente (${conv.id}):`, error.message);
    return conv;
  }
  Object.assign(conv, cleanPatch);
  return conv;
}

function cleanConversationForDisplay(conv) {
  if (!conv) return conv;
  const awaitingHuman =
    conv.awaiting_human === true ||
    conv.awaiting_human === "true" ||
    hasAwaitingHumanMarker(conv);
  return {
    ...conv,
    customer_name: isLikelyInvalidCustomerName(conv.customer_name) ? null : conv.customer_name,
    work_type: normalizeWorkType(conv.work_type) || conv.work_type,
    awaiting_human: awaitingHuman,
  };
}

function hasAwaitingHumanMarker(conv) {
  if (!conv || conv.bot_enabled !== false) return false;
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  return messages.some((message) => {
    if (message?.role !== "assistant") return false;
    const text = normalizeLooseText(message.content || "");
    return (
      text.includes("he avisado a luis") ||
      text.includes("bot queda pausado") ||
      text.includes("persona del equipo pueda revisar") ||
      text.includes("hablar con un humano")
    );
  });
}

async function fetchAwaitingHumanMap(conversationIds) {
  const ids = [...new Set((conversationIds || []).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;

  const { data, error } = await supabase
    .from("bot_messages")
    .select("conversation_id, role, content, created_at")
    .in("conversation_id", ids)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    console.warn("[admin/conversations] No se pudo calcular espera humana:", error.message);
    return map;
  }

  (data || []).forEach((message) => {
    const text = normalizeLooseText(message.content || "");
    const isHumanWait =
      text.includes("he avisado a luis") ||
      text.includes("bot queda pausado") ||
      text.includes("persona del equipo pueda revisar") ||
      text.includes("hablar con un humano");
    if (isHumanWait) map.set(message.conversation_id, true);
  });

  return map;
}

function formatAdminWhatsappMessage(content) {
  const text = String(content || "").trim();
  return [
    "*Luis - Equipo de Renoveplac*",
    "Mensaje del equipo",
    "",
    text,
  ].join("\n");
}

function addBudgetAcceptanceHint(text, isWeb) {
  const hint = isWeb
    ? "Puedes aceptarlo con el botón \"Aceptar presupuesto\" o escribiendo ACEPTO en el chat."
    : "Si te encaja, responde ACEPTO y Luis te llamará para coordinar la visita técnica.";
  const current = String(text || "").trim();
  if (/ACEPTO|Aceptar presupuesto/i.test(current)) return current;
  return current ? `${current}\n\n${hint}` : hint;
}

function normalizeLooseText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function botAskedForOwnerPermission(messages) {
  if (!Array.isArray(messages)) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const text = normalizeLooseText(lastAssistant?.content || "");
  return /\b(propietari[oa]|duen[oa]|permiso|autorizacion)\b/.test(text);
}

function parseOwnerPermissionAnswer(message, askedRecently = false) {
  const text = normalizeLooseText(message);
  if (!text) return "unknown";

  const mentionsPermissionTopic = /\b(propietari[oa]|duen[oa]|dueno|duena|permiso|autorizacion|titular)\b/.test(text);
  const hasPositivePermission =
    /\bsoy\s+(el\s+|la\s+)?(propietario|propietaria|dueno|duena)\b/.test(text) ||
    /\bes\s+(mi|mio|mia|nuestra|nuestro)\s+(casa|vivienda|piso|local|propiedad)\b/.test(text) ||
    /\b(si\s+)?(tengo|cuento\s+con|dispongo\s+de|me\s+han\s+dado|me\s+han\s+autorizado)\b.{0,30}\b(permiso|autorizacion)\b/.test(text);

  const hasNegativePermission =
    /\b(no\s+(tengo|cuento|dispongo)\b.{0,35}\b(permiso|autorizacion)|sin\s+(permiso|autorizacion)|no\s+me\s+han\s+(dado|autorizado)\b.{0,35}\b(permiso|autorizacion))\b/.test(text) ||
    /\bno\s+soy\s+(propietario|propietaria|dueno|duena)\b/.test(text) ||
    /\bno\s+soy\s+(propietario|propietaria|dueno|duena)\b.{0,40}\b(ni|y\s+no|tampoco)\b.{0,30}\b(permiso|autorizacion)\b/.test(text);

  if (hasPositivePermission && !hasNegativePermission) return "confirmed";
  if (hasNegativePermission && mentionsPermissionTopic) return "denied";
  if (askedRecently && /^(no|nop|negativo)\s*[.!?]*$/.test(text)) return "denied";
  if (askedRecently && /^(si|claro|correcto|por supuesto|ok|vale)\s*[.!?]*$/.test(text)) return "confirmed";
  return "unknown";
}

function getOwnerPermissionStatus(messages) {
  let askedRecently = false;
  let status = "unknown";
  for (const msg of messages || []) {
    if (msg.role === "assistant") {
      const text = normalizeLooseText(msg.content || "");
      askedRecently = /\b(propietari[oa]|duen[oa]|permiso|autorizacion)\b/.test(text);
      continue;
    }
    if (msg.role !== "user") continue;
    const next = parseOwnerPermissionAnswer(msg.content, askedRecently);
    if (next !== "unknown") status = next;
    askedRecently = false;
  }
  return status;
}

function ownerPermissionDeniedByLatestReply(userMessage, previousMessages) {
  return parseOwnerPermissionAnswer(userMessage, botAskedForOwnerPermission(previousMessages)) === "denied";
}

function ownerPermissionDeniedMessage() {
  return (
    "Lo entiendo. En ese caso no puedo prepararte un presupuesto, porque necesitamos que seas propietario " +
    "o tengas permiso del dueño para valorar la reforma.\n\n" +
    "Si más adelante tienes esa autorización, estaré encantado de ayudarte con el presupuesto."
  );
}

function isNoPhotoStatement(message) {
  const text = normalizeLooseText(message);
  if (!text) return false;
  const mentionsPhoto = /\b(foto|fotos|imagen|imagenes|adjuntar|adjunto|enviar|mandar)\b/.test(text);
  if (!mentionsPhoto) return false;
  return (
    /\b(no\s+tengo|no\s+dispongo|no\s+puedo|ahora\s+no|sin\s+foto|sin\s+fotos|no\s+la\s+tengo|no\s+las\s+tengo)\b/.test(text) ||
    /\b(mas\s+tarde|luego|despues)\b.{0,35}\b(foto|fotos|imagen|imagenes)\b/.test(text)
  );
}

function looksLikeNoPhotoPermissionConfusion(reply, userMessage) {
  if (!isNoPhotoStatement(userMessage)) return false;
  const text = normalizeLooseText(reply);
  return /\bno\s+puedo\b.{0,120}\b(presupuesto|prepararte|valorarlo|valorar)\b/.test(text) &&
    /\b(propietari|permiso|duen|autorizacion)\b/.test(text);
}

function buildNoPhotoContinueReply(conv) {
  const firstName = getFirstName(conv);
  const prefix = firstName ? `${firstName}, ` : "";
  return (
    `${prefix}no pasa nada si ahora no tienes fotos. Puedo orientarte con los datos que me des, ` +
    "pero el presupuesto sera menos preciso y el equipo tendra que revisarlo despues con mas detalle.\n\n" +
    "Dime el plazo aproximado que tienes en mente para empezar la reforma y seguimos."
  );
}

function isHumanHandoffRequest(message) {
  const text = normalizeLooseText(message);
  if (!text) return false;

  return (
    /\b(quiero|necesito|prefiero|puedo|podria|me gustaria|quisiera)\b.{0,45}\b(hablar|contactar|contacto|tratar|atender|atienda|llamar|llamada|llame|escribir|escriba)\b.{0,45}\b(luis|persona|humano|empleado|asesor|comercial|tecnico|equipo|alguien)\b/.test(text) ||
    /\b(hablar|contactar|contacto|tratar|atender|atienda|pasame|pasar|derivar|llamar|llamame|llame|llamada|escribir|escriba)\b.{0,45}\b(luis|persona|humano|empleado|asesor|comercial|tecnico|equipo|alguien)\b/.test(text) ||
    /\b(luis|persona|humano|empleado|asesor|comercial|tecnico|equipo|alguien)\b.{0,45}\b(hable|hablar|contacte|contactar|llame|llamar|atienda|atender|escriba|escribir)\b/.test(text) ||
    /\b(persona real|agente humano|atencion humana|operador|empleado)\b/.test(text)
  );
}

function buildHumanHandoffOfferMessage(conv) {
  const firstName = getFirstName(conv);
  const prefix = firstName ? `Entendido, ${firstName}. ` : "Entendido. ";
  return (
    prefix +
    "Si quieres que Luis revise esta conversacion, pulsa el boton \"Hablar con un humano\" y le avisare al equipo para que pueda responderte desde aqui."
  );
}

function buildHumanHandoffConfirmedMessage(conv) {
  const firstName = getFirstName(conv);
  const prefix = firstName ? `Perfecto, ${firstName}. ` : "Perfecto. ";
  return (
    prefix +
    "He avisado a Luis, de Renoveplac. El bot queda pausado para que una persona del equipo pueda revisar esta conversacion y responderte lo antes posible."
  );
}

function getMissingBudgetContactFields(conv) {
  const missing = [];
  const compactPhone = String(conv?.customer_phone || "").replace(/\s+/g, "");
  const validPhone = normalizeSpanishPhone(compactPhone) || /^34[6-9]\d{8}$/.test(compactPhone);
  if (!conv?.customer_name || isLikelyInvalidCustomerName(conv.customer_name)) missing.push("nombre completo");
  if (!validPhone) missing.push("telefono");
  if (!normalizeEmail(conv?.customer_email)) missing.push("email");
  if (!/^\d{5}$/.test(String(conv?.customer_postal_code || "").trim())) missing.push("codigo postal");
  return missing;
}

function buildMissingBudgetContactReply(conv) {
  const missing = getMissingBudgetContactFields(conv);
  if (!missing.length) return "";

  const firstName = getFirstName(conv);
  const prefix = firstName ? `${firstName}, ` : "";
  const nextField = missing[0];

  if (nextField === "nombre completo") {
    return "Para poder continuar con el presupuesto y dejar tu solicitud bien registrada, dime tu nombre completo.";
  }
  if (nextField === "telefono") {
    return `${prefix}ahora dime tu telefono movil con 9 cifras. Por ejemplo: 612 345 678.`;
  }
  if (nextField === "email") {
    return `${prefix}ahora dime tu email. Te enviare ahi el enlace de confirmacion antes de mostrarte el presupuesto.`;
  }
  if (nextField === "codigo postal") {
    return `${prefix}por ultimo, dime el codigo postal de la vivienda donde seria la reforma.`;
  }

  return "Necesito completar un dato de contacto para continuar con el presupuesto.";
}

function looksLikeInlineBudgetReply(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  const normalized = normalizeLooseText(raw);
  const hasBudgetLanguage = /\b(presupuesto|importe|precio|coste|estaria|seria|saldria|incluye|incluiria)\b/.test(normalized);
  const hasEuroAmount = /(?:\d{1,3}(?:[.\s]\d{3})+|\d{3,6})(?:[,.]\d{1,2})?\s*(?:€|eur|euros?)\b/i.test(raw);
  return hasBudgetLanguage && hasEuroAmount;
}

function looksLikeBlockedBudgetReply(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  const normalized = normalizeLooseText(raw);
  const hasBudgetLanguage = /\b(presupuesto|orientativo|importe|precio|coste|estaria|seria|saldria|incluye|incluiria|partidas?)\b/.test(normalized);
  const amountPattern = "(?:\\d{1,3}(?:[.\\s]\\d{3})+|\\d{3,6})(?:[,\\.]\\d{1,2})?";
  const hasEuroAmount = new RegExp(`${amountPattern}\\s*(?:\\u20ac|eur|euros?)\\b`, "i").test(raw);
  const hasPriceRange = new RegExp(`\\bentre\\s+${amountPattern}\\s+(?:y|a|-)\\s+${amountPattern}`, "i").test(raw);
  return looksLikeInlineBudgetReply(raw) || (hasBudgetLanguage && (hasEuroAmount || hasPriceRange));
}

function looksLikeBatchContactDataRequest(text) {
  const normalized = normalizeLooseText(text);
  if (!normalized) return false;
  const fieldCount = [
    /\bnombre\b/.test(normalized),
    /\b(telefono|movil|whatsapp|numero)\b/.test(normalized),
    /\b(email|correo|e-mail)\b/.test(normalized),
    /\b(codigo postal|cp)\b/.test(normalized),
  ].filter(Boolean).length;
  return fieldCount >= 2 && /\b(dato|contacto|presupuesto|preparar)\b/.test(normalized);
}

function looksLikeOwnerPermissionQuestion(text) {
  const normalized = normalizeLooseText(text);
  if (!normalized) return false;
  return /\b(propietar|permiso|duen|dueno|titular)\b/.test(normalized);
}

function looksLikeBudgetPreparationPromise(text) {
  const normalized = normalizeLooseText(text);
  if (!normalized) return false;
  const mentionsBudget = /\b(presupuesto|estimacion|importe|precio|coste)\b/.test(normalized);
  if (!mentionsBudget) return false;
  return (
    /\b(voy|vamos|puedo|paso|dejo|preparo|calculo|genero|hago)\b.{0,90}\b(preparar\w*|calcular\w*|generar\w*|hacer\w*|dejar\w*|pasar\w*|enviar\w*|mandar\w*)\b/.test(normalized) ||
    /\b(te lo dejo|te lo preparo|lo preparo|lo calculo|dame un momento|un momento|en un momento|ahora te lo)\b/.test(normalized)
  );
}

function buildPreBudgetGuardReply(conv) {
  const permissionStatus = getOwnerPermissionStatus(conv?.messages || []);
  if (permissionStatus === "denied") return ownerPermissionDeniedMessage();
  if (permissionStatus !== "confirmed") {
    return "Antes de prepararte presupuesto necesito confirmarte: eres propietario o tienes permiso del dueño para hacer la reforma?";
  }

  const contactReply = buildMissingBudgetContactReply(conv);
  if (contactReply) return contactReply;

  return (
    "Ya tengo la informacion principal. Para mostrarte el presupuesto orientativo necesito generarlo correctamente " +
    "y enviarte primero el enlace de confirmacion al email. Dame un ultimo detalle si falta alguno y lo preparo."
  );
}

function assertBudgetCanBeCreated(input, conv) {
  const permissionStatus = getOwnerPermissionStatus(conv?.messages || []);
  if (permissionStatus === "denied") {
    throw new Error(
      "El cliente ha indicado que no es propietario ni tiene permiso del dueño. No generes presupuesto; explícalo con educación."
    );
  }
  if (permissionStatus !== "confirmed") {
    throw new Error(
      "Antes de crear el presupuesto debes preguntar: ¿Eres propietario o tienes permiso del dueño para hacer la reforma?"
    );
  }

  const missingContact = getMissingBudgetContactFields(conv);
  if (missingContact.length) {
    throw new Error(
      `Antes de crear el presupuesto debes pedir estos datos de contacto en un unico mensaje: ${missingContact.join(", ")}.`
    );
  }

  const amount = Number(input?.amount_eur) || 0;
  if (amount < MIN_BUDGET_AMOUNT_EUR) {
    throw new Error(
      `El importe calculado (${amount || 0} EUR) está por debajo del mínimo de obra de ${MIN_BUDGET_AMOUNT_EUR} EUR. No generes presupuesto; explica el mínimo y pregunta si quiere agrupar más trabajos.`
    );
  }
}

function buildPreBudgetGuardReplyStrict(conv) {
  const permissionStatus = getOwnerPermissionStatus(conv?.messages || []);
  if (permissionStatus === "denied") return ownerPermissionDeniedMessage();

  const contactReply = buildMissingBudgetContactReply(conv);
  if (contactReply) return contactReply;

  if (permissionStatus !== "confirmed") {
    return "Antes de enviarte la confirmacion por email necesito comprobar una cosa: eres propietario o tienes permiso del dueno para hacer la reforma?";
  }

  return (
    "Ya tengo la informacion principal. Para mostrarte el presupuesto orientativo te enviare primero un enlace de confirmacion al email. " +
    "Cuando lo abras, el presupuesto aparecera en este chat."
  );
}

function assertBudgetCanBeCreatedStrict(input, conv) {
  const missingContact = getMissingBudgetContactFields(conv);
  if (missingContact.length) {
    throw new Error(
      `Antes de crear el presupuesto debes pedir solo este dato de contacto que falta: ${missingContact[0]}. No pidas todos los datos juntos.`
    );
  }

  const permissionStatus = getOwnerPermissionStatus(conv?.messages || []);
  if (permissionStatus === "denied") {
    throw new Error(
      "El cliente ha indicado que no es propietario ni tiene permiso. No generes presupuesto; explicalo con educacion."
    );
  }
  if (permissionStatus !== "confirmed") {
    throw new Error(
      "Antes de crear el presupuesto debes preguntar si el cliente es propietario o tiene permiso del dueno para hacer la reforma."
    );
  }

  const amount = Number(input?.amount_eur) || 0;
  if (amount < MIN_BUDGET_AMOUNT_EUR) {
    throw new Error(
      `El importe calculado (${amount || 0} EUR) esta por debajo del minimo de obra de ${MIN_BUDGET_AMOUNT_EUR} EUR. No generes presupuesto; explica el minimo y pregunta si quiere agrupar mas trabajos.`
    );
  }
}

async function fetchBudgetConfirmations(budgetIds) {
  if (!budgetIds.length) return new Map();
  const { data, error } = await supabase
    .from("bot_budget_email_confirmations")
    .select("budget_id, email, sent_at, confirmed_at")
    .in("budget_id", budgetIds);
  if (error) {
    console.warn("[budget-confirmation] No se pudieron cargar confirmaciones:", error.message);
    return new Map();
  }
  return new Map((data || []).map((row) => [row.budget_id, row]));
}

async function fetchBudgetConfirmation(budgetId) {
  const { data, error } = await supabase
    .from("bot_budget_email_confirmations")
    .select("budget_id, conversation_id, email, token_hash, sent_at, confirmed_at")
    .eq("budget_id", budgetId)
    .maybeSingle();
  if (error) {
    console.warn(`[budget-confirmation] No se pudo cargar ${budgetId}:`, error.message);
    return null;
  }
  return data || null;
}

async function attachBudgetConfirmations(budgets) {
  const confirmations = await fetchBudgetConfirmations((budgets || []).map((b) => b.id));
  return (budgets || []).map((budget) => {
    const confirmation = confirmations.get(budget.id);
    if (!confirmation) return budget;
    return {
      ...budget,
      email_confirmation_required: true,
      email_confirmation_email: confirmation.email,
      email_confirmation_sent_at: confirmation.sent_at,
      email_confirmed_at: confirmation.confirmed_at,
    };
  });
}

async function fetchBudgets(conversationId, options = {}) {
  const includeUnconfirmed = !!options.includeUnconfirmed;
  const { data } = await supabase
    .from("bot_budgets")
    .select("id, title, description, amount_eur, iva_included, status, created_at, accepted_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const budgets = await attachBudgetConfirmations(data || []);
  if (includeUnconfirmed) return budgets;
  return budgets.filter((budget) => !budget.email_confirmation_required || budget.email_confirmed_at);
}

async function fetchLeadStatsByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const { data, error } = await supabase
    .from("bot_leads")
    .select("email, budget_request_count, email_confirmed_budget_count, created_at, updated_at")
    .eq("email", normalized)
    .maybeSingle();
  if (error) {
    console.warn(`[lead] No se pudieron cargar estadisticas de ${normalized}:`, error.message);
    return null;
  }
  return data || null;
}

async function recordLeadBudgetRequest(email, conversationId) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Falta un email valido para confirmar el presupuesto.");

  const now = new Date().toISOString();
  const { data: existing, error: selectError } = await supabase
    .from("bot_leads")
    .select("email, budget_request_count, email_confirmed_budget_count")
    .eq("email", normalized)
    .maybeSingle();
  if (selectError) throw selectError;

  if (existing) {
    const nextCount = Number(existing.budget_request_count || 0) + 1;
    const { data, error } = await supabase
      .from("bot_leads")
      .update({
        budget_request_count: nextCount,
        last_conversation_id: conversationId,
        updated_at: now,
      })
      .eq("email", normalized)
      .select("email, budget_request_count, email_confirmed_budget_count")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("bot_leads")
    .insert({
      email: normalized,
      first_conversation_id: conversationId,
      last_conversation_id: conversationId,
      budget_request_count: 1,
      email_confirmed_budget_count: 0,
    })
    .select("email, budget_request_count, email_confirmed_budget_count")
    .single();
  if (error) throw error;
  return data;
}

async function registerBudgetEmailConfirmation(budget, conv) {
  const email = normalizeEmail(conv.customer_email);
  if (!email) throw new Error("Falta email del cliente. Pidelo antes de crear el presupuesto.");

  const lead = await recordLeadBudgetRequest(email, conv.id);
  const rawToken = generateConfirmationToken();
  const tokenHash = hashConfirmationToken(rawToken);
  const confirmUrl = `${PUBLIC_URL}/api/budget/${budget.id}/confirm?token=${rawToken}`;

  const { error } = await supabase
    .from("bot_budget_email_confirmations")
    .insert({
      budget_id: budget.id,
      conversation_id: conv.id,
      email,
      token_hash: tokenHash,
    });
  if (error) throw error;

  const requestCount = Number(lead?.budget_request_count || 1);
  const firstName = String(conv.customer_name || "").trim().split(/\s+/)[0] || "";
  const html = buildProfessionalBudgetEmailConfirmationHtml({
    firstName,
    email,
    confirmUrl,
    requestCount,
  });
  const text = [
    `Hola${firstName ? ` ${firstName}` : ""},`,
    "",
    "Hemos preparado tu presupuesto orientativo de Renoveplac.",
    "Para verlo en el chat, confirma primero que este correo es tuyo abriendo este enlace:",
    "",
    confirmUrl,
    "",
    `Solicitudes registradas con este email: ${requestCount}.`,
    "",
    "Si no has solicitado este presupuesto, puedes ignorar este mensaje.",
  ].join("\n");

  const sendResult = await safeSendEmail({
    to: email,
    replyTo: COMPANY_EMAIL,
    subject: "Confirma tu email para ver el presupuesto de Renoveplac",
    text,
    html,
  }, "budget/email-confirmation");
  if (sendResult?.error || sendResult?.mocked) {
    await supabase
      .from("bot_budget_email_confirmations")
      .delete()
      .eq("budget_id", budget.id);
    throw new Error(`No se pudo enviar el email de confirmación: ${sendResult.error || "SMTP no configurado"}`);
  }

  return { email, confirmUrl, requestCount };
}

function buildBudgetEmailConfirmationHtml({ firstName, email, confirmUrl, requestCount }) {
  const greeting = firstName ? `Hola ${escapeHtml(firstName)},` : "Hola,";
  const safeEmail = escapeHtml(email);
  const safeUrl = escapeHtml(confirmUrl);
  const count = Number(requestCount || 1);

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Confirma tu email para ver el presupuesto</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f6f4;font-family:Arial,Helvetica,sans-serif;color:#11231f;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Confirma tu email para abrir tu presupuesto orientativo de Renoveplac.
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f6f4;margin:0;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #dce7e1;border-radius:16px;overflow:hidden;box-shadow:0 16px 42px rgba(15,47,39,0.10);">
            <tr>
              <td style="background:#143c32;padding:24px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td>
                      <div style="font-size:22px;line-height:1.1;font-weight:800;color:#ffffff;letter-spacing:.2px;">Renoveplac</div>
                      <div style="margin-top:6px;font-size:13px;line-height:1.4;color:#cfe1da;">Reformas integrales en Llíria y alrededores</div>
                    </td>
                    <td align="right" style="vertical-align:top;">
                      <span style="display:inline-block;background:#ff7821;color:#ffffff;border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;">Presupuesto</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 28px 10px;">
                <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#102820;">Confirma tu email para ver el presupuesto</h1>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#33443f;">${greeting}</p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#33443f;">
                  Hemos preparado tu presupuesto orientativo. Para mostrarlo en el chat, necesitamos confirmar que <strong style="color:#143c32;">${safeEmail}</strong> es tu correo.
                </p>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0 22px;">
                  <tr>
                    <td align="center" style="border-radius:10px;background:#ff7821;">
                      <a href="${safeUrl}" style="display:inline-block;padding:15px 24px;border-radius:10px;background:#ff7821;color:#ffffff;text-decoration:none;font-size:16px;font-weight:800;">
                        Confirmar email y ver presupuesto
                      </a>
                    </td>
                  </tr>
                </table>
                <div style="background:#f7faf8;border:1px solid #dbe7e1;border-radius:12px;padding:15px 16px;margin:0 0 22px;">
                  <p style="margin:0 0 6px;font-size:13px;font-weight:800;color:#143c32;text-transform:uppercase;letter-spacing:.3px;">Verificación segura</p>
                  <p style="margin:0;font-size:14px;line-height:1.55;color:#4b5c56;">
                    Este paso ayuda a proteger tus datos y evita que alguien use tu email para solicitar presupuestos sin permiso.
                  </p>
                </div>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#66736f;">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
                <p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all;">
                  <a href="${safeUrl}" style="color:#143c32;text-decoration:underline;">${safeUrl}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #edf1ef;padding-top:18px;">
                  <tr>
                    <td style="font-size:13px;line-height:1.55;color:#6b7773;">
                      Solicitudes registradas con este email: <strong style="color:#143c32;">${count}</strong><br>
                      Si no has solicitado este presupuesto, puedes ignorar este mensaje.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <p style="max-width:620px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#7a8581;text-align:center;">
            Renoveplac · Presupuestos orientativos sujetos a visita técnica y confirmación de medidas.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildProfessionalBudgetEmailConfirmationHtml({ firstName, email, confirmUrl, requestCount }) {
  const greeting = firstName ? `Hola ${escapeHtml(firstName)},` : "Hola,";
  const safeEmail = escapeHtml(email);
  const safeUrl = escapeHtml(confirmUrl);
  const count = Number(requestCount || 1);

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Confirma tu email para ver el presupuesto</title>
  </head>
  <body style="margin:0;padding:0;background:#eef4f1;font-family:Arial,Helvetica,sans-serif;color:#11231f;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Renoveplac ha preparado tu presupuesto orientativo. Confirma tu email para acceder de forma segura.
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef4f1;margin:0;padding:30px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dce7e1;border-radius:18px;overflow:hidden;box-shadow:0 18px 46px rgba(15,47,39,0.12);">
            <tr>
              <td style="background:#143c32;padding:26px 30px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td>
                      <div style="font-size:24px;line-height:1.1;font-weight:800;color:#ffffff;letter-spacing:.2px;">Renoveplac</div>
                      <div style="margin-top:7px;font-size:13px;line-height:1.4;color:#cfe1da;">Reformas integrales, pladur y baños en Llíria y alrededores</div>
                    </td>
                    <td align="right" style="vertical-align:top;">
                      <span style="display:inline-block;background:#ff7821;color:#ffffff;border-radius:999px;padding:8px 13px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;">Acceso seguro</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 30px 12px;">
                <p style="margin:0 0 12px;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#ff7821;">Verificación de solicitud</p>
                <h1 style="margin:0 0 16px;font-size:28px;line-height:1.18;color:#102820;">Confirma tu email para acceder a tu presupuesto</h1>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#33443f;">${greeting}</p>
                <p style="margin:0 0 20px;font-size:16px;line-height:1.65;color:#33443f;">
                  Hemos preparado una estimación orientativa a partir de los datos que nos has indicado en el chat. Antes de mostrarla, necesitamos confirmar que <strong style="color:#143c32;">${safeEmail}</strong> es tu correo.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7faf8;border:1px solid #dbe7e1;border-radius:14px;margin:0 0 24px;">
                  <tr>
                    <td style="padding:18px 18px 16px;">
                      <p style="margin:0 0 8px;font-size:15px;font-weight:800;color:#143c32;">Tu presupuesto queda reservado</p>
                      <p style="margin:0;font-size:14px;line-height:1.6;color:#40534d;">
                        Al confirmar este enlace, Renovebot abrirá el presupuesto en tu conversación y nuestro equipo podrá identificar correctamente tu solicitud.
                      </p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0 24px;">
                  <tr>
                    <td align="center" style="border-radius:12px;background:#ff7821;box-shadow:0 8px 18px rgba(255,120,33,.24);">
                      <a href="${safeUrl}" style="display:inline-block;padding:16px 26px;border-radius:12px;background:#ff7821;color:#ffffff;text-decoration:none;font-size:16px;font-weight:800;">
                        Confirmar email y abrir presupuesto
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:-12px 0 24px;font-size:13px;line-height:1.5;color:#66736f;">El botón te llevará a una pantalla segura de confirmación. Después volverás al chat para ver el presupuesto.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7faf8;border:1px solid #dbe7e1;border-radius:14px;margin:0 0 22px;">
                  <tr>
                    <td style="padding:18px 18px 16px;">
                      <p style="margin:0 0 12px;font-size:14px;font-weight:800;color:#143c32;text-transform:uppercase;letter-spacing:.4px;">Por qué hacemos esta verificación</p>
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                          <td width="28" style="vertical-align:top;padding:2px 10px 10px 0;"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background:#143c32;color:#ffffff;text-align:center;line-height:24px;font-size:13px;font-weight:800;">1</span></td>
                          <td style="padding:0 0 10px;font-size:14px;line-height:1.55;color:#40534d;">Comprobamos que el correo pertenece a la persona que ha solicitado el presupuesto.</td>
                        </tr>
                        <tr>
                          <td width="28" style="vertical-align:top;padding:2px 10px 10px 0;"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background:#143c32;color:#ffffff;text-align:center;line-height:24px;font-size:13px;font-weight:800;">2</span></td>
                          <td style="padding:0 0 10px;font-size:14px;line-height:1.55;color:#40534d;">Protegemos tus datos de contacto y evitamos solicitudes realizadas con correos ajenos.</td>
                        </tr>
                        <tr>
                          <td width="28" style="vertical-align:top;padding:2px 10px 0 0;"><span style="display:inline-block;width:24px;height:24px;border-radius:50%;background:#143c32;color:#ffffff;text-align:center;line-height:24px;font-size:13px;font-weight:800;">3</span></td>
                          <td style="padding:0;font-size:14px;line-height:1.55;color:#40534d;">Dejamos la solicitud bien identificada para que Renoveplac pueda revisarla correctamente.</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;">
                  <tr>
                    <td style="padding:14px 16px;border-left:4px solid #ff7821;background:#fff8f3;border-radius:10px;">
                      <p style="margin:0;font-size:14px;line-height:1.55;color:#5c4b3f;"><strong style="color:#143c32;">Nota de seguridad:</strong> este enlace solo confirma tu email. El presupuesto es orientativo y se revisará después de la visita técnica, tomando medidas y definiendo materiales.</p>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#66736f;">Si el botón no funciona, también puedes copiar y pegar este enlace en tu navegador:</p>
                <p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all;">
                  <a href="${safeUrl}" style="color:#143c32;text-decoration:underline;">${safeUrl}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 30px 30px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #edf1ef;padding-top:18px;">
                  <tr>
                    <td style="font-size:13px;line-height:1.65;color:#6b7773;">
                      Solicitudes de presupuesto registradas con este email: <strong style="color:#143c32;">${count}</strong><br>
                      Si tú no has solicitado este presupuesto, puedes ignorar este mensaje sin realizar ninguna acción.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <p style="max-width:640px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#7a8581;text-align:center;">
            Renoveplac · Reformas integrales, pladur, baños, cocinas, pintura y trabajos de albañilería.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function rollbackBudgetCreation(budget, conv) {
  if (!budget?.id) return;
  await supabase
    .from("bot_budget_email_confirmations")
    .delete()
    .eq("budget_id", budget.id);
  await supabase
    .from("bot_budgets")
    .delete()
    .eq("id", budget.id);
  await supabase
    .from("bot_conversations")
    .update({ status: "active" })
    .eq("id", conv.id);
}

function buildBudgetConfirmationMessage(confirmation, channel) {
  const email = confirmation?.email || "tu email";
  const countLine = confirmation?.requestCount
    ? `\n\nSolicitudes registradas con este email: ${confirmation.requestCount}.`
    : "";
  const deliveryLine = channel === "whatsapp"
    ? "\n\nAbre ese enlace desde tu correo y te enviaré el presupuesto por este mismo WhatsApp."
    : "\n\nAbre ese enlace desde tu correo y el presupuesto aparecerá en este chat.";
  return (
    `Te he preparado el presupuesto orientativo. Para mostrártelo, te he enviado un enlace de confirmación a ${email}.` +
    deliveryLine +
    countLine
  );
}

function buildEmailConfirmationRequiredMessage(confirmation) {
  const email = confirmation?.email || "tu email";
  return (
    `Antes de aceptar o ver el presupuesto, confirma el enlace que te he enviado a ${email}.` +
    "\n\nEn cuanto lo confirmes, te enviaré el presupuesto por este mismo chat."
  );
}

function isBudgetViewRequest(message) {
  const text = normalizeLooseText(message);
  if (!/\b(presupuesto|estimacion|importe|precio)\b/.test(text)) return false;
  return /\b(ver|mostrar|mandar|enviar|pasar|reenviar|poner|aqui|whatsapp|confirmad[oa]|correo|email)\b/.test(text);
}

function formatBudgetAmount(amount) {
  return Number(amount || 0).toLocaleString("es-ES");
}

function buildWhatsappBudgetMessage(budget, options = {}) {
  const ivaTxt = budget?.iva_included ? "(IVA incluido)" : "+ IVA aparte";
  const title = String(budget?.title || "Presupuesto orientativo Renoveplac").trim();
  const rawDescription = String(budget?.description || "").trim();
  const description = rawDescription.length > 2500
    ? `${rawDescription.slice(0, 2500).trim()}\n...`
    : rawDescription;
  const intro = options.intro || "Email confirmado. Aquí tienes tu presupuesto orientativo:";

  return [
    intro,
    "",
    "━━━━━━━━━━━━━━━━━━",
    "📋 *PRESUPUESTO ORIENTATIVO*",
    `*${title}*`,
    `Importe: *${formatBudgetAmount(budget?.amount_eur)} €* ${ivaTxt}`,
    "",
    description,
    "━━━━━━━━━━━━━━━━━━",
    "",
    "Si te encaja, responde *ACEPTO* y Luis, de Renoveplac, coordinará contigo la visita técnica.",
  ].filter(Boolean).join("\n").slice(0, 4096);
}

function budgetMessageAlreadySent(content, budget) {
  const text = normalizeLooseText(content);
  const title = normalizeLooseText(budget?.title).slice(0, 80);
  const digits = String(content || "").replace(/\D/g, "");
  const amount = String(Math.round(Number(budget?.amount_eur || 0)));
  return (
    text.includes("presupuesto orientativo") &&
    (!title || text.includes(title)) &&
    (!amount || digits.includes(amount))
  );
}

async function fetchBudgetById(budgetId) {
  const { data, error } = await supabase
    .from("bot_budgets")
    .select("id, conversation_id, title, description, amount_eur, iva_included, status, created_at, accepted_at")
    .eq("id", budgetId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function sendBudgetToWhatsapp(conv, budget, options = {}) {
  if (!conv || conv.channel !== "whatsapp" || !conv.customer_phone || !budget) {
    return { skipped: true, reason: "not_whatsapp" };
  }

  const allowDuplicate = !!options.allowDuplicate;
  const content = buildWhatsappBudgetMessage(budget, { intro: options.intro });

  if (!allowDuplicate) {
    const { data: recentMsgs } = await supabase
      .from("bot_messages")
      .select("content")
      .eq("conversation_id", conv.id)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(25);

    if ((recentMsgs || []).some((msg) => budgetMessageAlreadySent(msg.content, budget))) {
      return { skipped: true, reason: "already_sent" };
    }
  }

  const sendResult = await wa.sendText(conv.customer_phone, content);
  if (!sendResult.ok) return { ok: false, error: sendResult.error || sendResult };

  const { data: assistantMsgRow, error } = await supabase
    .from("bot_messages")
    .insert({
      conversation_id: conv.id,
      role: "assistant",
      content,
    })
    .select()
    .single();
  if (error) console.warn("[whatsapp/budget] enviado pero no se pudo guardar mensaje:", error.message);
  return { ok: true, assistantMsgRow };
}

async function createConversationBudget(input, conv, fullConv) {
  assertBudgetCanBeCreatedStrict(input, fullConv);
  if (!normalizeEmail(conv.customer_email)) {
    throw new Error("Falta email del cliente. Pide un email valido antes de generar el presupuesto.");
  }

  const { data: budget, error } = await supabase
    .from("bot_budgets")
    .insert({
      conversation_id: conv.id,
      title: input.title,
      description: input.description,
      amount_eur: Number(input.amount_eur) || 0,
      iva_included: !!input.iva_included,
    })
    .select()
    .single();
  if (error) throw error;

  await supabase
    .from("bot_conversations")
    .update({ status: "budget_sent" })
    .eq("id", conv.id);

  try {
    const confirmation = await registerBudgetEmailConfirmation(budget, conv);
    budget.email_confirmation = confirmation;
    return budget;
  } catch (err) {
    await rollbackBudgetCreation(budget, conv);
    throw err;
  }
}

async function notifyHumanFromWhatsapp(input, conv, from) {
  const reasonLabel = ({
    queja: "Queja / reclamacion",
    solicita_humano: "El cliente pide hablar con persona",
    lead_premium: "Lead premium",
    alto_ticket: "Alto ticket (>15.000 EUR)",
    fuera_de_zona_obra_grande: "Fuera de zona pero obra grande (valorar)",
  })[input.reason] || input.reason;
  const lines = [
    `Aviso del bot (WhatsApp): ${reasonLabel}`,
    "",
    `Resumen: ${input.summary || "(sin resumen)"}`,
    "",
    `Cliente: ${conv.customer_name || "(sin nombre)"} - ${from}`,
    `Conversacion: ${PUBLIC_URL}/admin#${conv.id}`,
  ].join("\n");
  await safeSendEmail({
    to: COMPANY_EMAIL,
    subject: `Aviso bot WA - ${reasonLabel} - ${conv.customer_name || from}`,
    text: lines,
  }, "notify_human");
  return { ok: true };
}

function renderBudgetConfirmationPage({ budgetId, token, email }) {
  const action = `/api/budget/${encodeURIComponent(budgetId)}/confirm`;
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Confirmar email | Renoveplac</title>
    <style>
      :root { color-scheme: light; font-family: Arial, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f6f4; color: #10241f; }
      main { width: min(92vw, 480px); background: #fff; border: 1px solid #dbe5df; border-radius: 12px; padding: 28px; box-shadow: 0 18px 45px rgba(13, 48, 38, 0.12); }
      h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.2; }
      p { margin: 0 0 18px; line-height: 1.5; color: #40534d; }
      strong { color: #143c32; overflow-wrap: anywhere; }
      button { width: 100%; border: 0; border-radius: 8px; background: #143c32; color: #fff; padding: 14px 18px; font-size: 16px; font-weight: 700; cursor: pointer; }
      button:hover { background: #0f2f27; }
    </style>
  </head>
  <body>
    <main>
      <h1>Confirma tu email</h1>
      <p>Para mostrarte el presupuesto orientativo en el chat, confirma que <strong>${escapeHtml(email)}</strong> es tu correo.</p>
      <form method="post" action="${action}">
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <button type="submit">Confirmar email y ver presupuesto</button>
      </form>
    </main>
  </body>
</html>`;
}

function renderBudgetWhatsappConfirmedPage() {
  const businessPhone = normalizePhoneForWhatsapp(
    process.env.WHATSAPP_PUBLIC_PHONE ||
    process.env.WHATSAPP_BUSINESS_PHONE ||
    "34602727334"
  );
  const waUrl = businessPhone ? `https://wa.me/${encodeURIComponent(businessPhone)}` : "";
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Email confirmado | Renoveplac</title>
    <style>
      :root { color-scheme: light; font-family: Arial, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f6f4; color: #10241f; }
      main { width: min(92vw, 500px); background: #fff; border: 1px solid #dbe5df; border-radius: 14px; padding: 30px; box-shadow: 0 18px 45px rgba(13, 48, 38, 0.12); }
      h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.2; }
      p { margin: 0 0 18px; line-height: 1.55; color: #40534d; }
      a { display: inline-block; border-radius: 10px; background: #25d366; color: #fff; padding: 13px 18px; text-decoration: none; font-weight: 800; }
    </style>
  </head>
  <body>
    <main>
      <h1>Email confirmado</h1>
      <p>Perfecto. Te hemos enviado el presupuesto orientativo por el mismo chat de WhatsApp.</p>
      <p>Ya puedes volver a la conversación para revisarlo y responder <strong>ACEPTO</strong> si te encaja.</p>
      ${waUrl ? `<a href="${waUrl}">Volver a WhatsApp</a>` : ""}
    </main>
  </body>
</html>`;
}

async function confirmBudgetEmail(id, rawToken) {
  if (!rawToken) {
    const err = new Error("Falta token de confirmacion.");
    err.status = 400;
    throw err;
  }

  const confirmation = await fetchBudgetConfirmation(id);
  if (!confirmation) {
    const err = new Error("Confirmacion no encontrada.");
    err.status = 404;
    throw err;
  }
  if (confirmation.token_hash !== hashConfirmationToken(rawToken)) {
    const err = new Error("Enlace de confirmacion no valido.");
    err.status = 403;
    throw err;
  }

  if (!confirmation.confirmed_at) {
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("bot_budget_email_confirmations")
      .update({ confirmed_at: now })
      .eq("budget_id", id);
    if (updateError) throw updateError;

    const lead = await fetchLeadStatsByEmail(confirmation.email);
    if (lead) {
      await supabase
        .from("bot_leads")
        .update({
          email_confirmed_budget_count: Number(lead.email_confirmed_budget_count || 0) + 1,
          updated_at: now,
        })
        .eq("email", confirmation.email);
    }
  }

  const conv = await loadConversation(confirmation.conversation_id);
  if (!conv?.access_token) {
    const err = new Error("Conversacion no encontrada.");
    err.status = 404;
    throw err;
  }
  return { confirmation, conv };
}

async function fetchLatestPendingBudget(conversationId) {
  const { data } = await supabase
    .from("bot_budgets")
    .select("id, conversation_id, title, description, amount_eur, iva_included, status, created_at, accepted_at")
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

async function acceptPendingBudgetFromChat(conv) {
  const pending = await fetchLatestPendingBudget(conv.id);
  if (!pending) {
    const reply =
      "Ahora mismo no veo un presupuesto pendiente para aceptar. Si quieres, te ayudo a revisar el presupuesto o a preparar uno nuevo.";
    const { data: assistantMsgRow } = await supabase
      .from("bot_messages")
      .insert({
        conversation_id: conv.id,
        role: "assistant",
        content: reply,
      })
      .select()
      .single();
    return { reply, assistantMsgRow, budget: null };
  }

  const confirmation = await fetchBudgetConfirmation(pending.id);
  if (confirmation && !confirmation.confirmed_at) {
    const reply = buildEmailConfirmationRequiredMessage(confirmation);
    const { data: assistantMsgRow } = await supabase
      .from("bot_messages")
      .insert({
        conversation_id: conv.id,
        role: "assistant",
        content: reply,
      })
      .select()
      .single();
    return { reply, assistantMsgRow, budget: null };
  }

  const budget = await acceptBudgetInternal(pending.id);
  const firstName = String(conv.customer_name || "").trim().split(/\s+/)[0] || "";
  const reply =
    `${firstName ? `Perfecto, ${firstName}. ` : "Perfecto. "}Queda confirmado el presupuesto.\n\n` +
    "Luis, de Renoveplac, se pondrá en contacto contigo en breve para coordinar la visita técnica y cerrar el presupuesto definitivo. ¡Un saludo!";
  const { data: assistantMsgRow } = await supabase
    .from("bot_messages")
    .insert({
      conversation_id: conv.id,
      role: "assistant",
      content: reply,
    })
    .select()
    .single();
  return { reply, assistantMsgRow, budget };
}

async function safeSendEmail(payload, label) {
  try {
    const result = await sendEmail(payload);
    if (result?.id) {
      console.log(`[email] enviado (${label || "sin etiqueta"}) a ${payload.to}: ${result.id}`);
    } else if (result?.mocked) {
      console.log(`[email] simulado (${label || "sin etiqueta"}) a ${payload.to}`);
    }
    return result;
  } catch (err) {
    console.warn(`[email] envío fallido (${label || "sin etiqueta"}):`, err.message);
    return { error: err.message };
  }
}

// ---------- Páginas ----------

function formatMessageForEmail(msg) {
  const role = msg?.role === "user" ? "Cliente" : msg?.role === "admin" ? "Renoveplac" : "Renovebot";
  const content = String(msg?.content || msg?.image_url || "").trim();
  return `${role}: ${content || "(sin texto)"}`.slice(0, 1200);
}

function buildHumanHandoffEmail(conv, reason) {
  const adminUrl = `${PUBLIC_URL}/admin#${conv.id}`;
  const lastMessages = (conv.messages || []).slice(-8).map(formatMessageForEmail).join("\n");
  const source = conv.channel === "whatsapp" ? "WhatsApp" : conv.source === "form" ? "Formulario web" : "Chat web";

  return [
    "Un cliente ha solicitado hablar con una persona del equipo.",
    "",
    `Motivo detectado: ${reason || "Solicitud de atencion humana"}`,
    `Canal: ${source}`,
    "",
    "Datos del cliente:",
    `- Nombre: ${conv.customer_name || "(sin nombre)"}`,
    `- Email: ${conv.customer_email || "(sin email)"}`,
    `- Telefono: ${conv.customer_phone || "(sin telefono)"}`,
    `- Codigo postal: ${conv.customer_postal_code || "(sin CP)"}`,
    `- Tipo de obra: ${conv.work_type || "(no especificado)"}`,
    "",
    "Enlace directo al chat:",
    adminUrl,
    "",
    "Ultimos mensajes:",
    lastMessages || "(sin mensajes)",
  ].join("\n");
}

async function requestHumanHandoff(conv, options = {}) {
  const reason = options.reason || "El cliente pide hablar con una persona";
  const text = buildHumanHandoffEmail(conv, reason);
  const sendResult = await safeSendEmail({
    to: HUMAN_HANDOFF_EMAIL,
    replyTo: conv.customer_email || undefined,
    subject: `Cliente solicita humano - ${conv.customer_name || conv.customer_phone || "lead Renoveplac"}`,
    text,
  }, "human_handoff");

  if (sendResult?.error || sendResult?.mocked) {
    const err = new Error(sendResult?.error || "Email no configurado");
    err.status = 503;
    throw err;
  }

  const { error: pauseError } = await supabase
    .from("bot_conversations")
    .update({ bot_enabled: false })
    .eq("id", conv.id);
  if (pauseError) throw pauseError;

  const reply = buildHumanHandoffConfirmedMessage(conv);
  const { data: assistantMsgRow, error: msgError } = await supabase
    .from("bot_messages")
    .insert({
      conversation_id: conv.id,
      role: "assistant",
      content: reply,
    })
    .select()
    .single();
  if (msgError) throw msgError;

  return { assistantMsgRow, reply };
}

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ---------- Subida de imagen ----------

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

app.post("/api/upload", async (req, res) => {
  try {
    const { data, mimeType, conversationId, token } = req.body || {};
    if (!data || !mimeType) return res.status(400).json({ error: "Falta data o mimeType." });
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
      return res.status(400).json({ error: "Tipo de imagen no permitido." });
    }
    let conv = null;
    if (conversationId) conv = await loadConversation(String(conversationId));
    else if (token) conv = await loadByToken(String(token));
    if (!conv) return res.status(404).json({ error: "Conversación no encontrada." });

    let base64 = String(data);
    const match = /^data:[^;]+;base64,(.+)$/.exec(base64);
    if (match) base64 = match[1];
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) return res.status(400).json({ error: "Imagen vacía." });
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "Imagen demasiado grande (máx 5 MB)." });
    }

    const ext = (mimeType.split("/")[1] || "jpg").replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
    const fileName = `${conv.id}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from("chat-images")
      .upload(fileName, buffer, { contentType: mimeType, upsert: false });
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage.from("chat-images").getPublicUrl(fileName);
    return res.json({ url: pub.publicUrl });
  } catch (err) {
    console.error("[upload]", err);
    return res.status(500).json({ error: "No se pudo subir la imagen." });
  }
});

// ---------- Formulario WordPress ----------

app.post("/api/form", async (req, res) => {
  try {
    if (FORM_SECRET) {
      const provided = req.headers["x-form-secret"] || req.body?.secret;
      if (provided !== FORM_SECRET) {
        return res.status(401).json({ error: "Secreto inválido." });
      }
    }

    const name = readFormValue(req.body, ["name", "nombre", "nombre y apellido", "nombre y apellidos", "nombre completo"]).trim();
    const email = normalizeEmail(readFormValue(req.body, ["email", "correo", "correo electronico", "e-mail"]));
    const phone = readFormValue(req.body, ["phone", "telefono", "telefono movil", "movil", "whatsapp"]).trim();
    const postalCode = readPostalCodeFromForm(req.body, phone, req.rawBody);
    const workType = readWorkTypeFromForm(req.body, req.rawBody);
    const message = readFormValue(req.body, ["message", "mensaje", "comentarios", "descripcion", "observaciones"]).trim();

    console.log("[form] solicitud recibida", {
      hasName: Boolean(name),
      hasEmail: Boolean(email),
      hasPhone: Boolean(phone),
      hasPostalCode: Boolean(postalCode),
      hasWorkType: Boolean(workType),
      postalCode: postalCode || null,
      workType: workType || null,
      rawPostalCode: formValueToText(req.body?.postal_code || req.body?.codigo_postal || req.body?.cp).slice(0, 80) || null,
      rawWorkType: formValueToText(req.body?.work_type || req.body?.tipo_reforma || req.body?.servicio).slice(0, 80) || null,
      rawFallbackHasPostalCode: Boolean(readPostalCodeFromRawForm(req.rawBody, phone)),
      rawFallbackWorkType: readWorkTypeFromRawForm(req.rawBody) || null,
      bodyKeys: Object.keys(req.body || {}).slice(0, 20),
    });

    if (!email || !name) {
      return res.status(400).json({ error: "Faltan datos obligatorios (nombre y email)." });
    }

    const whatsappPhone = normalizePhoneForWhatsapp(phone);
    const formData = {
      name,
      email,
      phone,
      whatsappPhone,
      postalCode,
      workType,
      message,
    };
    const initialMessage = buildFormInitialMessage(formData, req.body);
    formData.initialMessage = initialMessage;
    const token = generateToken();
    const { data: conv, error } = await supabase
      .from("bot_conversations")
      .insert({
        customer_name: name,
        customer_email: email,
        customer_phone: whatsappPhone || phone || null,
        customer_postal_code: postalCode || null,
        work_type: workType || null,
        initial_message: initialMessage || null,
        source: "form",
        channel: whatsappPhone ? "whatsapp" : null,
        access_token: token,
      })
      .select()
      .single();
    if (error) throw error;

    const firstName = name.split(" ")[0];
    const greeting = buildFormWhatsappGreeting({ name, workType, postalCode, message });
    await supabase.from("bot_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: greeting,
    });

    let whatsappSent = false;
    let whatsappMethod = "none";
    if (whatsappPhone) {
      const sendResult = await sendFormWhatsappStart(formData, greeting);
      whatsappSent = !!sendResult.sent;
      whatsappMethod = sendResult.method || "unknown";
      if (!whatsappSent) {
        console.warn(
          `[form] No se pudo iniciar WhatsApp para ${whatsappPhone}:`,
          JSON.stringify(sendResult.result?.error || sendResult)
        );
      }
    }

    const chatUrl = `${PUBLIC_URL}/?t=${token}`;
    if (!whatsappSent) {
      await safeSendEmail({
        to: email,
        replyTo: COMPANY_EMAIL,
        subject: "Hemos recibido tu solicitud — Renoveplac",
        text: `Hola ${firstName},\n\nGracias por contactar con Renoveplac. Hemos recibido tu mensaje${workType ? ` sobre ${workType.toLowerCase()}` : ""}.\n\nPara agilizar tu presupuesto, sigue la conversación con nuestro asistente desde el siguiente enlace:\n${chatUrl}\n\nUn saludo,\n${COMPANY_NAME}\nRenoveplac · ${COMPANY_EMAIL}`,
        html: `<p>Hola ${firstName},</p>
          <p>Gracias por contactar con Renoveplac. Hemos recibido tu mensaje${workType ? ` sobre <strong>${workType}</strong>` : ""}.</p>
          <p>Para agilizar tu presupuesto, sigue la conversación con nuestro asistente desde el siguiente enlace:</p>
          <p><a href="${chatUrl}">${chatUrl}</a></p>
          <p>Un saludo,<br>${COMPANY_NAME}<br>Renoveplac · ${COMPANY_EMAIL}</p>`,
      }, "form/cliente");
    }

    const companyLeadText =
      `Lead recibido desde el formulario de la web.\n\n${buildFormLeadSummary(formData)}\n\n` +
      `Canal de inicio: ${
        whatsappSent
          ? `WhatsApp enviado (${whatsappMethod})`
          : whatsappPhone
            ? `WhatsApp no enviado (${whatsappMethod}), fallback email`
            : "Email/chat web"
      }\n\n` +
      `Ver conversacion: ${PUBLIC_URL}/admin#${conv.id}`;

    await safeSendEmail({
      to: COMPANY_EMAIL,
      subject: `Nuevo lead desde web — ${name}${workType ? ` (${workType})` : ""}`,
      text: companyLeadText,
    }, "form/empresa");

    return res.json({ ok: true, conversationId: conv.id, chatUrl, whatsappSent, whatsappMethod });
  } catch (err) {
    console.error("[form]", err);
    return res.status(500).json({ error: "No se pudo registrar el formulario." });
  }
});

// ---------- Chat público ----------

app.post("/api/human-handoff", async (req, res) => {
  try {
    const { conversationId, token, reason } = req.body || {};
    const conv = conversationId ? await loadConversation(conversationId) : await loadByToken(token);
    if (!conv) return res.status(404).json({ error: "Conversacion no encontrada." });
    if (conv.status === "closed") return res.status(403).json({ error: "Esta conversacion esta cerrada." });

    const result = await requestHumanHandoff(conv, { reason });
    return res.json({
      ok: true,
      botEnabled: false,
      reply: result.reply,
      assistantMessage: result.assistantMsgRow,
    });
  } catch (err) {
    console.error("[human-handoff]", err);
    return res.status(err.status || 500).json({
      error: err.status === 503
        ? "No se pudo enviar el aviso por email. Revisa la configuracion de Resend."
        : "No se pudo avisar al equipo.",
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en el servidor." });
    }
    const { message, conversationId, token, image_url: rawImageUrl } = req.body || {};
    const userMessage = String(message || "").trim();
    const imageUrl = String(rawImageUrl || "").trim();
    if (!userMessage && !imageUrl) return res.status(400).json({ error: "Mensaje vacío." });

    let conv = null;
    if (conversationId) conv = await loadConversation(conversationId);
    else if (token) conv = await loadByToken(token);

    if (!conv) {
      const newToken = generateToken();
      const { data, error } = await supabase
        .from("bot_conversations")
        .insert({ source: "widget", access_token: newToken })
        .select()
        .single();
      if (error) throw error;
      conv = { ...data, messages: [] };
    }

    if (conv.status === "closed") {
      return res.status(403).json({ error: "Esta conversación está cerrada." });
    }

    const previousMessages = conv.messages || [];
    const { data: userMsgRow } = await supabase
      .from("bot_messages")
      .insert({
        conversation_id: conv.id,
        role: "user",
        content: userMessage || (imageUrl ? "(imagen)" : ""),
        image_url: imageUrl || null,
      })
      .select()
      .single();
    conv.messages = [
      ...previousMessages,
      userMsgRow || { role: "user", content: userMessage || (imageUrl ? "(imagen)" : ""), image_url: imageUrl || null },
    ];

    let botReply = "";
    let createdBudget = null;
    let assistantMsgRow = null;

    if (ACCEPT_BUDGET_REGEX.test(userMessage)) {
      const accepted = await acceptPendingBudgetFromChat(conv);
      return res.json({
        reply: accepted.reply,
        conversationId: conv.id,
        accessToken: conv.access_token,
        botEnabled: conv.bot_enabled !== false,
        budget: accepted.budget,
        userMessage: userMsgRow,
        assistantMessage: accepted.assistantMsgRow,
      });
    }

    if (conv.bot_enabled !== false && ownerPermissionDeniedByLatestReply(userMessage, previousMessages)) {
      botReply = ownerPermissionDeniedMessage();
      const { data } = await supabase
        .from("bot_messages")
        .insert({
          conversation_id: conv.id,
          role: "assistant",
          content: botReply,
        })
        .select()
        .single();
      assistantMsgRow = data;

      return res.json({
        reply: botReply,
        conversationId: conv.id,
        accessToken: conv.access_token,
        botEnabled: true,
        budget: null,
        userMessage: userMsgRow,
        assistantMessage: assistantMsgRow,
      });
    }

    const leadPatch = buildLeadPatch(conv, userMessage, conv.messages || []);
    const phoneStatus = getPhoneSubmissionStatus(userMessage);
    const phoneAttempted =
      !leadPatch.customer_email &&
      (phoneStatus.attempted || (botRecentlyAskedForPhone(conv.messages) && /\d/.test(userMessage)));

    if (conv.bot_enabled !== false && phoneAttempted && !phoneStatus.valid) {
      botReply = INVALID_PHONE_REPLY;
      const { data } = await supabase
        .from("bot_messages")
        .insert({
          conversation_id: conv.id,
          role: "assistant",
          content: botReply,
        })
        .select()
        .single();
      assistantMsgRow = data;

      return res.json({
        reply: botReply,
        conversationId: conv.id,
        accessToken: conv.access_token,
        botEnabled: true,
        budget: null,
        userMessage: userMsgRow,
        assistantMessage: assistantMsgRow,
      });
    }

    await updateLeadData(conv, leadPatch);

    if (conv.bot_enabled !== false && isHumanHandoffRequest(userMessage)) {
      botReply = buildHumanHandoffOfferMessage(conv);
      const { data } = await supabase
        .from("bot_messages")
        .insert({
          conversation_id: conv.id,
          role: "assistant",
          content: botReply,
        })
        .select()
        .single();
      assistantMsgRow = data;

      return res.json({
        reply: botReply,
        conversationId: conv.id,
        accessToken: conv.access_token,
        botEnabled: true,
        budget: null,
        humanHandoffOffered: true,
        userMessage: userMsgRow,
        assistantMessage: assistantMsgRow,
      });
    }

    if (conv.bot_enabled !== false) {
      const systemPrompt = buildSystemPrompt(buildContext(conv));
      const history = toAnthropicMessages(conv.messages || []);

      const result = await runConversation({
        systemPrompt,
        messages: history,
        onBudget: async (input) => {
          assertBudgetCanBeCreatedStrict(input, conv);
          if (!normalizeEmail(conv.customer_email)) {
            throw new Error("Falta email del cliente. Pide un email válido antes de generar el presupuesto.");
          }
          const { data: budget, error } = await supabase
            .from("bot_budgets")
            .insert({
              conversation_id: conv.id,
              title: input.title,
              description: input.description,
              amount_eur: Number(input.amount_eur) || 0,
              iva_included: !!input.iva_included,
            })
            .select()
            .single();
          if (error) throw error;
          await supabase
            .from("bot_conversations")
            .update({ status: "budget_sent" })
            .eq("id", conv.id);
          try {
            const confirmation = await registerBudgetEmailConfirmation(budget, conv);
            budget.email_confirmation = confirmation;
            return budget;
          } catch (err) {
            await rollbackBudgetCreation(budget, conv);
            throw err;
          }
        },
        onNotifyHuman: async (input) => {
          const reasonLabel = ({
            queja: "Queja / reclamación",
            solicita_humano: "El cliente pide hablar con persona",
            lead_premium: "Lead premium (administrador, presidente, arquitecto, aparejador)",
            alto_ticket: "Alto ticket (>15.000 €)",
            fuera_de_zona_obra_grande: "Fuera de zona pero obra grande (valorar)",
          })[input.reason] || input.reason;

          const lines = [
            `Aviso del bot: se requiere intervención humana.`,
            "",
            `Motivo: ${reasonLabel}`,
            "",
            `Resumen del bot:`,
            input.summary || "(sin resumen)",
            "",
            "Datos del lead:",
            `- Nombre: ${conv.customer_name || "(sin nombre)"}`,
            `- Email: ${conv.customer_email || "(sin email)"}`,
            `- Teléfono: ${conv.customer_phone || "(sin teléfono)"}`,
            `- Código postal: ${conv.customer_postal_code || "(sin CP)"}`,
            `- Tipo de obra: ${conv.work_type || "(no especificado)"}`,
            "",
            `Conversación completa: ${PUBLIC_URL}/admin#${conv.id}`,
          ].join("\n");

          await safeSendEmail({
            to: COMPANY_EMAIL,
            replyTo: conv.customer_email || undefined,
            subject: `Aviso bot — ${reasonLabel} — ${conv.customer_name || "lead"}`,
            text: lines,
          }, "notify_human");
          return { ok: true };
        },
      });

      botReply = result.text || "";
      createdBudget = result.budget;
      if (createdBudget) {
        if (createdBudget.email_confirmation) {
          botReply = buildBudgetConfirmationMessage(createdBudget.email_confirmation);
        } else {
          botReply = addBudgetAcceptanceHint(botReply, true);
        }
      } else if (
        looksLikeBlockedBudgetReply(botReply) ||
        looksLikeBudgetPreparationPromise(botReply) ||
        looksLikeBatchContactDataRequest(botReply) ||
        (getMissingBudgetContactFields(conv).length && looksLikeOwnerPermissionQuestion(botReply))
      ) {
        botReply = buildPreBudgetGuardReplyStrict({ ...conv, messages: conv.messages || [] });
      }
      if (!createdBudget && looksLikeNoPhotoPermissionConfusion(botReply, userMessage)) {
        botReply = buildNoPhotoContinueReply(conv);
      }

      if (botReply) {
        const { data } = await supabase
          .from("bot_messages")
          .insert({
            conversation_id: conv.id,
            role: "assistant",
            content: botReply,
          })
          .select()
          .single();
        assistantMsgRow = data;
      }
    }

    return res.json({
      reply: botReply,
      conversationId: conv.id,
      accessToken: conv.access_token,
      botEnabled: conv.bot_enabled !== false,
      budget: createdBudget?.email_confirmation ? null : createdBudget,
      pendingBudgetEmailConfirmation: createdBudget?.email_confirmation || null,
      userMessage: userMsgRow,
      assistantMessage: assistantMsgRow,
    });
  } catch (err) {
    console.error("[chat]", err);
    if (isSupabaseConnectionError(err)) {
      return res.status(503).json(dbConnectionErrorPayload(err));
    }
    return res.status(500).json({ error: "Error procesando el mensaje." });
  }
});

// ---------- Conversación pública ----------

app.get("/api/conversation", async (req, res) => {
  try {
    const { token, id } = req.query;
    let conv = null;
    if (token) conv = await loadByToken(String(token));
    else if (id) conv = await loadConversation(String(id));
    if (!conv) return res.status(404).json({ error: "Conversación no encontrada." });

    const budgets = await fetchBudgets(conv.id);
    return res.json({
      conversationId: conv.id,
      accessToken: conv.access_token,
      messages: conv.messages,
      budgets,
      botEnabled: conv.bot_enabled,
      status: conv.status,
      customer: {
        name: conv.customer_name,
        email: conv.customer_email,
        workType: conv.work_type,
      },
    });
  } catch (err) {
    console.error("[conversation]", err);
    return res.status(500).json({ error: "Error cargando conversación." });
  }
});

app.get("/api/messages", async (req, res) => {
  try {
    const { conversationId, token, since } = req.query;
    let conv = null;
    if (conversationId) conv = await loadConversation(String(conversationId));
    if (!conv && token) conv = await loadByToken(String(token));
    if (!conv) return res.status(404).json({ error: "No encontrada." });

    let messages = conv.messages;
    if (since) messages = messages.filter((m) => m.created_at > since);

    const budgets = await fetchBudgets(conv.id);
    return res.json({
      conversationId: conv.id,
      accessToken: conv.access_token,
      messages,
      budgets,
      botEnabled: conv.bot_enabled,
      status: conv.status,
    });
  } catch (err) {
    console.error("[messages]", err);
    return res.status(500).json({ error: "Error cargando mensajes." });
  }
});

app.get("/api/budget/:id/confirm", async (req, res) => {
  try {
    const { id } = req.params;
    const rawToken = String(req.query.token || "");
    if (!rawToken) return res.status(400).send("Falta token de confirmacion.");

    const confirmation = await fetchBudgetConfirmation(id);
    if (!confirmation) return res.status(404).send("Confirmacion no encontrada.");
    if (confirmation.token_hash !== hashConfirmationToken(rawToken)) {
      return res.status(403).send("Enlace de confirmacion no valido.");
    }

    if (confirmation.confirmed_at) {
      const conv = await loadConversation(confirmation.conversation_id);
      if (!conv?.access_token) return res.status(404).send("Conversacion no encontrada.");
      if (conv.channel === "whatsapp") {
        const budget = await fetchBudgetById(id);
        const delivery = await sendBudgetToWhatsapp(conv, budget, {
          intro: "Tu email ya estaba confirmado. Te dejo de nuevo el presupuesto orientativo:",
        });
        console.log(`[budget/confirm:get] WhatsApp ya confirmado ${id}: ${JSON.stringify(delivery)}`);
        return res
          .status(200)
          .type("html")
          .send(renderBudgetWhatsappConfirmedPage());
      }
      const redirectUrl = `${PUBLIC_URL}/?t=${encodeURIComponent(conv.access_token)}&email_confirmed=1`;
      return res.redirect(303, redirectUrl);
    }

    const { conv } = await confirmBudgetEmail(id, rawToken);
    if (conv.channel === "whatsapp") {
      const budget = await fetchBudgetById(id);
      const delivery = await sendBudgetToWhatsapp(conv, budget, {
        intro: "Email confirmado. Aqui tienes tu presupuesto orientativo:",
      });
      console.log(`[budget/confirm:get] WhatsApp ${id}: ${JSON.stringify(delivery)}`);
      return res
        .status(200)
        .type("html")
        .send(renderBudgetWhatsappConfirmedPage());
    }

    const redirectUrl = `${PUBLIC_URL}/?t=${encodeURIComponent(conv.access_token)}&email_confirmed=1`;
    return res.redirect(303, redirectUrl);
  } catch (err) {
    console.error("[budget/confirm:get]", err);
    return res.status(500).send("No se pudo cargar la confirmacion.");
  }
});

app.post("/api/budget/:id/confirm", async (req, res) => {
  try {
    const { id } = req.params;
    const rawToken = String(req.body?.token || req.query?.token || "");
    const { conv } = await confirmBudgetEmail(id, rawToken);
    if (conv.channel === "whatsapp") {
      const budget = await fetchBudgetById(id);
      const delivery = await sendBudgetToWhatsapp(conv, budget, {
        intro: "Email confirmado. Aquí tienes tu presupuesto orientativo:",
      });
      console.log(`[budget/confirm:post] WhatsApp ${id}: ${JSON.stringify(delivery)}`);
      return res
        .status(200)
        .type("html")
        .send(renderBudgetWhatsappConfirmedPage());
    }
    const redirectUrl = `${PUBLIC_URL}/?t=${encodeURIComponent(conv.access_token)}&email_confirmed=1`;
    return res.redirect(303, redirectUrl);
  } catch (err) {
    console.error("[budget/confirm:post]", err);
    return res.status(err.status || 500).send(err.message || "No se pudo confirmar el presupuesto.");
  }
});

// ---------- Aceptar presupuesto ----------

app.post("/api/budget/:id/accept", async (req, res) => {
  try {
    const { id } = req.params;
    const { data: budget, error } = await supabase
      .from("bot_budgets")
      .select("*, bot_conversations(*)")
      .eq("id", id)
      .maybeSingle();
    if (error || !budget) return res.status(404).json({ error: "Presupuesto no encontrado." });
    if (budget.status !== "pending") {
      return res.status(400).json({ error: "Presupuesto ya gestionado." });
    }

    const confirmation = await fetchBudgetConfirmation(id);
    if (confirmation && !confirmation.confirmed_at) {
      return res.status(403).json({
        error: buildEmailConfirmationRequiredMessage(confirmation),
        requiresEmailConfirmation: true,
        email: confirmation.email,
      });
    }

    await supabase
      .from("bot_budgets")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", id);

    await supabase
      .from("bot_conversations")
      .update({ status: "budget_accepted" })
      .eq("id", budget.conversation_id);

    const conv = budget.bot_conversations;
    const ivaLine = budget.iva_included ? "(IVA incluido)" : "+ IVA aparte";
    const summary = [
      "Presupuesto aceptado por el cliente.",
      "",
      `Cliente: ${conv.customer_name || "(sin nombre)"}`,
      `Email: ${conv.customer_email || "(sin email)"}`,
      `Teléfono: ${conv.customer_phone || "(sin teléfono)"}`,
      `Código postal: ${conv.customer_postal_code || "(sin CP)"}`,
      `Tipo de obra: ${conv.work_type || "(no especificado)"}`,
      "",
      `Título: ${budget.title}`,
      `Importe orientativo: ${budget.amount_eur} EUR ${ivaLine}`,
      "",
      "Descripción:",
      budget.description,
      "",
      `Conversación completa: ${PUBLIC_URL}/admin#${conv.id}`,
    ].join("\n");

    await safeSendEmail({
      to: BUDGET_ACCEPTED_EMAIL,
      replyTo: conv.customer_email || undefined,
      subject: `Presupuesto aceptado — ${conv.customer_name || "lead"} — ${budget.amount_eur} EUR`,
      text: summary,
    }, "budget/accept");

    await supabase.from("bot_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content:
        "He registrado tu aceptación del presupuesto orientativo. Luis se pondrá en contacto contigo en breve para coordinar la visita técnica y cerrar el presupuesto definitivo. Recibirás también un email de confirmación.",
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[budget/accept]", err);
    return res.status(500).json({ error: "No se pudo aceptar el presupuesto." });
  }
});

// ---------- Admin ----------

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (isValidAdminSecret(password)) {
    return res.json({ token: password === DEFAULT_ADMIN_PASSWORD ? DEFAULT_ADMIN_PASSWORD : ADMIN_PASSWORD });
  }
  return res.status(401).json({ error: "Contraseña incorrecta." });
});

app.post("/api/admin/forgot-password", async (_req, res) => {
  const loginUrl = `${PUBLIC_URL}/admin`;
  const subject = "Recuperacion de acceso al panel Renoveplac";
  const text = [
    "Se ha solicitado recuperar el acceso al panel de administracion de Renoveplac.",
    "",
    `Enlace al panel: ${loginUrl}`,
    `Contrasena de acceso: ${DEFAULT_ADMIN_PASSWORD}`,
    "",
    `Por seguridad, este aviso se envia solo al correo configurado para recuperacion: ${ADMIN_RECOVERY_EMAIL}.`,
  ].join("\n");
  const html = `
    <div style="margin:0;padding:24px;background:#f4f7f6;font-family:Arial,sans-serif;color:#102820;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dbe7e1;">
        <div style="background:#143c32;color:#ffffff;padding:22px 26px;">
          <h1 style="margin:0;font-size:24px;line-height:1.2;">Renoveplac</h1>
          <p style="margin:6px 0 0;font-size:14px;color:#dcebe6;">Recuperacion de acceso al panel</p>
        </div>
        <div style="padding:26px;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Se ha solicitado recuperar el acceso al panel de administracion.</p>
          <div style="margin:18px 0;padding:16px;border-radius:12px;background:#f7faf8;border:1px solid #dbe7e1;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:700;text-transform:uppercase;color:#63726d;">Contrasena activa</p>
            <p style="margin:0;font-size:22px;font-weight:800;color:#143c32;">${escapeHtml(DEFAULT_ADMIN_PASSWORD)}</p>
          </div>
          <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#40534d;">Este correo se envia solo a ${escapeHtml(ADMIN_RECOVERY_EMAIL)} para evitar que terceros puedan recuperar el acceso.</p>
          <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#ff7821;color:#ffffff;text-decoration:none;padding:14px 20px;border-radius:10px;font-weight:800;">Abrir panel</a>
        </div>
      </div>
    </div>`;

  const result = await safeSendEmail({
    to: ADMIN_RECOVERY_EMAIL,
    replyTo: COMPANY_EMAIL,
    subject,
    text,
    html,
  }, "admin/forgot-password");

  if (result?.error || result?.mocked) {
    return res.status(500).json({ error: "No se pudo enviar el correo de recuperacion." });
  }
  return res.json({
    ok: true,
    to: ADMIN_RECOVERY_EMAIL,
    provider: result?.provider || "email",
    id: result?.id || null,
  });
});

app.get("/api/admin/conversations", requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("bot_conversations")
      .select(
        "id, customer_name, customer_email, customer_phone, customer_postal_code, work_type, status, bot_enabled, created_at, updated_at, source, channel"
      )
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) {
      const payload = isSupabaseConnectionError(error)
        ? dbConnectionErrorPayload(error)
        : { error: error.message };
      return res.status(isSupabaseConnectionError(error) ? 503 : 500).json(payload);
    }
    const conversations = data || [];
    const pausedIds = conversations
      .filter((conv) => conv.bot_enabled === false)
      .map((conv) => conv.id);
    const awaitingMap = await fetchAwaitingHumanMap(pausedIds);
    return res.json({
      conversations: conversations.map((conv) =>
        cleanConversationForDisplay({
          ...conv,
          awaiting_human: awaitingMap.get(conv.id) || false,
        })
      ),
    });
  } catch (err) {
    console.error("[admin/conversations]", err);
    if (isSupabaseConnectionError(err)) {
      return res.status(503).json(dbConnectionErrorPayload(err));
    }
    return res.status(500).json({ error: err.message || "Error cargando conversaciones." });
  }
});

app.get("/api/admin/conversations/:id", requireAdmin, async (req, res) => {
  const conv = await loadConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversación no encontrada." });
  const budgets = await fetchBudgets(conv.id, { includeUnconfirmed: true });
  const leadStats = await fetchLeadStatsByEmail(conv.customer_email);
  return res.json({ ...cleanConversationForDisplay(conv), budgets, lead_stats: leadStats });
});

app.post("/api/admin/conversations/:id/reply", requireAdmin, async (req, res) => {
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "Mensaje vacío." });
  const { data: conv, error: convError } = await supabase
    .from("bot_conversations")
    .select("id, channel, customer_phone")
    .eq("id", req.params.id)
    .maybeSingle();
  if (convError || !conv) return res.status(404).json({ error: "Conversación no encontrada." });

  const { error } = await supabase.from("bot_messages").insert({
    conversation_id: req.params.id,
    role: "admin",
    content,
  });
  if (error) return res.status(500).json({ error: error.message });

  let whatsappSent = false;
  if (conv.channel === "whatsapp" && conv.customer_phone) {
    const sendResult = await wa.sendText(
      conv.customer_phone,
      formatAdminWhatsappMessage(content)
    );
    whatsappSent = !!sendResult.ok;
    if (!whatsappSent) {
      console.warn(`[admin/reply] No se pudo enviar WhatsApp a ${conv.customer_phone}:`, JSON.stringify(sendResult.error || sendResult));
    }
  }

  return res.json({ ok: true, whatsappSent });
});

app.post("/api/admin/conversations/:id/toggle-bot", requireAdmin, async (req, res) => {
  const enabled = !!req.body?.enabled;
  const { error } = await supabase
    .from("bot_conversations")
    .update({ bot_enabled: enabled })
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

app.post("/api/admin/conversations/:id/close", requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from("bot_conversations")
    .update({ status: "closed" })
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

app.post("/api/admin/conversations/:id/delete", requireAdmin, async (req, res) => {
  const conversationId = req.params.id;

  const { error: messagesError } = await supabase
    .from("bot_messages")
    .delete()
    .eq("conversation_id", conversationId);
  if (messagesError) return res.status(500).json({ error: messagesError.message });

  const { error: confirmationsError } = await supabase
    .from("bot_budget_email_confirmations")
    .delete()
    .eq("conversation_id", conversationId);
  if (confirmationsError && confirmationsError.code !== "42P01") {
    return res.status(500).json({ error: confirmationsError.message });
  }

  const { error: budgetsError } = await supabase
    .from("bot_budgets")
    .delete()
    .eq("conversation_id", conversationId);
  if (budgetsError) return res.status(500).json({ error: budgetsError.message });

  const { error } = await supabase
    .from("bot_conversations")
    .delete()
    .eq("id", conversationId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ---------- WhatsApp ----------

async function loadConversationByPhone(phone) {
  if (!phone) return null;
  const { data } = await supabase
    .from("bot_conversations")
    .select("*")
    .eq("customer_phone", phone)
    .eq("channel", "whatsapp")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return null;
  const conv = data[0];
  const messageLimit = Math.max(10, WHATSAPP_HISTORY_LIMIT + 4);
  const { data: msgs } = await supabase
    .from("bot_messages")
    .select("id, role, content, image_url, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(messageLimit);
  const messages = (msgs || []).reverse();
  return { ...conv, messages };
}

async function acceptBudgetInternal(budgetId) {
  await supabase
    .from("bot_budgets")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", budgetId);
  const { data: budget } = await supabase
    .from("bot_budgets")
    .select("*, bot_conversations(*)")
    .eq("id", budgetId)
    .maybeSingle();
  if (!budget) return;
  const conv = budget.bot_conversations;
  await supabase
    .from("bot_conversations")
    .update({ status: "budget_accepted" })
    .eq("id", budget.conversation_id);
  const ivaLine = budget.iva_included ? "(IVA incluido)" : "+ IVA aparte";
  const summary = [
    "Presupuesto aceptado por el cliente.",
    "",
    `Cliente: ${conv.customer_name || "(sin nombre)"}`,
    `Email: ${conv.customer_email || "(sin email)"}`,
    `Teléfono: ${conv.customer_phone || "(sin teléfono)"}`,
    `Canal: ${conv.channel || "web"}`,
    `Tipo de obra: ${conv.work_type || "(no especificado)"}`,
    "",
    `Título: ${budget.title}`,
    `Importe orientativo: ${budget.amount_eur} EUR ${ivaLine}`,
    "",
    "Descripción:",
    budget.description,
    "",
    `Conversación completa: ${PUBLIC_URL}/admin#${conv.id}`,
  ].join("\n");
  await safeSendEmail({
    to: BUDGET_ACCEPTED_EMAIL,
    replyTo: conv.customer_email || undefined,
    subject: `Presupuesto aceptado — ${conv.customer_name || "lead"} — ${budget.amount_eur} EUR`,
    text: summary,
  }, "budget/accept");
  return budget;
}

// Verificación del webhook
app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[whatsapp] webhook verificado");
    return res.status(200).send(challenge);
  }
  console.warn("[whatsapp] verificación fallida");
  return res.sendStatus(403);
});

// Recepción de mensajes
app.post("/api/whatsapp/webhook", async (req, res) => {
  const webhookStartedAt = Date.now();
  // Salida rápida: si NO es un evento de mensajes reales, contestar 200 y salir
  // (evita que tests de Meta con account_alerts/etc dejen procesos colgados)
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const field = req.body?.entry?.[0]?.changes?.[0]?.field;
  const messages = value?.messages || [];
  if (field !== "messages" || messages.length === 0) {
    console.log(`[whatsapp] evento ignorado (field=${field}, sin messages)`);
    return res.sendStatus(200);
  }

  const finish = (status = 200) => {
    if (!res.headersSent) res.sendStatus(status);
  };

  try {
    if (process.env.WHATSAPP_APP_SECRET) {
      const sig = req.headers["x-hub-signature-256"];
      if (!wa.verifyWebhookSignature(req.rawBody, sig, process.env.WHATSAPP_APP_SECRET)) {
        console.warn("[whatsapp] firma inválida, ignorado");
        return;
      }
    }

    const wamsg = messages[0];
    const from = wamsg.from;
    const msgType = wamsg.type;
    const contactName = value.contacts?.[0]?.profile?.name || null;
    const waMessageId = wamsg.id || "sin-id";
    console.log(`[whatsapp] recibido ${msgType} ${waMessageId} de ${from}`);
    wa.markAsRead(wamsg.id);

    let userMessage = "";
    let imageBuffer = null;
    let imageMime = null;

    if (msgType === "text") {
      userMessage = wamsg.text?.body || "";
    } else if (msgType === "image") {
      try {
        const dl = await wa.downloadMedia(wamsg.image.id);
        imageBuffer = dl.buffer;
        imageMime = dl.mimeType;
        userMessage = wamsg.image?.caption || "";
      } catch (err) {
        console.error("[whatsapp] error descargando imagen:", err.message);
        userMessage = wamsg.image?.caption || "(imagen no procesable)";
      }
    } else {
      userMessage = `(tipo de mensaje no soportado: ${msgType})`;
    }

    let conv = await loadConversationByPhone(from);
    if (!conv) {
      const newToken = generateToken();
      const { data, error } = await supabase
        .from("bot_conversations")
        .insert({
          customer_name: contactName,
          customer_phone: from,
          source: "whatsapp",
          channel: "whatsapp",
          access_token: newToken,
        })
        .select()
        .single();
      if (error) throw error;
      conv = { ...data, messages: [] };
    }

    if (conv.status === "closed") return;

    let imageUrl = null;
    if (imageBuffer) {
      const ext = (imageMime.split("/")[1] || "jpg").replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
      const fileName = `${conv.id}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("chat-images")
        .upload(fileName, imageBuffer, { contentType: imageMime, upsert: false });
      if (!upErr) {
        const { data: pub } = supabase.storage.from("chat-images").getPublicUrl(fileName);
        imageUrl = pub.publicUrl;
      } else {
        console.warn("[whatsapp] error subiendo imagen:", upErr.message);
      }
    }

    if (ACCEPT_BUDGET_REGEX.test(userMessage)) {
      const pending = await fetchLatestPendingBudget(conv.id);
      if (pending) {
        await supabase.from("bot_messages").insert({
          conversation_id: conv.id,
          role: "user",
          content: userMessage,
          image_url: imageUrl,
        });
        const confirmation = await fetchBudgetConfirmation(pending.id);
        if (confirmation && !confirmation.confirmed_at) {
          const confirmText = buildEmailConfirmationRequiredMessage(confirmation);
          await supabase.from("bot_messages").insert({
            conversation_id: conv.id,
            role: "assistant",
            content: confirmText,
          });
          const sendStartedAt = Date.now();
          const sendResult = await wa.sendText(from, confirmText);
          console.log(
            `[whatsapp] confirmacion email pendiente ${waMessageId} respondida en ${Date.now() - sendStartedAt}ms ` +
              `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
          );
          return;
        }
        await acceptBudgetInternal(pending.id);
        const confirmText =
          "He registrado tu aceptación del presupuesto orientativo. Luis, de Renoveplac, se pondrá en contacto contigo en breve para coordinar la visita técnica y cerrar el presupuesto definitivo. ¡Un saludo!";
        await supabase.from("bot_messages").insert({
          conversation_id: conv.id,
          role: "assistant",
          content: confirmText,
        });
        const sendStartedAt = Date.now();
        const sendResult = await wa.sendText(from, confirmText);
        console.log(
          `[whatsapp] confirmacion ${waMessageId} enviada en ${Date.now() - sendStartedAt}ms ` +
            `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
        );
        return;
      }
    }

    const previousMessages = conv.messages || [];
    const { data: userMsgRow, error: userMsgError } = await supabase.from("bot_messages").insert({
      conversation_id: conv.id,
      role: "user",
      content: userMessage || (imageUrl ? "(imagen)" : ""),
      image_url: imageUrl,
    })
      .select("id, role, content, image_url, created_at")
      .single();
    if (userMsgError) throw userMsgError;
    const messagesWithCurrent = [
      ...previousMessages,
      userMsgRow || {
        role: "user",
        content: userMessage || (imageUrl ? "(imagen)" : ""),
        image_url: imageUrl,
      },
    ];

    if (conv.bot_enabled !== false && ownerPermissionDeniedByLatestReply(userMessage, previousMessages)) {
      const reply = ownerPermissionDeniedMessage();
      await supabase.from("bot_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: reply,
      });
      const sendStartedAt = Date.now();
      const sendResult = await wa.sendText(from, reply);
      console.log(
        `[whatsapp] ${waMessageId}: permiso propietario denegado respondido en ${Date.now() - sendStartedAt}ms ` +
          `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
      );
      return;
    }

    const leadPatch = buildLeadPatch(conv, userMessage, messagesWithCurrent);
    await updateLeadData(conv, leadPatch);

    if (conv.bot_enabled === false) return;

    if (isBudgetViewRequest(userMessage)) {
      const pendingBudget = await fetchLatestPendingBudget(conv.id);
      if (pendingBudget) {
        const confirmation = await fetchBudgetConfirmation(pendingBudget.id);
        if (confirmation && !confirmation.confirmed_at) {
          const reply = buildEmailConfirmationRequiredMessage(confirmation);
          await supabase.from("bot_messages").insert({
            conversation_id: conv.id,
            role: "assistant",
            content: reply,
          });
          const sendStartedAt = Date.now();
          const sendResult = await wa.sendText(from, reply);
          console.log(
            `[whatsapp] ${waMessageId}: presupuesto pendiente de email respondido en ${Date.now() - sendStartedAt}ms ` +
              `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
          );
          return;
        }

        const sendStartedAt = Date.now();
        const delivery = await sendBudgetToWhatsapp(
          conv,
          pendingBudget,
          {
            allowDuplicate: true,
            intro: "Claro. Te dejo por aquí el presupuesto orientativo:",
          }
        );
        console.log(
          `[whatsapp] ${waMessageId}: presupuesto reenviado en ${Date.now() - sendStartedAt}ms ` +
            `(total ${Date.now() - webhookStartedAt}ms, ok=${!!delivery.ok})`
        );
        return;
      }
    }

    if (isHumanHandoffRequest(userMessage)) {
      try {
        const result = await requestHumanHandoff(
          { ...conv, messages: messagesWithCurrent },
          { reason: "El cliente pide hablar con una persona por WhatsApp" }
        );
        const sendStartedAt = Date.now();
        const sendResult = await wa.sendText(from, result.reply);
        console.log(
          `[whatsapp] ${waMessageId}: humano avisado en ${Date.now() - sendStartedAt}ms ` +
            `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
        );
      } catch (err) {
        console.error("[whatsapp/human-handoff]", err);
        const fallback = "Ahora mismo no he podido avisar al equipo automaticamente. Si puedes, intenta escribirnos de nuevo en unos minutos.";
        await supabase.from("bot_messages").insert({
          conversation_id: conv.id,
          role: "assistant",
          content: fallback,
        });
        await wa.sendText(from, fallback);
      }
      return;
    }

    const fastPendingReply = getFastWhatsappPendingReply(userMessage, { ...conv, messages: previousMessages });
    if (fastPendingReply) {
      await supabase.from("bot_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: fastPendingReply,
      });
      const sendStartedAt = Date.now();
      const sendResult = await wa.sendText(from, fastPendingReply);
      console.log(
        `[whatsapp] ${waMessageId}: recordatorio rapido enviado en ${Date.now() - sendStartedAt}ms ` +
          `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
      );
      return;
    }

    const fastGreetingReply = getFastWhatsappGreetingReply(userMessage, { ...conv, messages: previousMessages });
    if (fastGreetingReply) {
      await supabase.from("bot_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: fastGreetingReply,
      });
      const sendStartedAt = Date.now();
      const sendResult = await wa.sendText(from, fastGreetingReply);
      console.log(
        `[whatsapp] ${waMessageId}: saludo rapido enviado en ${Date.now() - sendStartedAt}ms ` +
          `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
      );
      return;
    }

    const phoneStatus = getPhoneSubmissionStatus(userMessage);
    const phoneAttempted =
      !leadPatch.customer_email &&
      (phoneStatus.attempted || (botRecentlyAskedForPhone(messagesWithCurrent) && /\d/.test(userMessage)));
    if (phoneAttempted && !phoneStatus.valid) {
      await supabase.from("bot_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: INVALID_PHONE_REPLY,
      });
      const sendStartedAt = Date.now();
      const sendResult = await wa.sendText(from, INVALID_PHONE_REPLY);
      console.log(
        `[whatsapp] ${waMessageId}: telefono invalido respondido en ${Date.now() - sendStartedAt}ms ` +
          `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
      );
      return;
    }

    const fullConv = { ...conv, messages: messagesWithCurrent };
    const systemPrompt = buildSystemPrompt(
      buildContext(fullConv) +
        "\nCANAL: WhatsApp. El cliente NO tiene botones; para aceptar un presupuesto debe responder 'ACEPTO'." +
        "\nSi ya tienes datos suficientes y el cliente pide presupuesto, usa create_budget en este mismo turno. No respondas que lo prepararas mas tarde."
    );
    const modelMessages = prepareWhatsappModelMessages(fullConv?.messages || [], {
      forceLatestUserImage: msgType === "image" && !!imageUrl,
    });
    const history = toAnthropicMessages(modelMessages);
    const imageCount = modelMessages.filter((msg) => msg.image_url).length;
    console.log(
      `[whatsapp] ${waMessageId}: enviando ${history.length} mensajes de historial ` +
        `(${imageCount} imagenes) al modelo`
    );

    const modelStartedAt = Date.now();
    let result = await runConversation({
      systemPrompt,
      messages: history,
      onBudget: (input) => createConversationBudget(input, conv, fullConv),
      onNotifyHuman: (input) => notifyHumanFromWhatsapp(input, conv, from),
      maxTokens: WHATSAPP_MAX_TOKENS,
      stopAfterBudget: true,
    });

    if (!result.budget && looksLikeBudgetPreparationPromise(result.text)) {
      console.warn(`[whatsapp] ${waMessageId}: el modelo prometio presupuesto sin herramienta; forzando create_budget`);
      const forcedSystemPrompt =
        systemPrompt +
        "\n\nINSTRUCCION CRITICA DEL SERVIDOR: no dejes al cliente esperando. Si estan los datos obligatorios, llama ahora a create_budget. Si falta un dato, pide solo ese dato concreto.";
      result = await runConversation({
        systemPrompt: forcedSystemPrompt,
        messages: [
          ...history,
          { role: "assistant", content: String(result.text || "").slice(0, 1200) },
          {
            role: "user",
            content:
              "No prometas preparar el presupuesto mas tarde. Genera ahora el presupuesto con create_budget si tienes los datos obligatorios; si falta algo, dime exactamente que falta.",
          },
        ],
        onBudget: (input) => createConversationBudget(input, conv, fullConv),
        onNotifyHuman: (input) => notifyHumanFromWhatsapp(input, conv, from),
        maxTokens: Math.max(WHATSAPP_MAX_TOKENS, 650),
        stopAfterBudget: true,
      });
    }
    console.log(`[whatsapp] ${waMessageId}: modelo listo en ${Date.now() - modelStartedAt}ms`);

    let botReply = result.text || "";
    if (result.budget) {
      if (result.budget.email_confirmation) {
        botReply = buildBudgetConfirmationMessage(result.budget.email_confirmation, "whatsapp");
      } else {
        const b = result.budget;
        const ivaTxt = b.iva_included ? "(IVA incluido)" : "+ IVA aparte";
        const card =
          "\n\n━━━━━━━━━━━━━━━━━━\n" +
          `📋 *PRESUPUESTO ORIENTATIVO*\n` +
          `*${b.title}*\n` +
          `Importe: *${Number(b.amount_eur).toLocaleString("es-ES")} €* ${ivaTxt}\n\n` +
          `${b.description}\n` +
          "━━━━━━━━━━━━━━━━━━\n\n" +
          `Si te encaja, responde *ACEPTO* y Luis te llamará para coordinar la visita técnica.`;
        botReply = (botReply ? botReply + "\n" : "") + card;
      }
    } else if (
      looksLikeBlockedBudgetReply(botReply) ||
      looksLikeBudgetPreparationPromise(botReply) ||
      looksLikeBatchContactDataRequest(botReply) ||
      (getMissingBudgetContactFields(fullConv).length && looksLikeOwnerPermissionQuestion(botReply))
    ) {
      botReply = buildPreBudgetGuardReplyStrict(fullConv);
    }
    if (!result.budget && looksLikeNoPhotoPermissionConfusion(botReply, userMessage)) {
      botReply = buildNoPhotoContinueReply(fullConv);
    }

    if (botReply) {
      await supabase.from("bot_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: botReply,
      });
      const sendStartedAt = Date.now();
      const sendResult = await wa.sendText(from, botReply);
      console.log(
        `[whatsapp] ${waMessageId}: respuesta enviada en ${Date.now() - sendStartedAt}ms ` +
          `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
      );
    }
  } catch (err) {
    console.error("[whatsapp/webhook]", err);
  } finally {
    finish();
  }
});

app.listen(port, () => {
  console.log(`Renovebot listo en ${PUBLIC_URL} (puerto ${port})`);
});

module.exports = app;
