const { createClient } = require("@supabase/supabase-js");

function cleanEnvValue(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function normalizeSupabaseUrl(value) {
  const clean = cleanEnvValue(value);
  if (!clean) return "";

  const withProtocol = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
  try {
    const url = new URL(withProtocol);
    return url.origin;
  } catch (_err) {
    return clean.replace(/\/+$/, "");
  }
}

const RAW_SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "";

const SUPABASE_URL = normalizeSupabaseUrl(RAW_SUPABASE_URL);

const SUPABASE_SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  ""
).trim();

if (cleanEnvValue(RAW_SUPABASE_URL) && cleanEnvValue(RAW_SUPABASE_URL) !== SUPABASE_URL) {
  console.warn(`[db] SUPABASE_URL normalizada a ${SUPABASE_URL}. Usa la Project URL sin /rest/v1 en Vercel.`);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn(
    "[db] SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY no definidas. La persistencia no funcionará."
  );
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

module.exports = { supabase, SUPABASE_URL, SUPABASE_SERVICE_KEY, normalizeSupabaseUrl };
