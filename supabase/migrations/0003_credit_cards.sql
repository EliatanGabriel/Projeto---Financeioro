-- NoAzul — cartões de crédito, compras parceladas e faturas pagas.
-- A fatura é calculada no cliente a partir das compras; só o pagamento da fatura é persistido.

create table public.credit_cards (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  brand text not null default '',
  limit_amount numeric(14,2) not null default 0,
  closing_day integer not null default 1 check (closing_day between 1 and 28),
  due_day integer not null default 10 check (due_day between 1 and 28),
  color text not null default '#0E9F6E',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz,
  unique (id, user_id)
);
create index credit_cards_user_idx on public.credit_cards(user_id);
create trigger credit_cards_set_updated_at before update on public.credit_cards
  for each row execute function public.set_updated_at();

create table public.credit_card_purchases (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id text not null,
  description text not null,
  category text not null default 'Outros',
  total_amount numeric(14,2) not null,
  installments integer not null default 1 check (installments between 1 and 60),
  first_date date not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  deleted_at timestamptz,
  unique (id, user_id),
  constraint credit_card_purchases_owner_fk foreign key (card_id, user_id)
    references public.credit_cards(id, user_id) on delete cascade
);
create index credit_card_purchases_user_idx on public.credit_card_purchases(user_id);
create index credit_card_purchases_card_idx on public.credit_card_purchases(card_id);
create trigger credit_card_purchases_set_updated_at before update on public.credit_card_purchases
  for each row execute function public.set_updated_at();

create table public.credit_card_payments (
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id text not null,
  month text not null,
  paid_at timestamptz not null default now(),
  primary key (user_id, card_id, month),
  constraint credit_card_payments_owner_fk foreign key (card_id, user_id)
    references public.credit_cards(id, user_id) on delete cascade
);
create index credit_card_payments_user_idx on public.credit_card_payments(user_id);
