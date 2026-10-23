require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");

const { supabase, SUPABASE_URL } = require("./lib/db");
const { sendEmail } = require("./lib/email");
const { buildSystemPrompt, getSpanishGreeting } = require("./lib/prompt");
const { runConversation } = require("./lib/claude");
const { INVALID_PHONE_REPLY, extractSpanishPhone, getPhoneSubmissionStatus, normalizeSpanishPhone } = require("./lib/phone");
const { OUT_OF_AREA_REPLY, findElectricOnlyTown, findExcludedTown } = require("./lib/zones");
const {
  buildLeadPatch,
  buildLeadPatchFromMessages,
  inferElectricWorkType,
  isElectricWorkType,
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
const COMPANY_NAME = "Equipo de Renoveplac";
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
  const electricWorkType = inferElectricWorkType(text);
  if (electricWorkType && !/\b(reforma integral|vivienda completa|casa completa|piso completo|bano|banos|cocina|cocinas|piscina|piscinas)\b/.test(text)) {
    return electricWorkType;
  }
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
  const media = isElectricWorkType(workType)
    ? "fotos o un video corto de la zona del trabajo, el cuadro electrico o el contador"
    : "fotos o un video corto de la zona del trabajo";
  const nextStep =
    "Para preparar tu presupuesto, dime el pueblo y la direccion de la obra (si puedes, con la ubicacion de Google Maps o de WhatsApp) " +
    `y que necesitas exactamente. Si puedes, enviame tambien ${media}.`;
  return (
    `${getSpanishGreeting()}${introName}, soy Renovebot, el asistente de Renoveplac. Hemos recibido tu solicitud${workText} desde la web.` +
    `${zoneText}${messageText}\n\n` +
    nextStep
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
  if (conv.customer_town) parts.push(`Pueblo de la obra: ${conv.customer_town}`);
  if (conv.work_address) parts.push(`Direccion de la obra: ${conv.work_address}`);
  if (conv.lead_source) parts.push(`Como nos ha conocido: ${conv.lead_source}`);
  const excludedTown = findExcludedTown(conv.customer_postal_code) || findExcludedTown(conv.customer_town);
  if (excludedTown) {
    parts.push(`AVISO: la zona del cliente corresponde a ${excludedTown}, donde no trabajamos. Responde con amabilidad que por ahora no damos servicio en esa zona.`);
  }
  if (conv.status === "request_received") {
    parts.push(
      "ESTADO: la solicitud de este cliente ya esta registrada y el equipo avisado. No vuelvas a usar register_request salvo que pida otro servicio distinto."
    );
  }
  return parts.join("\n");
}

// ---------- Solicitudes (todos los servicios) ----------
// El bot no da precios ni presupuestos: recoge los datos, comprueba la zona y
// avisa al equipo, que prepara el presupuesto detallado.

const REQUEST_CLOSING_MESSAGE =
  "Perfecto, ya tengo todo lo necesario. Un profesional de nuestro equipo revisa tu caso y te contactamos para preparar el presupuesto, sin compromiso.";
const NO_PRICE_MESSAGE = "Te preparamos un presupuesto detallado por partidas, sin compromiso.";
const COMPANY_PHONE_TEXT = "631 18 88 13";
const OPTIONAL_LEAD_FIELDS = ["work_address", "lead_source"];

const PRICE_PATTERNS = [
  /\d(?:[\d.\s]*\d)?(?:[,.]\d{1,2})?\s*(?:€|eur\b|euros?\b)/i,
  /€\s*\d/,
  /\bdesde\s+\d/i,
  /\bentre\s+\d[\d.]*\s+(?:y|a)\s+\d/i,
];
const DEADLINE_PATTERNS = [
  /\b24\s*(?:h|horas)\b/i,
  /\bma[nñ]ana mismo\b/i,
  /\b(?:servicio|atencion|atención) (?:urgente|24)/i,
  /\b(?:en|unos|unas|de|durante|dura|tarda|tardamos|tardaremos)\s+(?:\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|diez|quince)(?:\s*(?:o|a|-)\s*(?:\d+|dos|tres|cuatro|cinco|seis))?\s*(?:h|horas?|d[ií]as?|semanas?|mes(?:es)?)\b/i,
];

function looksLikePriceText(text) {
  return PRICE_PATTERNS.some((pattern) => pattern.test(String(text || "")));
}

// Quita del mensaje del modelo las frases con precios o plazos. Si habia precio,
// lo sustituye por la frase de presupuesto detallado.
function sanitizeBotReply(reply) {
  const raw = String(reply || "").trim();
  if (!raw) return raw;
  let removedPrice = false;
  const paragraphs = raw.split("\n").map((paragraph) => {
    const sentences = paragraph.match(/(?:[^.!?]|[.!?](?!\s|$))+[.!?]*(?:\s+|$)/g) || [paragraph];
    return sentences
      .filter((sentence) => {
        if (looksLikePriceText(sentence)) {
          removedPrice = true;
          return false;
        }
        return !DEADLINE_PATTERNS.some((pattern) => pattern.test(sentence));
      })
      .join("")
      .trim();
  });
  let clean = paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (removedPrice && !clean.includes(NO_PRICE_MESSAGE)) {
    clean = clean ? `${NO_PRICE_MESSAGE}\n\n${clean}` : NO_PRICE_MESSAGE;
  }
  return clean || NO_PRICE_MESSAGE;
}

function phoneDigits9(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : "";
}

function hasValidCustomerPhone(conv) {
  const raw = String(conv?.customer_phone || "").replace(/\s+/g, "");
  return Boolean(normalizeSpanishPhone(raw) || /^34[6-9]\d{8}$/.test(raw));
}

function hasValidCustomerName(conv) {
  return Boolean(conv?.customer_name && !isLikelyInvalidCustomerName(conv.customer_name));
}

function conversationMentionsPhone(conv, phone) {
  const target = phoneDigits9(phone);
  if (!target) return false;
  if (phoneDigits9(conv?.customer_phone) === target) return true;
  return (conv?.messages || []).some(
    (msg) => msg.role === "user" && String(msg.content || "").replace(/\D/g, "").includes(target)
  );
}

async function updateConversationWithOptionalFields(conv, patch) {
  const { error } = await supabase.from("bot_conversations").update(patch).eq("id", conv.id);
  if (!error) {
    Object.assign(conv, patch);
    return { savedOptionalFields: true };
  }
  // Si aun no se ha ejecutado sql/electricidad.sql, guarda al menos los campos base.
  const basePatch = Object.fromEntries(Object.entries(patch).filter(([key]) => !OPTIONAL_LEAD_FIELDS.includes(key)));
  console.warn(`[solicitud] No se pudieron guardar direccion/origen (${conv.id}): ${error.message}`);
  if (Object.keys(basePatch).length) {
    const { error: baseError } = await supabase.from("bot_conversations").update(basePatch).eq("id", conv.id);
    if (baseError) throw baseError;
  }
  Object.assign(conv, patch);
  return { savedOptionalFields: false };
}

async function registerRequest(input, conv, fullConv, channel) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const category = input?.category === "electricidad" ? "electricidad" : "reformas_obra";
  const service = clean(input?.service).slice(0, 80);
  const need = clean(input?.need);
  const town = clean(input?.town);
  const address = clean(input?.address);
  const location = clean(input?.location);
  const name = clean(input?.customer_name);
  const leadSource = clean(input?.lead_source);
  const phone = extractSpanishPhone(input?.phone);
  const messages = fullConv?.messages || conv.messages || [];

  if (service.length < 3 || need.length < 3) throw new Error("Falta que necesita el cliente. Preguntaselo.");
  if (town.length < 2) throw new Error("Falta el pueblo de la obra. Pideselo y compruebalo con las zonas antes de seguir.");
  const excludedTown = findExcludedTown(town);
  if (excludedTown) {
    throw new Error(`No trabajamos en ${excludedTown}. Responde exactamente: "${OUT_OF_AREA_REPLY}"`);
  }
  const electricOnlyTown = findElectricOnlyTown(town);
  if (electricOnlyTown && category !== "electricidad") {
    throw new Error(
      `En ${electricOnlyTown} solo hacemos electricidad, no reformas ni obra. Responde exactamente: "${OUT_OF_AREA_REPLY}"`
    );
  }
  if (address.length < 3) throw new Error("Falta la direccion de la obra. Pidesela al cliente.");
  const currentName = hasValidCustomerName(conv) ? conv.customer_name : "";
  if (!currentName && (!name || isLikelyInvalidCustomerName(name))) {
    throw new Error("Falta el nombre del cliente. Pideselo antes de registrar la solicitud.");
  }
  if (!phone || !conversationMentionsPhone(fullConv || conv, phone)) {
    throw new Error("Falta un telefono valido que el cliente haya dado (9 cifras o +34). Pideselo antes de registrar la solicitud.");
  }
  const permissionStatus = getOwnerPermissionStatus(messages);
  if (permissionStatus === "denied") {
    throw new Error("El cliente no es propietario ni tiene permiso del propietario: no se puede realizar el servicio. Explicaselo con amabilidad.");
  }
  if (input?.owner_confirmed !== true) {
    throw new Error("Falta confirmar si es el propietario o tiene permiso del propietario. Preguntaselo.");
  }
  if (leadSource.length < 2) throw new Error("Falta como nos ha conocido. Preguntale: ¿Como nos has conocido?");

  const fullAddress = location ? `${address} · ${location}` : address;
  const patch = {
    work_type: service,
    status: "request_received",
    work_address: fullAddress,
    lead_source: leadSource,
  };
  if (!currentName) patch.customer_name = name;
  if (!conv.customer_phone) patch.customer_phone = phone;
  const saved = await updateConversationWithOptionalFields(conv, patch);
  if (fullConv && fullConv !== conv) Object.assign(fullConv, patch);

  const channelLabel = channel === "whatsapp" ? "WhatsApp" : conv.source === "form" ? "Formulario web" : "Chat web";
  const lines = [
    "Nueva solicitud de presupuesto recogida por el bot (sin precio: hay que preparar el presupuesto detallado).",
    "",
    `Tipo: ${category === "electricidad" ? "Electricidad" : "Reformas y obra"}`,
    `Servicio: ${service}`,
    `Que necesita: ${need}`,
    "",
    "Datos del cliente:",
    `- Nombre: ${currentName || name}`,
    `- Telefono: ${phone}`,
    `- Pueblo (comprobado): ${town}`,
    `- Direccion de la obra: ${address}`,
    `- Ubicacion: ${location || "(no enviada)"}`,
    `- Fotos o video: ${input?.media_sent ? "si" : "no"}`,
    "- Propietario o con permiso: si",
    `- Como nos ha conocido: ${leadSource}`,
    `- Email: ${conv.customer_email || "(sin email)"}`,
    `- Canal: ${channelLabel}`,
    saved.savedOptionalFields ? "" : "\nAviso: ejecuta sql/electricidad.sql en Supabase para guardar direccion y origen en el panel.",
    "",
    `Conversacion completa: ${PUBLIC_URL}/admin#${conv.id}`,
  ].join("\n");

  await safeSendEmail({
    to: COMPANY_EMAIL,
    replyTo: conv.customer_email || undefined,
    subject: `Nueva solicitud - ${service} - ${currentName || name} (${town})`,
    text: lines,
  }, "solicitud");

  return { ok: true, service, category };
}

