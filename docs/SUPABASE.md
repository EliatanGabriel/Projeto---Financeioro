# NoAzul — Supabase (Auth + sincronização)

Status: **Fase 2 (migrations + configuração)**. Auth/sync serão implementadas nas Fases 3–5.
Sem as variáveis abaixo, o app continua em **modo local/offline** como hoje.

## Configuração para o dono (uma vez)
1. Crie um projeto em [supabase.com](https://supabase.com) (plano gratuito serve).
2. Aplique as migrations: **SQL Editor** do projeto → cole `supabase/migrations/0001_schema.sql` e depois `0002_rls_policies.sql` (ou via CLI: `supabase link` + `supabase db push`).
3. Em **Project Settings → API**, copie a **URL do projeto** e a chave **anon/publishable**.
4. Copie `.env.example` para `.env.local` e preencha. Reinicie o `npm run dev`.
5. Em **Auth → Providers → Email**, confirme que o provedor de e-mail está ativo; em **Auth → URL Configuration**, cadastre `http://localhost:5173` (confirmação e redefinição).
6. **Nunca** coloque `service_role` no frontend — a exclusão de conta usará uma Edge Function separada (Fase 5).

## Mapeamento SQLite → PostgreSQL

| SQLite (local) | Postgres (nuvem) | Observações |
|---|---|---|
| `transactions` | `transactions` | + `user_id`, `version`, `deleted_at` |
| `fixed_bills` | `fixed_bills` | + idem; `due_day` vira `INTEGER` |
| `goals` (+`auto_monthly`) | `goals` | + idem |
| `budgets` | `budgets` | PK vira `(user_id, category)` |
| `bill_payments` | `bill_payments` | PK vira `(user_id, bill_id, month)`; FK p/ `fixed_bills` |
| `recurrences` | `recurrences` | + idem; `active` vira `BOOLEAN` |
| `recurrence_launches` | `recurrence_launches` | PK vira `(user_id, recurrence_id, month)`; FK p/ `recurrences` |
| `categories` | `categories` | PK vira `(user_id, name, type)` |
| `goal_auto_launches` | `goal_auto_launches` | PK vira `(user_id, goal_id, month)`; FK p/ `goals` |
| `investments` | `investments` | já tinha `user_id`; + `version`, `deleted_at`, `UNIQUE(id,user_id)` |
| `investment_transactions` | `investment_transactions` | + `cost_removed/realized_gain`; FK composta `(investment_id,user_id)` → `investments` |
| `products`, `marketplaces`, `pricing_*` | — | Legado de precificação: **não sincroniza** |
| `app_settings` | — | Local apenas (licença, tema, identidade do aparelho) |
| `profiles` | `profiles` | Nova: `id = auth.users.id`, nome de exibição |

Tipos: dinheiro `NUMERIC(14,2)`, quantidades/preços `NUMERIC(20,8)` (cripto), datas `DATE`, timestamps `TIMESTAMPTZ` com trigger de `updated_at`.

## Validação local das migrations
As migrations foram validadas em PostgreSQL local temporário (stub de `auth.users`/`auth.uid()`): schema e políticas aplicam sem erro, 12 tabelas com RLS e 48 políticas presentes. Isolamento comprovado com papel comum (`nosuperuser nobypassrls`): insert próprio ok, insert alheio bloqueado pelo RLS, SELECT só enxerga os próprios registros. (Superusuário local pula RLS — o teste usou papel sem bypass.)

## Segurança (RLS)
Todas as tabelas privadas com **Row Level Security** e 4 políticas cada (SELECT/INSERT/UPDATE/DELETE com `auth.uid() = user_id` nas duas cláusulas). `profiles` usa `id = auth.uid()`. O `user_id` do frontend nunca é confiável — a propriedade é validada no banco.

## Licenciamento
Independente: `server/worker.js`, `src/licensing/`, `src/config/plans.ts` e o `deviceId` de ativação **não mudam**. A identidade da conta (UUID do Supabase) e a identidade da licença são coisas separadas.

## Autenticação e sincronização (Fases 3–5)
- Telas: Login, Cadastro, Esqueci a senha, Redefinição, Verificação de e-mail e Perfil (aba própria no app). Sem variáveis configuradas, o app usa o modo local como antes.
- Sincronização: motor em `src/sync/` (diff por hash, fila de tombstones com retry/backoff, conflitos nunca sobrescritos silenciosamente, indicador no topo). Offline: tudo funciona no SQLite local; a fila/meta persistem e sincronizam ao reconectar.
- Migração de dados antigos: no primeiro login com dados legados no aparelho, o app oferece importação (reatribuição do `user_id` legado → UUID da conta, validação de identidade ambígua, push e confirmação antes de concluir). Nada é apagado antes da confirmação.
- Exclusão de conta: Edge Function `supabase/functions/delete-account` (service_role só no servidor); o app chama via `functions.invoke` e sai após sucesso.
