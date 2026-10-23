-- Migracion para los servicios de electricidad (instrucciones del 22-10-2026).
-- Ejecutar en Supabase SQL Editor. Es idempotente.
--
-- 1. Datos que el bot recoge en las solicitudes de electricidad.
alter table public.bot_conversations
  add column if not exists customer_town text,
  add column if not exists work_address text,
  add column if not exists lead_source text;

-- 2. Permite guardar videos cortos de WhatsApp (cuadro electrico, contador, zona del trabajo)
--    en el mismo bucket que las fotos. WhatsApp limita los videos a 16 MB.
update storage.buckets
set
  file_size_limit = 16777216,
  allowed_mime_types = array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
    'video/mp4', 'video/3gpp', 'video/quicktime'
  ]
where id = 'chat-images';

-- Fuerza a la API REST de Supabase/PostgREST a recargar el schema cache.
notify pgrst, 'reload schema';

-- Comprobacion visual: deben aparecer las tres columnas.
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'bot_conversations'
  and column_name in ('customer_town', 'work_address', 'lead_source');
