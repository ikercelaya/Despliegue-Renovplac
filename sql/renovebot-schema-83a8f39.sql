-- Esquema requerido por Renovebot en el commit:
-- 83a8f39 "Mejora email de confirmacion de presupuesto"
--
-- Ejecutar completo en Supabase SQL Editor.
-- Es idempotente: crea o ajusta solo tablas/bucket con prefijo bot_ y no borra tablas existentes.

create extension if not exists "pgcrypto";

-- Conversaciones del chatbot.
create table if not exists public.bot_conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_postal_code text,
  work_type text,
  initial_message text,
  source text not null default 'widget',
  channel text not null default 'web',
  status text not null default 'active',
  bot_enabled boolean not null default true,
  access_token text unique
);

alter table public.bot_conversations
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists customer_name text,
  add column if not exists customer_email text,
  add column if not exists customer_phone text,
  add column if not exists customer_postal_code text,
  add column if not exists work_type text,
  add column if not exists initial_message text,
  add column if not exists source text not null default 'widget',
  add column if not exists channel text not null default 'web',
  add column if not exists status text not null default 'active',
  add column if not exists bot_enabled boolean not null default true,
  add column if not exists access_token text;

create unique index if not exists bot_conversations_access_token_uidx
  on public.bot_conversations (access_token)
  where access_token is not null;

create index if not exists bot_conversations_updated_at_idx
  on public.bot_conversations (updated_at desc);

create index if not exists bot_conversations_customer_phone_channel_idx
  on public.bot_conversations (customer_phone, channel);

create index if not exists bot_conversations_status_idx
  on public.bot_conversations (status);

alter table public.bot_conversations enable row level security;

-- Mensajes del chat.
create table if not exists public.bot_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.bot_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  image_url text,
  created_at timestamptz not null default now(),
  constraint bot_messages_role_check check (role in ('user', 'assistant', 'admin'))
);

alter table public.bot_messages
  add column if not exists conversation_id uuid references public.bot_conversations(id) on delete cascade,
  add column if not exists role text,
  add column if not exists content text,
  add column if not exists image_url text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists bot_messages_conversation_created_idx
  on public.bot_messages (conversation_id, created_at);

alter table public.bot_messages enable row level security;

-- Presupuestos generados por el bot.
create table if not exists public.bot_budgets (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.bot_conversations(id) on delete cascade,
  title text not null,
  description text not null,
  amount_eur numeric not null,
  iva_included boolean not null default false,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint bot_budgets_status_check check (status in ('pending', 'accepted', 'rejected'))
);

alter table public.bot_budgets
  add column if not exists conversation_id uuid references public.bot_conversations(id) on delete cascade,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists amount_eur numeric,
  add column if not exists iva_included boolean not null default false,
  add column if not exists status text not null default 'pending',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists accepted_at timestamptz;

create index if not exists bot_budgets_conversation_created_idx
  on public.bot_budgets (conversation_id, created_at);

create index if not exists bot_budgets_status_idx
  on public.bot_budgets (status);

alter table public.bot_budgets enable row level security;

-- Emails usados para controlar solicitudes de presupuesto.
create table if not exists public.bot_leads (
  email text primary key,
  first_conversation_id uuid references public.bot_conversations(id) on delete set null,
  last_conversation_id uuid references public.bot_conversations(id) on delete set null,
  budget_request_count integer not null default 0,
  email_confirmed_budget_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bot_leads
  add column if not exists first_conversation_id uuid references public.bot_conversations(id) on delete set null,
  add column if not exists last_conversation_id uuid references public.bot_conversations(id) on delete set null,
  add column if not exists budget_request_count integer not null default 0,
  add column if not exists email_confirmed_budget_count integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists bot_leads_updated_at_idx
  on public.bot_leads (updated_at desc);

create index if not exists bot_leads_budget_request_count_idx
  on public.bot_leads (budget_request_count desc);

alter table public.bot_leads enable row level security;

-- Confirmaciones por email antes de mostrar presupuesto.
create table if not exists public.bot_budget_email_confirmations (
  budget_id uuid primary key references public.bot_budgets(id) on delete cascade,
  conversation_id uuid not null references public.bot_conversations(id) on delete cascade,
  email text not null references public.bot_leads(email) on update cascade on delete cascade,
  token_hash text not null,
  sent_at timestamptz not null default now(),
  confirmed_at timestamptz
);

alter table public.bot_budget_email_confirmations
  add column if not exists conversation_id uuid references public.bot_conversations(id) on delete cascade,
  add column if not exists email text references public.bot_leads(email) on update cascade on delete cascade,
  add column if not exists token_hash text,
  add column if not exists sent_at timestamptz not null default now(),
  add column if not exists confirmed_at timestamptz;

create index if not exists bot_budget_email_confirmations_email_idx
  on public.bot_budget_email_confirmations (email);

create index if not exists bot_budget_email_confirmations_confirmed_at_idx
  on public.bot_budget_email_confirmations (confirmed_at);

alter table public.bot_budget_email_confirmations enable row level security;

-- Mantener updated_at en conversaciones.
create or replace function public.renovebot_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists bot_conversations_set_updated_at on public.bot_conversations;
create trigger bot_conversations_set_updated_at
  before update on public.bot_conversations
  for each row execute function public.renovebot_set_updated_at();

create or replace function public.renovebot_bump_conversation_updated_at()
returns trigger as $$
begin
  update public.bot_conversations
  set updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists bot_messages_bump_conversation on public.bot_messages;
create trigger bot_messages_bump_conversation
  after insert on public.bot_messages
  for each row execute function public.renovebot_bump_conversation_updated_at();

-- Bucket publico para fotos del chat.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-images',
  'chat-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Public read chat images'
  ) then
    create policy "Public read chat images"
      on storage.objects
      for select
      using (bucket_id = 'chat-images');
  end if;
end $$;

-- Recargar cache de PostgREST para que Vercel vea las tablas al instante.
notify pgrst, 'reload schema';

-- Comprobacion: todas deben aparecer como public.<tabla>.
select
  to_regclass('public.bot_conversations') as bot_conversations,
  to_regclass('public.bot_messages') as bot_messages,
  to_regclass('public.bot_budgets') as bot_budgets,
  to_regclass('public.bot_leads') as bot_leads,
  to_regclass('public.bot_budget_email_confirmations') as bot_budget_email_confirmations;
