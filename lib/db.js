const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = String(
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ""
).trim();

const SUPABASE_SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  ""
).trim();

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

module.exports = { supabase, SUPABASE_URL, SUPABASE_SERVICE_KEY };
