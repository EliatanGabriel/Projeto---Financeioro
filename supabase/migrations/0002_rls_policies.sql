-- NoAzul — Row Level Security: isolamento por auth.uid() em todas as tabelas privadas.
-- O user_id enviado pelo frontend nunca é confiável: a propriedade é validada no banco via RLS.

alter table public.profiles enable row level security;
alter table public.transactions enable row level security;
alter table public.fixed_bills enable row level security;
alter table public.goals enable row level security;
alter table public.budgets enable row level security;
alter table public.bill_payments enable row level security;
alter table public.recurrences enable row level security;
alter table public.recurrence_launches enable row level security;
alter table public.categories enable row level security;
alter table public.goal_auto_launches enable row level security;
alter table public.investments enable row level security;
alter table public.investment_transactions enable row level security;

-- profiles: dono acessa somente o próprio perfil (id = auth.uid())
create policy profiles_select on public.profiles for select using (auth.uid() = id);
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy profiles_delete on public.profiles for delete using (auth.uid() = id);

-- Tabelas com user_id: padrão uniforme nas 11 tabelas privadas restantes
create policy transactions_select on public.transactions for select using (auth.uid() = user_id);
create policy transactions_insert on public.transactions for insert with check (auth.uid() = user_id);
create policy transactions_update on public.transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy transactions_delete on public.transactions for delete using (auth.uid() = user_id);

create policy fixed_bills_select on public.fixed_bills for select using (auth.uid() = user_id);
create policy fixed_bills_insert on public.fixed_bills for insert with check (auth.uid() = user_id);
create policy fixed_bills_update on public.fixed_bills for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy fixed_bills_delete on public.fixed_bills for delete using (auth.uid() = user_id);

create policy goals_select on public.goals for select using (auth.uid() = user_id);
create policy goals_insert on public.goals for insert with check (auth.uid() = user_id);
create policy goals_update on public.goals for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy goals_delete on public.goals for delete using (auth.uid() = user_id);

create policy budgets_select on public.budgets for select using (auth.uid() = user_id);
create policy budgets_insert on public.budgets for insert with check (auth.uid() = user_id);
create policy budgets_update on public.budgets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy budgets_delete on public.budgets for delete using (auth.uid() = user_id);

create policy bill_payments_select on public.bill_payments for select using (auth.uid() = user_id);
create policy bill_payments_insert on public.bill_payments for insert with check (auth.uid() = user_id);
create policy bill_payments_update on public.bill_payments for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy bill_payments_delete on public.bill_payments for delete using (auth.uid() = user_id);

create policy recurrences_select on public.recurrences for select using (auth.uid() = user_id);
create policy recurrences_insert on public.recurrences for insert with check (auth.uid() = user_id);
create policy recurrences_update on public.recurrences for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy recurrences_delete on public.recurrences for delete using (auth.uid() = user_id);

create policy recurrence_launches_select on public.recurrence_launches for select using (auth.uid() = user_id);
create policy recurrence_launches_insert on public.recurrence_launches for insert with check (auth.uid() = user_id);
create policy recurrence_launches_update on public.recurrence_launches for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy recurrence_launches_delete on public.recurrence_launches for delete using (auth.uid() = user_id);

create policy categories_select on public.categories for select using (auth.uid() = user_id);
create policy categories_insert on public.categories for insert with check (auth.uid() = user_id);
create policy categories_update on public.categories for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy categories_delete on public.categories for delete using (auth.uid() = user_id);

create policy goal_auto_launches_select on public.goal_auto_launches for select using (auth.uid() = user_id);
create policy goal_auto_launches_insert on public.goal_auto_launches for insert with check (auth.uid() = user_id);
create policy goal_auto_launches_update on public.goal_auto_launches for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy goal_auto_launches_delete on public.goal_auto_launches for delete using (auth.uid() = user_id);

create policy investments_select on public.investments for select using (auth.uid() = user_id);
create policy investments_insert on public.investments for insert with check (auth.uid() = user_id);
create policy investments_update on public.investments for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy investments_delete on public.investments for delete using (auth.uid() = user_id);

create policy investment_transactions_select on public.investment_transactions for select using (auth.uid() = user_id);
create policy investment_transactions_insert on public.investment_transactions for insert with check (auth.uid() = user_id);
create policy investment_transactions_update on public.investment_transactions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy investment_transactions_delete on public.investment_transactions for delete using (auth.uid() = user_id);
