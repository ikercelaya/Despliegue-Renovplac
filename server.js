require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");

const { supabase } = require("./lib/db");
const { sendEmail } = require("./lib/email");
const { buildSystemPrompt } = require("./lib/prompt");
const { runConversation } = require("./lib/claude");
const wa = require("./lib/whatsapp");

const app = express();
const port = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const FORM_SECRET = process.env.FORM_SECRET || "";
const COMPANY_EMAIL = "contacto@renoveplac.com";
const COMPANY_NAME = "Luis Eduardo Romero Martinelli";

app.use(express.json({
  limit: "8mb",
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

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "No autorizado." });
  }
  return next();
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
  return { ...conv, messages: msgs || [] };
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

async function fetchBudgets(conversationId) {
  const { data } = await supabase
    .from("bot_budgets")
    .select("id, title, description, amount_eur, iva_included, status, created_at, accepted_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  return data || [];
}

async function safeSendEmail(payload, label) {
  try {
    return await sendEmail(payload);
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

    const name = (req.body?.name || req.body?.nombre || "").trim();
    const email = (req.body?.email || req.body?.correo || "").trim();
    const phone = (req.body?.phone || req.body?.telefono || "").trim();
    const postalCode = (req.body?.postal_code || req.body?.cp || "").trim();
    const workType = (req.body?.work_type || req.body?.tipo_trabajo || "").trim();
    const message = (req.body?.message || req.body?.mensaje || "").trim();

    if (!email || !name) {
      return res.status(400).json({ error: "Faltan datos obligatorios (nombre y email)." });
    }

    const token = generateToken();
    const { data: conv, error } = await supabase
      .from("bot_conversations")
      .insert({
        customer_name: name,
        customer_email: email,
        customer_phone: phone || null,
        customer_postal_code: postalCode || null,
        work_type: workType || null,
        initial_message: message || null,
        source: "form",
        access_token: token,
      })
      .select()
      .single();
    if (error) throw error;

    const firstName = name.split(" ")[0];
    const greeting = `Hola ${firstName}, soy Renovebot, el asistente de Renoveplac. Hemos recibido tu solicitud${workType ? ` sobre ${workType.toLowerCase()}` : ""}. Para preparar un presupuesto orientativo, cuéntame un poco más: ¿qué dimensiones aproximadas tiene la zona y para cuándo te gustaría empezar?`;
    await supabase.from("bot_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: greeting,
    });

    const chatUrl = `${PUBLIC_URL}/?t=${token}`;
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

    await safeSendEmail({
      to: COMPANY_EMAIL,
      subject: `Nuevo lead desde web — ${name}${workType ? ` (${workType})` : ""}`,
      text: `Lead recibido desde el formulario de la web.\n\nNombre: ${name}\nEmail: ${email}\nTeléfono: ${phone || "(sin teléfono)"}\nCP: ${postalCode || "(sin CP)"}\nTipo de obra: ${workType || "(no especificado)"}\nMensaje:\n${message || "(sin mensaje)"}\n\nVer conversación: ${PUBLIC_URL}/admin#${conv.id}`,
    }, "form/empresa");

    return res.json({ ok: true, conversationId: conv.id, chatUrl });
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

    let botReply = "";
    let createdBudget = null;
    let assistantMsgRow = null;

    if (conv.bot_enabled !== false) {
      const systemPrompt = buildSystemPrompt(buildContext(conv));
      const history = toAnthropicMessages([
        ...(conv.messages || []),
        { role: "user", content: userMessage, image_url: imageUrl || null },
      ]);

      const result = await runConversation({
        systemPrompt,
        messages: history,
        onBudget: async (input) => {
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
          return budget;
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
      budget: createdBudget,
      userMessage: userMsgRow,
      assistantMessage: assistantMsgRow,
    });
  } catch (err) {
    console.error("[chat]", err);
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
  const { data, error } = await supabase
    .from("bot_conversations")
    .select(
      "id, customer_name, customer_email, customer_phone, customer_postal_code, work_type, status, bot_enabled, created_at, updated_at, source"
    )
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ conversations: data });
});

app.get("/api/admin/conversations/:id", requireAdmin, async (req, res) => {
  const conv = await loadConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversación no encontrada." });
  const budgets = await fetchBudgets(conv.id);
  return res.json({ ...conv, budgets });
});

app.post("/api/admin/conversations/:id/reply", requireAdmin, async (req, res) => {
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "Mensaje vacío." });
  const { error } = await supabase.from("bot_messages").insert({
    conversation_id: req.params.id,
    role: "admin",
    content,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
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
  res.sendStatus(200);

  try {
    if (process.env.WHATSAPP_APP_SECRET) {
      const sig = req.headers["x-hub-signature-256"];
      if (!wa.verifyWebhookSignature(req.rawBody, sig, process.env.WHATSAPP_APP_SECRET)) {
        console.warn("[whatsapp] firma inválida, ignorado");
        return;
      }
    }

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    const messages = value.messages || [];
    if (messages.length === 0) return;

    const wamsg = messages[0];
    const from = wamsg.from;
    const msgType = wamsg.type;
    const contactName = value.contacts?.[0]?.profile?.name || null;

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

    const acceptRegex = /^\s*(acepto|si\s+acepto|quiero\s+aceptar|aceptar)\b/i;
    if (acceptRegex.test(userMessage)) {
      const { data: pending } = await supabase
        .from("bot_budgets")
        .select("id")
        .eq("conversation_id", conv.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1);
      if (pending && pending.length > 0) {
        await supabase.from("bot_messages").insert({
          conversation_id: conv.id,
          role: "user",
          content: userMessage,
          image_url: imageUrl,
        });
        await acceptBudgetInternal(pending[0].id);
        const confirmText =
          "He registrado tu aceptación del presupuesto orientativo. Luis, de Renoveplac, se pondrá en contacto contigo en breve para coordinar la visita técnica y cerrar el presupuesto definitivo. ¡Un saludo!";
        await supabase.from("bot_messages").insert({
          conversation_id: conv.id,
          role: "assistant",
          content: confirmText,
        });
        await wa.sendText(from, confirmText);
        return;
      }
    }

    await supabase.from("bot_messages").insert({
      conversation_id: conv.id,
      role: "user",
      content: userMessage || (imageUrl ? "(imagen)" : ""),
      image_url: imageUrl,
    });

    if (conv.bot_enabled === false) return;

    const fullConv = await loadConversation(conv.id);
    const systemPrompt = buildSystemPrompt(
      buildContext(fullConv) + "\nCANAL: WhatsApp. El cliente NO tiene botones; para aceptar un presupuesto debe responder 'ACEPTO'."
    );
    const history = toAnthropicMessages(fullConv?.messages || []);

    const result = await runConversation({
      systemPrompt,
      messages: history,
      onBudget: async (input) => {
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
        return budget;
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
    });

    let botReply = result.text || "";
    if (result.budget) {
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

    if (botReply) {
      await supabase.from("bot_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: botReply,
      });
      await wa.sendText(from, botReply);
    }
  } catch (err) {
    console.error("[whatsapp/webhook]", err);
  }
});

app.listen(port, () => {
  console.log(`Renovebot listo en ${PUBLIC_URL} (puerto ${port})`);
});

module.exports = app;