-- NoAzul — RLS das tabelas de cartões de crédito.

alter table public.credit_cards enable row level security;
alter table public.credit_card_purchases enable row level security;
alter table public.credit_card_payments enable row level security;

create policy credit_cards_select on public.credit_cards for select using (auth.uid() = user_id);
create policy credit_cards_insert on public.credit_cards for insert with check (auth.uid() = user_id);
create policy credit_cards_update on public.credit_cards for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy credit_cards_delete on public.credit_cards for delete using (auth.uid() = user_id);

create policy credit_card_purchases_select on public.credit_card_purchases for select using (auth.uid() = user_id);
create policy credit_card_purchases_insert on public.credit_card_purchases for insert with check (auth.uid() = user_id);
create policy credit_card_purchases_update on public.credit_card_purchases for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy credit_card_purchases_delete on public.credit_card_purchases for delete using (auth.uid() = user_id);

create policy credit_card_payments_select on public.credit_card_payments for select using (auth.uid() = user_id);
create policy credit_card_payments_insert on public.credit_card_payments for insert with check (auth.uid() = user_id);
create policy credit_card_payments_update on public.credit_card_payments for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy credit_card_payments_delete on public.credit_card_payments for delete using (auth.uid() = user_id);
