const nodemailer = require("nodemailer");

let cached = null;

function getFromAddress() {
  return (
    process.env.RESEND_FROM ||
    process.env.EMAIL_FROM ||
    process.env.SMTP_FROM ||
    (process.env.SMTP_USER ? `Renoveplac <${process.env.SMTP_USER}>` : "")
  );
}

function getErrorMessage(data) {
  if (!data) return "Respuesta vacia";
  if (typeof data === "string") return data;
  return data.message || data.error?.message || data.error || JSON.stringify(data);
}

async function sendWithResend({ to, subject, text, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;

  const from = getFromAddress();
  if (!from) {
    throw new Error("RESEND_FROM, EMAIL_FROM o SMTP_FROM no definida.");
  }

  const body = { from, to, subject };
  if (text) body.text = text;
  if (html) body.html = html;
  if (replyTo) body.reply_to = replyTo;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "renovebot/2.0.0",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Resend ${response.status}: ${getErrorMessage(data)}`);
  }

  return { id: data?.id, provider: "resend" };
}

function getTransporter() {
  if (cached !== null) return cached;
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn("[email] SMTP_HOST/SMTP_USER/SMTP_PASS no definidas. No se enviarán correos.");
    cached = null;
    return null;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  cached = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cached;
}

async function sendEmail({ to, subject, text, html, replyTo }) {
  const resendResult = await sendWithResend({ to, subject, text, html, replyTo });
  if (resendResult) return resendResult;

  const t = getTransporter();
  if (!t) {
    console.log("[email] (sin SMTP) Email no enviado:", { to, subject });
    return { mocked: true };
  }
  const from = getFromAddress();
  const info = await t.sendMail({ from, to, subject, text, html, replyTo });
  return { id: info.messageId, provider: "smtp" };
}

module.exports = { sendEmail };