// Ultimo paso comun (web y WhatsApp) sobre la respuesta del modelo.
function finalizeBotReply(result, userMessage, conv) {
  if (result.request) return REQUEST_CLOSING_MESSAGE;
  let botReply = sanitizeBotReply(result.text || "");
  if (looksLikeNoPhotoPermissionConfusion(botReply, userMessage)) {
    botReply = buildNoPhotoContinueReply(conv);
  }
  if (looksLikeAppointmentSchedulingReply(botReply)) {
    botReply = buildAppointmentSchedulingReply(conv);
  }
  return addServiceInfoLinks(botReply, userMessage, conv);
}

const BOLETIN_INFO_LINE = "Puedes encontrar más información en: renoveplac.com/boletin-electrico-cie/";
const SOLAR_SIMULATOR_LINE =
  "Para un precio orientativo, puedes usar nuestro simulador gratuito: renoveplac.com/placas-solares/";

function asksAboutBoletin(message) {
  return /\bbolet[ií]n|\bcie\b|certificado (?:de )?instalaci[oó]n el[eé]ctrica/i.test(String(message || ""));
}

function asksAboutSolarPanels(message, conv) {
  const text = normalizeLooseText(message);
  if (!text) return false;
  if (inferElectricWorkType(message) === "Placas solares") return true;
  // "¿Cuanto cuestan las placas?" cuando la conversacion ya es de placas solares.
  return normalizeWorkType(conv?.work_type) === "Placas solares" &&
    /\bplacas?\b/.test(text) && !/\b(pladur|yeso|escayola)\b/.test(text);
}

