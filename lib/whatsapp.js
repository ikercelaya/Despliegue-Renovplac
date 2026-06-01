const crypto = require("crypto");

const WA_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const WA_BASE = `https://graph.facebook.com/${WA_VERSION}`;

function getToken() {
  return process.env.WHATSAPP_TOKEN || "";
}

function getPhoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID || "";
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
}

function toTemplateTextParameter(param) {
  if (param && typeof param === "object" && !Array.isArray(param)) {
    const text = param.text ?? param.value ?? "";
    const name = param.parameter_name || param.parameterName || param.name || param.key;
    const parameter = { type: "text", text: String(text) };
    if (name) parameter.parameter_name = String(name);
    return parameter;
  }
  return { type: "text", text: String(param ?? "") };
}

async function sendText(to, text) {
  const token = getToken();
  const phoneId = getPhoneNumberId();
  if (!token || !phoneId) {
    console.warn("[whatsapp] WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID no configurados.");
    return { error: "no_config" };
  }
  try {
    const r = await fetch(`${WA_BASE}/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizePhone(to),
        type: "text",
        text: { preview_url: false, body: String(text || "").slice(0, 4096) },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("[whatsapp] sendText error:", JSON.stringify(data));
      return { error: data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("[whatsapp] sendText exception:", err.message);
    return { error: err.message };
  }
}

async function markAsRead(messageId) {
  const token = getToken();
  const phoneId = getPhoneNumberId();
  if (!token || !phoneId || !messageId) return { error: "no_config" };
  try {
    const r = await fetch(`${WA_BASE}/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("[whatsapp] markAsRead error:", JSON.stringify(data));
      return { error: data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("[whatsapp] markAsRead exception:", err.message);
    return { error: err.message };
  }
}

async function sendTemplate(to, templateName, languageCode, bodyParams) {
  const token = getToken();
  const phoneId = getPhoneNumberId();
  if (!token || !phoneId) {
    console.warn("[whatsapp] WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID no configurados.");
    return { error: "no_config" };
  }
  const components = [];
  if (Array.isArray(bodyParams) && bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParams.map(toTemplateTextParameter),
    });
  }
  try {
    const r = await fetch(`${WA_BASE}/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizePhone(to),
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode || "es" },
          components,
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("[whatsapp] sendTemplate error:", JSON.stringify(data));
      return { error: data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("[whatsapp] sendTemplate exception:", err.message);
    return { error: err.message };
  }
}

async function downloadMedia(mediaId) {
  const token = getToken();
  if (!token) throw new Error("WHATSAPP_TOKEN no configurado");
  const r1 = await fetch(`${WA_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r1.ok) throw new Error(`No se pudo obtener URL del media (${r1.status})`);
  const meta = await r1.json();
  const r2 = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r2.ok) throw new Error(`No se pudo descargar el media (${r2.status})`);
  const buffer = Buffer.from(await r2.arrayBuffer());
  return { buffer, mimeType: meta.mime_type || "image/jpeg" };
}

function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true;
  if (!signatureHeader || !rawBody) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_e) {
    return false;
  }
}

module.exports = { sendText, sendTemplate, markAsRead, downloadMedia, verifyWebhookSignature, normalizePhone };
