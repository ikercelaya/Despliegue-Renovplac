-- Esquema de Supabase para Renovebot.
-- Ejecutar en el SQL Editor del proyecto Supabase.

create extension if not exists "pgcrypto";

-- Conversaciones (un lead = una conversación)
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_postal_code text,
  work_type text,
  initial_message text,
  source text default 'widget',
  status text default 'active',
  bot_enabled boolean default true,
  access_token text unique
);

create index if not exists conversations_updated_at_idx on conversations (updated_at desc);
create index if not exists conversations_access_token_idx on conversations (access_token);

-- Mensajes
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'admin')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_id_idx on messages (conversation_id, created_at);

-- Presupuestos
create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  title text not null,
  description text not null,
  amount_eur numeric not null,
  iva_included boolean default false,
  status text default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create index if not exists budgets_conversation_id_idx on budgets (conversation_id);
create index if not exists budgets_status_idx on budgets (status);

-- Trigger para refrescar updated_at de la conversación al añadir mensaje
create or replace function bump_conversation_updated_at()
returns trigger as $$
begin
  update conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists messages_bump_conversation on messages;
create trigger messages_bump_conversation
  after insert on messages
  for each row execute function bump_conversation_updated_at();
