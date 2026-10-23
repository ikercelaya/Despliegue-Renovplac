-- Migracion para los servicios de electricidad (instrucciones del 22-10-2026).
-- Ejecutar en Supabase SQL Editor, en el MISMO proyecto que usa el bot
-- (el de la variable SUPABASE_URL en Vercel). Es idempotente.
--
-- El bot trabaja con las tablas bot_conversations, bot_messages y bot_budgets.
-- Si este proyecto solo tiene conversations, messages y budgets (esquema antiguo
-- de sql/schema.sql), no es el proyecto del bot o le falta el esquema actual:
-- en ese caso la migracion se detiene con un aviso y no cambia nada.

do $$
begin
  if to_regclass('public.bot_conversations') is null then
    raise exception using
      message = 'No existe la tabla public.bot_conversations en este proyecto de Supabase.',
      hint = 'Comprueba en Vercel que SUPABASE_URL apunta a este proyecto. Si es el proyecto correcto, '
          || 'ejecuta primero sql/renovebot-schema-83a8f39.sql y sql/email-confirmation.sql, y despues este archivo.';
  end if;

  -- 1. Datos que el bot recoge en las solicitudes (direccion, medidas, origen).
  alter table public.bot_conversations
    add column if not exists customer_town text,
    add column if not exists work_address text,
    add column if not exists work_dimensions text,
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
end
$$;

-- Fuerza a la API REST de Supabase/PostgREST a recargar el schema cache.
notify pgrst, 'reload schema';

-- Comprobacion visual: deben aparecer las cuatro columnas.
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'bot_conversations'
  and column_name in ('customer_town', 'work_address', 'work_dimensions', 'lead_source');
