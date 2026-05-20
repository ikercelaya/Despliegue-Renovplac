-- Migracion para confirmar presupuestos por email y contar solicitudes por correo.
-- Ejecutar en Supabase SQL Editor antes de desplegar el codigo que usa esta funcionalidad.

create table if not exists bot_leads (
  email text primary key,
  first_conversation_id uuid references bot_conversations(id) on delete set null,
  last_conversation_id uuid references bot_conversations(id) on delete set null,
  budget_request_count integer not null default 0,
  email_confirmed_budget_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bot_leads_updated_at_idx on bot_leads (updated_at desc);
create index if not exists bot_leads_budget_request_count_idx on bot_leads (budget_request_count desc);

create table if not exists bot_budget_email_confirmations (
  budget_id uuid primary key references bot_budgets(id) on delete cascade,
  conversation_id uuid not null references bot_conversations(id) on delete cascade,
  email text not null references bot_leads(email) on update cascade on delete cascade,
  token_hash text not null,
  sent_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create index if not exists bot_budget_email_confirmations_email_idx
  on bot_budget_email_confirmations (email);

create index if not exists bot_budget_email_confirmations_confirmed_at_idx
  on bot_budget_email_confirmations (confirmed_at);

-- Fuerza a la API REST de Supabase/PostgREST a recargar el schema cache.
-- Si no se hace, Vercel puede ver "Could not find the table ... in the schema cache"
-- durante unos minutos aunque la tabla exista en el Table Editor.
notify pgrst, 'reload schema';

-- Comprobacion visual: debe devolver los nombres de las dos tablas, no null.
select
  to_regclass('public.bot_leads') as bot_leads_table,
  to_regclass('public.bot_budget_email_confirmations') as bot_budget_email_confirmations_table;