// Boletin: la frase con el enlace siempre al final del mensaje.
// Placas solares: enlace al simulador, salvo para pisos o comunidades (no se hacen).
function addServiceInfoLinks(reply, userMessage, conv) {
  let text = String(reply || "").trim();
  if (!text) return text;
  const solarNotOffered = /\b(comunidad|comunidades|vecinos|piso|pisos|edificio|bloque)\b/.test(normalizeLooseText(userMessage));
  if (asksAboutSolarPanels(userMessage, conv) && !solarNotOffered && !text.includes("renoveplac.com/placas-solares")) {
    text = `${text}\n\n${SOLAR_SIMULATOR_LINE}`;
  }
  if (asksAboutBoletin(userMessage)) {
    text = `${text.split(BOLETIN_INFO_LINE).join("").trim()}\n\n${BOLETIN_INFO_LINE}`;
  }
  return text;
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
  return `${getSpanishGreeting()}, soy Renovebot, de Renoveplac. Cuentame que necesitas (una reforma, una obra o un trabajo de electricidad) y en que zona seria.`;
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
  const greeting = `${getSpanishGreeting()}${firstName ? `, ${firstName}` : ""}.`;

  if (/\btelefono|movil|whatsapp|numero\b/.test(pending)) {
    return `${greeting}\n\nPara seguir necesito tu telefono con 9 cifras, por ejemplo 612 345 678, o con prefijo +34.`;
  }
  if (/\bnombre\b|\bcomo te llamas\b/.test(pending)) {
    return `${greeting}\n\nPara seguir necesito tu nombre.`;
  }
  if (/\bpropietari[oa]\b|\bpermiso\b/.test(pending)) {
    return `${greeting}\n\nPara seguir necesito saber si eres el propietario o tienes permiso del propietario.`;
  }
  if (/\bdireccion\b|\bpueblo\b|\bubicacion\b/.test(pending)) {
    return `${greeting}\n\nPara seguir necesito el pueblo y la direccion de la obra.`;
  }
  if (/\bconocido\b/.test(pending)) {
    return `${greeting}\n\nPor ultimo, ¿como nos has conocido? (Google, Instagram, recomendacion...)`;
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
      text.includes("he avisado a un profesional") ||
      text.includes("te contacta lo antes posible") ||
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
      text.includes("he avisado a un profesional") ||
      text.includes("te contacta lo antes posible") ||
      text.includes("bot queda pausado") ||
      text.includes("persona del equipo pueda revisar") ||
      text.includes("hablar con un humano");
    if (isHumanWait) map.set(message.conversation_id, true);
  });

  return map;
}

