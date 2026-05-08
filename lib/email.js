const nodemailer = require("nodemailer");

let cached = null;

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
  const t = getTransporter();
  if (!t) {
    console.log("[email] (sin SMTP) Email no enviado:", { to, subject });
    return { mocked: true };
  }
  const from = process.env.SMTP_FROM || `Renoveplac <${process.env.SMTP_USER}>`;
  const info = await t.sendMail({ from, to, subject, text, html, replyTo });
  return { id: info.messageId };
}

module.exports = { sendEmail };
