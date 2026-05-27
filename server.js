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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const FORM_SECRET = process.env.FORM_SECRET || "";
const COMPANY_EMAIL = "contacto@renoveplac.com";
const COMPANY_NAME = "Luis Eduardo Romero Martinelli";
const WHATSAPP_HISTORY_LIMIT = Number(process.env.WHATSAPP_HISTORY_LIMIT || 12);
const WHATSAPP_IMAGE_HISTORY_LIMIT = Number(process.env.WHATSAPP_IMAGE_HISTORY_LIMIT || 1);
const WHATSAPP_MAX_TOKENS = Number(process.env.WHATSAPP_MAX_TOKENS || 520);
const WHATSAPP_FAST_GREETING_ENABLED = process.env.WHATSAPP_FAST_GREETING_ENABLED !== "0";
const MIN_BUDGET_AMOUNT_EUR = 600;
const ACCEPT_BUDGET_REGEX = /^\s*(acepto|si\s+acepto|s[ií]\s+acepto|quiero\s+aceptar|aceptar)\b/i;

app.use(express.json({
  limit: "8mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: false }));
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

function collectFormFields(value, prefix = "", out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value !== "object") {
    if (prefix) out.push({ key: prefix, value: String(value).trim() });
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFormFields(item, `${prefix} ${index}`.trim(), out));
    return out;
  }

  const maybeValue = value.value ?? value.value_raw ?? value.raw_value ?? value.default_value;
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
    if (["value", "value_raw", "raw_value", "default_value"].includes(key)) return;
    collectFormFields(child, `${prefix} ${key}`.trim(), out);
  });
  return out;
}

