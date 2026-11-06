-- NoAzul — esquema Postgres (Supabase) para sincronização entre dispositivos.
-- Espelha as tabelas privadas do SQLite local (src/database/db.ts), com user_id => auth.users.
-- Tabelas legadas de precificação (products, marketplaces, pricing_*) e app_settings NÃO são sincronizadas.
--
-- Colunas de sincronização (só na nuvem): version (conflitos) e deleted_at (tombstone).
-- IDs são TEXT gerados pelo cliente (compatíveis com o SQLite local).

-- ============ função: updated_at automático ============
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Perfil público mínimo da conta (nome exibido no app)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Criar perfil automaticamente no cadastro
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ tabelas financeiras (espelho do SQLite) ============
create table public.transactions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null,
  amount numeric(14,2) not null,
  type text not null check (type in ('in','out')),
  category text not null default 'Outros',
  date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz
);
create index transactions_user_idx on public.transactions(user_id);
create index transactions_user_date_idx on public.transactions(user_id, date);

create table public.fixed_bills (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric(14,2) not null,
  due_day integer not null check (due_day between 1 and 28),
  category text not null default 'Contas da casa',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz
);
create index fixed_bills_user_idx on public.fixed_bills(user_id);

create table public.goals (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target numeric(14,2) not null,
  saved numeric(14,2) not null default 0,
  deadline date,
  auto_monthly numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz
);
create index goals_user_idx on public.goals(user_id);

create table public.budgets (
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  "limit" numeric(14,2) not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);
create index budgets_user_idx on public.budgets(user_id);

create table public.bill_payments (
  user_id uuid not null references auth.users(id) on delete cascade,
  bill_id text not null references public.fixed_bills(id) on delete cascade,
  month text not null,
  paid_at timestamptz not null default now(),
  primary key (user_id, bill_id, month)
);
create index bill_payments_user_idx on public.bill_payments(user_id);

create table public.recurrences (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null,
  amount numeric(14,2) not null,
  type text not null check (type in ('in','out')),
  category text not null default 'Outros',
  day integer not null check (day between 1 and 28),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz
);
create index recurrences_user_idx on public.recurrences(user_id);

create table public.recurrence_launches (
  user_id uuid not null references auth.users(id) on delete cascade,
  recurrence_id text not null references public.recurrences(id) on delete cascade,
  month text not null,
  primary key (user_id, recurrence_id, month)
);
create index recurrence_launches_user_idx on public.recurrence_launches(user_id);

create table public.categories (
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('in','out')),
  primary key (user_id, name, type)
);
create index categories_user_idx on public.categories(user_id);

create table public.goal_auto_launches (
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id text not null references public.goals(id) on delete cascade,
  month text not null,
  primary key (user_id, goal_id, month)
);
create index goal_auto_launches_user_idx on public.goal_auto_launches(user_id);

create table public.investments (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text not null,
  ticker text not null default '',
  institution text not null default '',
  quantity numeric(20,8) not null default 0,
  average_price numeric(20,8) not null default 0,
  invested_amount numeric(14,2) not null default 0,
  current_value numeric(14,2) not null default 0,
  started_at date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz,
  unique (id, user_id)
);
create index investments_user_idx on public.investments(user_id);

create table public.investment_transactions (
  id text primary key,
  investment_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('compra','aporte','venda','resgate','dividendo','rendimento')),
  quantity numeric(20,8) not null default 0,
  unit_price numeric(20,8) not null default 0,
  amount numeric(14,2) not null,
  date date not null,
  description text not null default '',
  cost_removed numeric(14,2) not null default 0,
  realized_gain numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz,
  constraint investment_transactions_owner_fk foreign key (investment_id, user_id) references public.investments(id, user_id) on delete cascade
);
create index investment_transactions_user_idx on public.investment_transactions(user_id);
create index investment_transactions_inv_idx on public.investment_transactions(investment_id);

-- updated_at automático nas tabelas com a coluna
do $$
declare
  t text;
begin
  for t in select unnest(array['transactions','fixed_bills','goals','budgets','recurrences','investments','investment_transactions']) loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end;
$$;