async function fetchBudgetSummaryMap(conversationIds) {
  const ids = [...new Set((conversationIds || []).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;

  const { data, error } = await supabase
    .from("bot_budgets")
    .select("id, conversation_id, amount_eur, status, created_at")
    .in("conversation_id", ids)
    .order("created_at", { ascending: true });

  if (error) {
    console.warn("[admin/conversations] No se pudo calcular resumen de presupuestos:", error.message);
    return map;
  }

  const budgets = data || [];
  const confirmations = await fetchBudgetConfirmations(budgets.map((budget) => budget.id));
  budgets.forEach((budget) => {
    const confirmation = confirmations.get(budget.id);
    const current = map.get(budget.conversation_id) || {
      budget_count: 0,
      pending_budget_count: 0,
      unconfirmed_budget_count: 0,
      latest_budget_amount_eur: null,
      latest_budget_created_at: null,
    };

    current.budget_count += 1;
    if (budget.status === "pending") current.pending_budget_count += 1;
    if (confirmation && !confirmation.confirmed_at) current.unconfirmed_budget_count += 1;
    current.latest_budget_amount_eur = budget.amount_eur;
    current.latest_budget_created_at = budget.created_at;
    map.set(budget.conversation_id, current);
  });

  return map;
}

function formatAdminWhatsappMessage(content) {
  const text = String(content || "").trim();
  return [
    "*Equipo de Renoveplac*",
    "Mensaje del equipo",
    "",
    text,
  ].join("\n");
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
    "Lo entiendo. En ese caso no podemos realizar el servicio, porque necesitamos que seas el propietario " +
    "o tengas permiso del propietario.\n\n" +
    "Si más adelante tienes esa autorización, estaremos encantados de ayudarte. ¡Gracias por pensar en nosotros!"
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
    `${prefix}no pasa nada si ahora no puedes enviar fotos. ` +
    "Un profesional de nuestro equipo lo revisara con los datos que me des. Seguimos con lo que falta."
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

function hasAppointmentTimeReference(text) {
  return (
    /\b(hoy|manana|pasado manana|esta manana|esta tarde|esta noche|lunes|martes|miercoles|jueves|viernes|sabado|domingo|finde|fin de semana)\b/.test(text) ||
    /\b(?:a|sobre)\s+las?\s+\d{1,2}(?::\d{2})?\b/.test(text) ||
    /\b\d{1,2}:\d{2}\b/.test(text) ||
    /\b(?:[01]?\d|2[0-3])\s*h\b/.test(text) ||
    /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(text)
  );
}

function looksLikeAppointmentSchedulingReply(reply) {
  const text = normalizeLooseText(reply);
  if (!text) return false;

  const delegatesToTeam =
    /\b(luis|profesional|equipo)\b.{0,120}\b(se pondra en contacto|contactara|te llamara|coordinara|coordinar|agendar)\b/.test(text) ||
    /\b(se pondra en contacto|contactara|te llamara)\b.{0,120}\b(luis|profesional|equipo)\b/.test(text);
  const refusesScheduling =
    /\b(no puedo|no podemos)\b.{0,90}\b(cerrar|confirmar|agendar|reservar|programar)\b.{0,50}\b(cita|horario|hora|visita)\b/.test(text);
  if (delegatesToTeam || refusesScheduling) return false;

  const claimsAppointment =
    /\b(nos vemos|quedamos|te veo|os veo|me paso|nos pasamos|pasamos|iremos|puedo ir|podemos ir|te visitamos)\b/.test(text);
  const movementAppointment =
    /\b(voy|vamos)\b.{0,35}\b(ir|pasar|verlo|visitar|casa|obra|vivienda|piso|local)\b/.test(text);
  const directConfirmation =
    /\b(cita|visita)\b.{0,45}\b(confirmada|agendada|cerrada|reservada|programada)\b/.test(text);
  const proposesSlot =
    /\b(te va bien|os va bien|puedes|podrias|podeis|podemos|tienes disponibilidad|te encaja)\b.{0,90}\b(a las|hoy|manana|esta tarde|esta manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|hora)\b/.test(text);
  const timedScheduling = hasAppointmentTimeReference(text) &&
    /\b(cita|visita|quedar|quedamos|paso|pasamos|voy|vamos|iremos|puedo ir|podemos ir)\b/.test(text);

  return claimsAppointment || movementAppointment || directConfirmation || proposesSlot || timedScheduling;
}

function isAppointmentSchedulingRequest(message, messages = []) {
  const text = normalizeLooseText(message);
  if (!text) return false;
  if (/\b(no quiero|no necesito|no hace falta|sin)\b.{0,30}\b(cita|visita)\b/.test(text)) return false;

  const asksAppointment =
    /\b(cita|visita)\b/.test(text) &&
    /\b(quiero|necesito|pedir|solicitar|agendar|agenda|programar|concertar|reservar|cerrar|quedar|quedamos|cuando|hora|horario|dia|venir|venis|vengais|pasar|podeis|podemos|podrias|puedes|puede)\b/.test(text);
  const explicitSchedule =
    /\b(agendar|agenda|programar|concertar|reservar|cerrar)\b.{0,45}\b(cita|visita|hora|horario|dia|llamada)\b/.test(text);
  const asksSchedulingContact =
    /\b(agendar|agenda|programar|concertar|reservar|cerrar)\b/.test(text) &&
    /\b(luis|llamar|llamen|contactar|contacte|contacto|visita|cita|hora|horario|dia)\b/.test(text);
  const asksVisitToProperty =
    /\b(podeis|podemos|podrias|puedes|puede|venis|vengais|pasais|pasar|venir)\b.{0,60}\b(verlo|ver la obra|tomar medidas|presupuestar|casa|vivienda|piso|local)\b/.test(text);
  const asksWhenCanVisit =
    /\b(cuando|que dia|a que hora|disponibilidad|hueco|fecha|fechas)\b.{0,70}\b(podeis|podemos|podrias|puedes|puede|venis|vengais|pasais|pasar|venir|visita|cita)\b/.test(text) ||
    /\b(podeis|podemos|podrias|puedes|puede|venis|vengais|pasais|pasar|venir|visita|cita)\b.{0,70}\b(cuando|que dia|a que hora|disponibilidad|hueco|fecha|fechas)\b/.test(text);
  const proposesSlot =
    hasAppointmentTimeReference(text) &&
    /\b(cita|visita|quedar|quedamos|venir|venis|vengais|pasar|pasais|podeis|podemos|te espero|os espero)\b/.test(text);

  const lastAssistant = getLastAssistantText(messages);
  const confirmsPreviousSlot =
    looksLikeAppointmentSchedulingReply(lastAssistant) &&
    (hasAppointmentTimeReference(text) || /^(si|vale|ok|perfecto|correcto|confirmo|me va bien|de acuerdo)\b/.test(text));

  return asksAppointment || explicitSchedule || asksSchedulingContact || asksVisitToProperty || asksWhenCanVisit || proposesSlot || confirmsPreviousSlot;
}

const HUMAN_CONTACT_MARKER = "un profesional de nuestro equipo te contacta";

function buildHumanContactRequest(conv) {
  const needName = !hasValidCustomerName(conv);
  const needPhone = !hasValidCustomerPhone(conv);
  const what = needName && needPhone ? "tu nombre y teléfono" : needName ? "tu nombre" : "tu teléfono";
  return (
    `Claro. Déjame ${what} y un profesional de nuestro equipo te contacta. ` +
    `También puedes llamarnos o escribirnos por WhatsApp al ${COMPANY_PHONE_TEXT}.`
  );
}

function buildHumanHandoffConfirmedMessage(conv) {
  const firstName = getFirstName(conv);
  return (
    `Gracias${firstName ? `, ${firstName}` : ""}. Un profesional de nuestro equipo te contacta lo antes posible. ` +
    `También puedes llamarnos o escribirnos por WhatsApp al ${COMPANY_PHONE_TEXT}.`
  );
}

function isPendingHumanContact(messages) {
  const assistants = (messages || []).filter((msg) => msg.role === "assistant").slice(-2);
  return assistants.some((msg) => {
    const text = normalizeLooseText(msg.content || "");
    return text.startsWith("claro. dejame") && text.includes(HUMAN_CONTACT_MARKER);
  });
}

// "Quiero hablar con una persona": pide nombre y telefono (solo los que falten) y,
// cuando estan, avisa al equipo por email y pausa el bot.
async function handleHumanContactRequest(conv, userMessage, previousMessages, leadPatch) {
  const asks = isHumanHandoffRequest(userMessage);
  const pending = !asks && isPendingHumanContact(previousMessages);
  if (!asks && !pending) return null;
  const gaveContactData = Boolean(leadPatch?.customer_name || leadPatch?.customer_phone);
  if (pending && !gaveContactData) return null;

  if (hasValidCustomerName(conv) && hasValidCustomerPhone(conv)) {
    try {
      const result = await requestHumanHandoff(conv, {
        reason: "El cliente pide hablar con una persona",
        reply: buildHumanHandoffConfirmedMessage(conv),
      });
      return { ...result, botEnabled: false };
    } catch (err) {
      console.error("[human-contact]", err);
      return insertAssistantReply(
        conv,
        `Ahora mismo no he podido avisar al equipo. Puedes llamarnos o escribirnos por WhatsApp al ${COMPANY_PHONE_TEXT}.`
      );
    }
  }
  return insertAssistantReply(conv, buildHumanContactRequest(conv));
}

async function insertAssistantReply(conv, reply) {
  const { data: assistantMsgRow } = await supabase
    .from("bot_messages")
    .insert({
      conversation_id: conv.id,
      role: "assistant",
      content: reply,
    })
    .select()
    .single();
  return { reply, assistantMsgRow, botEnabled: conv.bot_enabled !== false };
}

function buildAppointmentSchedulingReply(conv) {
  const firstName = getFirstName(conv);
  const prefix = firstName ? `${firstName}, ` : "";
  const next = conv?.status === "request_received"
    ? ""
    : " Mientras, sigamos con los datos que me faltan para preparar tu presupuesto.";
  return (
    `${prefix}no puedo cerrar citas ni dar fechas desde el chat: ` +
    `un profesional de nuestro equipo te contactará para concretarlo.${next}`
  );
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
    "Si te encaja, responde *ACEPTO* y un profesional de nuestro equipo coordinará contigo la visita técnica.",
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

async function notifyHumanFromWeb(input, conv) {
  const reasonLabel = ({
    queja: "Queja / reclamacion",
    solicita_humano: "El cliente pide hablar con persona",
    lead_premium: "Lead premium (administrador, presidente, arquitecto, aparejador)",
    alto_ticket: "Alto ticket (>15.000 EUR)",
    fuera_de_zona_obra_grande: "Fuera de zona pero obra grande (valorar)",
  })[input.reason] || input.reason;

  const lines = [
    "Aviso del bot: se requiere intervencion humana.",
    "",
    `Motivo: ${reasonLabel}`,
    "",
    "Resumen del bot:",
    input.summary || "(sin resumen)",
    "",
    "Datos del lead:",
    `- Nombre: ${conv.customer_name || "(sin nombre)"}`,
    `- Email: ${conv.customer_email || "(sin email)"}`,
    `- Telefono: ${conv.customer_phone || "(sin telefono)"}`,
    `- Codigo postal: ${conv.customer_postal_code || "(sin CP)"}`,
    `- Tipo de obra: ${conv.work_type || "(no especificado)"}`,
    ...(conv.customer_town ? [`- Pueblo: ${conv.customer_town}`] : []),
    ...(conv.work_address ? [`- Direccion de la obra: ${conv.work_address}`] : []),
    ...(conv.lead_source ? [`- Como nos ha conocido: ${conv.lead_source}`] : []),
    "",
    `Conversacion completa: ${PUBLIC_URL}/admin#${conv.id}`,
  ].join("\n");

  await safeSendEmail({
    to: COMPANY_EMAIL,
    replyTo: conv.customer_email || undefined,
    subject: `Aviso bot - ${reasonLabel} - ${conv.customer_name || "lead"}`,
    text: lines,
  }, "notify_human");
  return { ok: true };
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
    "Un profesional de nuestro equipo se pondrá en contacto contigo en breve para coordinar la visita técnica y cerrar el presupuesto definitivo. ¡Un saludo!";
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
    ...(conv.customer_town ? [`- Pueblo: ${conv.customer_town}`] : []),
    ...(conv.work_address ? [`- Direccion de la obra: ${conv.work_address}`] : []),
    ...(conv.lead_source ? [`- Como nos ha conocido: ${conv.lead_source}`] : []),
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
    subject: options.subject || `Cliente solicita humano - ${conv.customer_name || conv.customer_phone || "lead Renoveplac"}`,
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

  const reply = options.reply || buildHumanHandoffConfirmedMessage(conv);
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

    const reply = (result) =>
      res.json({
        reply: result.reply,
        conversationId: conv.id,
        accessToken: conv.access_token,
        botEnabled: result.botEnabled !== undefined ? result.botEnabled : conv.bot_enabled !== false,
        budget: result.budget || null,
        userMessage: userMsgRow,
        assistantMessage: result.assistantMsgRow || null,
      });

    // Presupuestos antiguos: solo se aceptan si hay uno pendiente.
    if (ACCEPT_BUDGET_REGEX.test(userMessage) && (await fetchLatestPendingBudget(conv.id))) {
      return reply(await acceptPendingBudgetFromChat(conv));
    }

    if (conv.bot_enabled !== false && ownerPermissionDeniedByLatestReply(userMessage, previousMessages)) {
      return reply(await insertAssistantReply(conv, ownerPermissionDeniedMessage()));
    }

    const leadPatch = buildLeadPatch(conv, userMessage, conv.messages || []);
    const phoneStatus = getPhoneSubmissionStatus(userMessage);
    const phoneAttempted =
      !leadPatch.customer_email &&
      (phoneStatus.attempted || (botRecentlyAskedForPhone(conv.messages) && /\d/.test(userMessage)));

    if (conv.bot_enabled !== false && phoneAttempted && !phoneStatus.valid) {
      return reply(await insertAssistantReply(conv, INVALID_PHONE_REPLY));
    }

    await updateLeadData(conv, leadPatch);

    if (conv.bot_enabled === false) {
      return reply({ reply: "", botEnabled: false });
    }

    if (findExcludedTown(userMessage)) {
      return reply(await insertAssistantReply(conv, OUT_OF_AREA_REPLY));
    }

    const humanContact = await handleHumanContactRequest(conv, userMessage, previousMessages, leadPatch);
    if (humanContact) return reply(humanContact);

    if (isAppointmentSchedulingRequest(userMessage, previousMessages)) {
      return reply(await insertAssistantReply(conv, buildAppointmentSchedulingReply(conv)));
    }

    const systemPrompt = buildSystemPrompt(buildContext(conv));
    const history = toAnthropicMessages(conv.messages || []);
    const result = await runConversation({
      systemPrompt,
      messages: history,
      onNotifyHuman: (input) => notifyHumanFromWeb(input, conv),
      onRequest: (input) => registerRequest(input, conv, conv, "web"),
    });

    const botReply = finalizeBotReply(result, userMessage, conv);
    if (!botReply) return reply({ reply: "" });
    return reply(await insertAssistantReply(conv, botReply));
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
        "He registrado tu aceptación del presupuesto orientativo. Un profesional de nuestro equipo se pondrá en contacto contigo en breve para coordinar la visita técnica y cerrar el presupuesto definitivo. Recibirás también un email de confirmación.",
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
    const budgetSummaryMap = await fetchBudgetSummaryMap(conversations.map((conv) => conv.id));
    return res.json({
      conversations: conversations.map((conv) =>
        cleanConversationForDisplay({
          ...conv,
          awaiting_human: awaitingMap.get(conv.id) || false,
          ...(budgetSummaryMap.get(conv.id) || {}),
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
  const budgetSummary = {
    budget_count: budgets.length,
    pending_budget_count: budgets.filter((budget) => budget.status === "pending").length,
    unconfirmed_budget_count: budgets.filter((budget) => budget.email_confirmation_required && !budget.email_confirmed_at).length,
    latest_budget_amount_eur: budgets.length ? budgets[budgets.length - 1].amount_eur : null,
    latest_budget_created_at: budgets.length ? budgets[budgets.length - 1].created_at : null,
  };
  return res.json({ ...cleanConversationForDisplay(conv), ...budgetSummary, budgets, lead_stats: leadStats });
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
    let videoBuffer = null;
    let videoMime = null;

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
    } else if (msgType === "video") {
      try {
        const dl = await wa.downloadMedia(wamsg.video.id);
        videoBuffer = dl.buffer;
        videoMime = dl.mimeType || "video/mp4";
      } catch (err) {
        console.error("[whatsapp] error descargando video:", err.message);
      }
      userMessage = `(vídeo)${wamsg.video?.caption ? ` ${wamsg.video.caption}` : ""}`;
    } else if (msgType === "location") {
      const loc = wamsg.location || {};
      const label = [loc.name, loc.address].filter(Boolean).join(", ");
      userMessage = `(ubicación)${label ? ` ${label}` : ""}`;
      if (loc.latitude != null && loc.longitude != null) {
        userMessage += `\nUbicación: https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
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

    if (videoBuffer) {
      const ext = (videoMime.split("/")[1] || "mp4").replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp4";
      const fileName = `${conv.id}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("chat-images")
        .upload(fileName, videoBuffer, { contentType: videoMime, upsert: false });
      if (!upErr) {
        const { data: pub } = supabase.storage.from("chat-images").getPublicUrl(fileName);
        userMessage = `${userMessage}\nVídeo: ${pub.publicUrl}`;
      } else {
        console.warn("[whatsapp] error subiendo video:", upErr.message);
        userMessage = `${userMessage}\n(No se pudo guardar el vídeo; ejecuta sql/electricidad.sql para permitir vídeos en Storage.)`;
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
          "He registrado tu aceptación del presupuesto orientativo. Un profesional de nuestro equipo se pondrá en contacto contigo en breve para coordinar la visita técnica y cerrar el presupuesto definitivo. ¡Un saludo!";
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

    // Guarda la respuesta del bot y la envia por WhatsApp.
    const sendReply = async (reply, label) => {
      await supabase.from("bot_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: reply,
      });
      const sendStartedAt = Date.now();
      const sendResult = await wa.sendText(from, reply);
      console.log(
        `[whatsapp] ${waMessageId}: ${label} en ${Date.now() - sendStartedAt}ms ` +
          `(total ${Date.now() - webhookStartedAt}ms, ok=${!!sendResult.ok})`
      );
    };

    if (conv.bot_enabled !== false && ownerPermissionDeniedByLatestReply(userMessage, previousMessages)) {
      await sendReply(ownerPermissionDeniedMessage(), "permiso propietario denegado respondido");
      return;
    }

    // Los enlaces de video o ubicacion no deben confundirse con telefonos o codigos postales.
    const parseableMessage = userMessage.replace(/\n(?:Vídeo|Ubicación): \S+/g, "");
    const leadPatch = buildLeadPatch(conv, parseableMessage, messagesWithCurrent);
    await updateLeadData(conv, leadPatch);

    if (conv.bot_enabled === false) return;

    if (findExcludedTown(parseableMessage)) {
      await sendReply(OUT_OF_AREA_REPLY, "zona sin servicio respondida");
      return;
    }

    // Presupuestos antiguos pendientes: el cliente puede pedir verlos de nuevo.
    if (isBudgetViewRequest(userMessage)) {
      const pendingBudget = await fetchLatestPendingBudget(conv.id);
      if (pendingBudget) {
        const confirmation = await fetchBudgetConfirmation(pendingBudget.id);
        if (confirmation && !confirmation.confirmed_at) {
          await sendReply(buildEmailConfirmationRequiredMessage(confirmation), "presupuesto pendiente de email respondido");
          return;
        }
        const delivery = await sendBudgetToWhatsapp(conv, pendingBudget, {
          allowDuplicate: true,
          intro: "Claro. Te dejo por aquí el presupuesto orientativo:",
        });
        console.log(`[whatsapp] ${waMessageId}: presupuesto reenviado (ok=${!!delivery.ok})`);
        return;
      }
    }

    const fullConv = { ...conv, messages: messagesWithCurrent };
    const humanContact = await handleHumanContactRequest(conv, parseableMessage, previousMessages, leadPatch);
    if (humanContact) {
      const sendResult = await wa.sendText(from, humanContact.reply);
      console.log(`[whatsapp] ${waMessageId}: peticion de persona respondida (ok=${!!sendResult.ok})`);
      return;
    }

    if (isAppointmentSchedulingRequest(userMessage, previousMessages)) {
      await sendReply(buildAppointmentSchedulingReply(conv), "cita respondida sin cerrar fecha");
      return;
    }

    const fastPendingReply = getFastWhatsappPendingReply(userMessage, { ...conv, messages: previousMessages });
    if (fastPendingReply) {
      await sendReply(fastPendingReply, "recordatorio rapido enviado");
      return;
    }

    const fastGreetingReply = getFastWhatsappGreetingReply(userMessage, { ...conv, messages: previousMessages });
    if (fastGreetingReply) {
      await sendReply(fastGreetingReply, "saludo rapido enviado");
      return;
    }

    const phoneStatus = getPhoneSubmissionStatus(parseableMessage);
    const phoneAttempted =
      !leadPatch.customer_email &&
      (phoneStatus.attempted || (botRecentlyAskedForPhone(messagesWithCurrent) && /\d/.test(parseableMessage)));
    if (phoneAttempted && !phoneStatus.valid) {
      await sendReply(INVALID_PHONE_REPLY, "telefono invalido respondido");
      return;
    }

    const systemPrompt = buildSystemPrompt(
      buildContext(fullConv) +
        "\nCANAL: WhatsApp. El cliente puede enviar fotos, videos y su ubicacion de WhatsApp." +
        `\nEl cliente escribe desde el WhatsApp ${from}. Pregunta si ese es su telefono de contacto; si lo confirma, usa ese numero.`
    );
    const modelMessages = prepareWhatsappModelMessages(fullConv.messages || [], {
      forceLatestUserImage: msgType === "image" && !!imageUrl,
    });
    const history = toAnthropicMessages(modelMessages);
    const imageCount = modelMessages.filter((msg) => msg.image_url).length;
    console.log(
      `[whatsapp] ${waMessageId}: enviando ${history.length} mensajes de historial ` +
        `(${imageCount} imagenes) al modelo`
    );

    const modelStartedAt = Date.now();
    const result = await runConversation({
      systemPrompt,
      messages: history,
      onNotifyHuman: (input) => notifyHumanFromWhatsapp(input, conv, from),
      onRequest: (input) => registerRequest(input, conv, fullConv, "whatsapp"),
      maxTokens: WHATSAPP_MAX_TOKENS,
    });
    console.log(`[whatsapp] ${waMessageId}: modelo listo en ${Date.now() - modelStartedAt}ms`);

    const botReply = finalizeBotReply(result, parseableMessage, fullConv);
    if (botReply) await sendReply(botReply, "respuesta enviada");
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