function readFormValue(body, aliases) {
  const fields = collectFormFields(body);
  const normalizedAliases = aliases.map(normalizeFormKey);
  const exact = fields.find((field) => normalizedAliases.includes(normalizeFormKey(field.key)));
  if (exact?.value) return exact.value;
  const partial = fields.find((field) => {
    const key = normalizeFormKey(field.key);
    return normalizedAliases.some((alias) => key.includes(alias) || alias.includes(key));
  });
  return partial?.value || "";
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

function buildFormWhatsappGreeting({ name, workType, postalCode }) {
  const firstName = String(name || "").trim().split(/\s+/)[0] || "";
  const introName = firstName ? ` ${firstName}` : "";
  const workText = workType ? ` sobre ${String(workType).toLowerCase()}` : "";
  const zoneText = postalCode ? ` Tengo anotado el codigo postal ${postalCode}.` : "";
  return (
    `Hola${introName}, soy Renovebot, el asistente de Renoveplac. Hemos recibido tu solicitud${workText} desde la web.` +
    `${zoneText}\n\n` +
    "Para ayudarte con el presupuesto, cuentame que reforma tienes en mente y cualquier detalle importante: medidas aproximadas, estado actual o plazo que buscas."
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) {
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

function prepareWhatsappModelMessages(messages) {
  const recent = recentMessages(messages, WHATSAPP_HISTORY_LIMIT);
  let remainingImages = Math.max(0, Number(WHATSAPP_IMAGE_HISTORY_LIMIT) || 0);

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
  return {
    ...conv,
    customer_name: isLikelyInvalidCustomerName(conv.customer_name) ? null : conv.customer_name,
    work_type: normalizeWorkType(conv.work_type) || conv.work_type,
  };
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

  const hasPositivePermission =
    /\b(si|claro|correcto|por supuesto|ok|vale)\b.{0,30}\b(tengo|cuento|dispongo|soy)\b/.test(text) ||
    /\bsoy\s+(el\s+|la\s+)?(propietario|propietaria|dueno|duena)\b/.test(text) ||
    /\bes\s+(mi|mio|mia|nuestra|nuestro)\s+(casa|vivienda|piso|local|propiedad)\b/.test(text) ||
    /\b(si\s+)?(tengo|cuento\s+con|dispongo\s+de|me\s+han\s+dado|me\s+han\s+autorizado)\b.{0,30}\b(permiso|autorizacion)\b/.test(text);

  const hasNegativePermission =
    /\b(no\s+(tengo|cuento|dispongo)|sin\s+(permiso|autorizacion)|no\s+me\s+han\s+(dado|autorizado))\b/.test(text) ||
    /\bno\s+soy\s+(propietario|propietaria|dueno|duena)\b.{0,40}\b(ni|y\s+no|tampoco)\b.{0,30}\b(permiso|autorizacion)\b/.test(text);

  if (hasPositivePermission && !hasNegativePermission) return "confirmed";
  if (hasNegativePermission) return "denied";
  if (askedRecently && /^(no|nop|negativo)\b/.test(text)) return "denied";
  if (askedRecently && /^(si|claro|correcto|por supuesto|ok|vale)\b/.test(text)) return "confirmed";
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

  const amount = Number(input?.amount_eur) || 0;
  if (amount < MIN_BUDGET_AMOUNT_EUR) {
    throw new Error(
      `El importe calculado (${amount || 0} EUR) está por debajo del mínimo de obra de ${MIN_BUDGET_AMOUNT_EUR} EUR. No generes presupuesto; explica el mínimo y pregunta si quiere agrupar más trabajos.`
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

function buildBudgetConfirmationMessage(confirmation) {
  const email = confirmation?.email || "tu email";
  const countLine = confirmation?.requestCount
    ? `\n\nSolicitudes registradas con este email: ${confirmation.requestCount}.`
    : "";
  return (
    `Te he preparado el presupuesto orientativo. Para mostrártelo, te he enviado un enlace de confirmación a ${email}.` +
    "\n\nAbre ese enlace desde tu correo y el presupuesto aparecerá en este chat." +
    countLine
  );
}

function buildEmailConfirmationRequiredMessage(confirmation) {
  const email = confirmation?.email || "tu email";
  return `Antes de aceptar o ver el presupuesto, confirma el enlace que te he enviado a ${email}.`;
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
    .select("id")
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

    const name = readFormValue(req.body, ["name", "nombre", "nombre y apellido", "nombre completo"]).trim();
    const email = readFormValue(req.body, ["email", "correo", "correo electronico", "e-mail"]).trim();
    const phone = readFormValue(req.body, ["phone", "telefono", "telefono movil", "movil", "whatsapp"]).trim();
    const postalCode = readFormValue(req.body, ["postal_code", "codigo postal", "cp"]).trim();
    const workType = readFormValue(req.body, ["work_type", "tipo trabajo", "tipo de trabajo", "servicio", "reforma"]).trim();
    const message = readFormValue(req.body, ["message", "mensaje", "comentarios", "descripcion"]).trim();

    if (!email || !name) {
      return res.status(400).json({ error: "Faltan datos obligatorios (nombre y email)." });
    }

    const whatsappPhone = normalizePhoneForWhatsapp(phone);
    const token = generateToken();
    const { data: conv, error } = await supabase
      .from("bot_conversations")
      .insert({
        customer_name: name,
        customer_email: email,
        customer_phone: whatsappPhone || phone || null,
        customer_postal_code: postalCode || null,
        work_type: workType || null,
        initial_message: message || null,
        source: "form",
        channel: whatsappPhone ? "whatsapp" : null,
        access_token: token,
      })
      .select()
      .single();
    if (error) throw error;

    const firstName = name.split(" ")[0];
    const greeting = buildFormWhatsappGreeting({ name, workType, postalCode });
    await supabase.from("bot_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: greeting,
    });

    let whatsappSent = false;
    if (whatsappPhone) {
      const sendResult = await wa.sendText(whatsappPhone, greeting);
      whatsappSent = !!sendResult.ok;
      if (!whatsappSent) {
        console.warn(`[form] No se pudo iniciar WhatsApp para ${whatsappPhone}:`, JSON.stringify(sendResult.error || sendResult));
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

    await safeSendEmail({
      to: COMPANY_EMAIL,
      subject: `Nuevo lead desde web — ${name}${workType ? ` (${workType})` : ""}`,
      text: `Lead recibido desde el formulario de la web.\n\nNombre: ${name}\nEmail: ${email}\nTeléfono: ${whatsappPhone || phone || "(sin teléfono)"}\nCP: ${postalCode || "(sin CP)"}\nTipo de obra: ${workType || "(no especificado)"}\nCanal de inicio: ${whatsappSent ? "WhatsApp enviado" : whatsappPhone ? "WhatsApp no enviado, fallback email" : "Email/chat web"}\nMensaje:\n${message || "(sin mensaje)"}\n\nVer conversación: ${PUBLIC_URL}/admin#${conv.id}`,
    }, "form/empresa");

    return res.json({ ok: true, conversationId: conv.id, chatUrl, whatsappSent });
  } catch (err) {
    console.error("[form]", err);
    return res.status(500).json({ error: "No se pudo registrar el formulario." });
  }
});

// ---------- Chat público ----------

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

    if (conv.bot_enabled !== false) {
      const systemPrompt = buildSystemPrompt(buildContext(conv));
      const history = toAnthropicMessages(conv.messages || []);

      const result = await runConversation({
        systemPrompt,
        messages: history,
        onBudget: async (input) => {
          assertBudgetCanBeCreated(input, conv);
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
    else if (token) conv = await loadByToken(String(token));
    if (!conv) return res.status(404).json({ error: "No encontrada." });

    let messages = conv.messages;
    if (since) messages = messages.filter((m) => m.created_at > since);

    const budgets = await fetchBudgets(conv.id);
    return res.json({ messages, budgets, botEnabled: conv.bot_enabled, status: conv.status });
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
      const redirectUrl = `${PUBLIC_URL}/?t=${encodeURIComponent(conv.access_token)}&email_confirmed=1`;
      return res.redirect(303, redirectUrl);
    }

    return res
      .status(200)
      .type("html")
      .send(renderBudgetConfirmationPage({ budgetId: id, token: rawToken, email: confirmation.email }));
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
      to: COMPANY_EMAIL,
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
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: "ADMIN_PASSWORD no configurada." });
  if (password === ADMIN_PASSWORD) return res.json({ token: ADMIN_PASSWORD });
  return res.status(401).json({ error: "Contraseña incorrecta." });
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
    return res.json({ conversations: (data || []).map(cleanConversationForDisplay) });
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
      `Luis - Equipo de Renoveplac:\n${content}`
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
  const { data: msgs } = await supabase
    .from("bot_messages")
    .select("id, role, content, image_url, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });
  return { ...conv, messages: msgs || [] };
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
    to: COMPANY_EMAIL,
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

  res.sendStatus(200);

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
      buildContext(fullConv) + "\nCANAL: WhatsApp. El cliente NO tiene botones; para aceptar un presupuesto debe responder 'ACEPTO'."
    );
    const modelMessages = prepareWhatsappModelMessages(fullConv?.messages || []);
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
      onBudget: async (input) => {
        assertBudgetCanBeCreated(input, fullConv);
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
          lead_premium: "Lead premium",
          alto_ticket: "Alto ticket (>15.000 €)",
          fuera_de_zona_obra_grande: "Fuera de zona pero obra grande (valorar)",
        })[input.reason] || input.reason;
        const lines = [
          `Aviso del bot (WhatsApp): ${reasonLabel}`,
          "",
          `Resumen: ${input.summary || "(sin resumen)"}`,
          "",
          `Cliente: ${conv.customer_name || "(sin nombre)"} · ${from}`,
          `Conversación: ${PUBLIC_URL}/admin#${conv.id}`,
        ].join("\n");
        await safeSendEmail({
          to: COMPANY_EMAIL,
          subject: `Aviso bot WA — ${reasonLabel} — ${conv.customer_name || from}`,
          text: lines,
        }, "notify_human");
        return { ok: true };
      },
      maxTokens: WHATSAPP_MAX_TOKENS,
    });
    console.log(`[whatsapp] ${waMessageId}: modelo listo en ${Date.now() - modelStartedAt}ms`);

    let botReply = result.text || "";
    if (result.budget) {
      if (result.budget.email_confirmation) {
        botReply = buildBudgetConfirmationMessage(result.budget.email_confirmation);
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
  }
});

app.listen(port, () => {
  console.log(`Renovebot listo en ${PUBLIC_URL} (puerto ${port})`);
});

module.exports = app;
