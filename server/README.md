# NoAzul — servidor de licenças (automático)

Faz a ponte Cakto → app: recebe o webhook de pagamento/assinatura, guarda por e-mail
e emite a chave Pro quando o app pergunta. Sem ele, a ativação é manual (chave colada).

## Publicar (Cloudflare Workers, plano gratuito)
```bash
npm i -g wrangler
wrangler kv namespace create LICENSES   # anote o id (só para migração legada)
cp wrangler.toml.example wrangler.toml  # cole o id no arquivo
wrangler secret put CAKTO_WEBHOOK_SECRET
cat ../tools/private.key.pem | wrangler secret put PRIVATE_KEY_PEM
wrangler secret put ADMIN_TOKEN
wrangler deploy
```
O Worker usa **Durable Objects** (`LicenseStore`, 1 instância por e-mail, storage SQLite) para
pin de dispositivo, watermarks, dedup e rate limit — operações serializadas por instância.
O KV fica só como **fallback de migração** (leitura preguiçosa por chave, sem dual-write):
no primeiro acesso de cada e-mail, o DO copia o registro do KV para o próprio storage e
passa a ser a fonte oficial. Registros legados sem `deviceId`/watermarks são migrados como estão.
`ADMIN_TOKEN` deve ser um valor aleatório forte (ex.: `openssl rand -hex 32`) usado só no endpoint `POST /admin/reset-device`. O endpoint tem rate limit por IP (5 falhas/15 min → bloqueio de 15 min) — respostas 401/429 são genéricas e o token nunca é logado.
A URL final fica tipo `https://noazul-license.seu-subdominio.workers.dev`.

## Ligar na Cakto
1. Painel Cakto → **Integrações → Webhooks → Criar**
2. URL: `https://noazul-license.seu-subdominio.workers.dev/webhook/cakto`
3. Produto: **NoAzul Pro** | Eventos: `purchase_approved`, `subscription_created`,
   `subscription_renewed`, `subscription_canceled`, `subscription_paused`, `refund`, `chargeback`
4. Guarde o **segredo gerado pela Cakto** (o que aparece nos detalhes/editar do webhook) e faça o `wrangler secret put CAKTO_WEBHOOK_SECRET` com **exatamente aquele valor**.
   ⚠️ **Não invente um segredo próprio** (`openssl rand` etc.): a Cakto assina com o segredo que ela gerou. Um segredo inventado = 401 em todos os eventos. Se o painel pedir para definir um e você já definiu um, confira qual valor a Cakto mostra em Editar — esse é o que vale.
   Use o botão **Testar Webhook** da Cakto para conferir (Histórico de Eventos). Se der 401, a resposta pública é genérica (`unauthorized`); o motivo detalhado (ex.: `signature_mismatch` = segredo diferente) aparece só no log: `npx wrangler tail`.

## Ligar no app
- Ajustes → **URL do servidor de licenças** → cole a URL do Worker (ou edite `LICENSE_API_URL` em `src/config/plans.ts`).
- O cliente paga na Cakto, abre a tela Pro, digita o **e-mail da compra** e toca em
  **Verificar minha assinatura** — o Pro ativa sozinho. Renovação/cancelamento são automáticos.

## Segurança e regras
- `PRIVATE_KEY_PEM`, `CAKTO_WEBHOOK_SECRET` e `ADMIN_TOKEN` ficam só no Worker (secrets). Nunca no app, nunca no git (`.gitignore` protege `tools/private.key.pem`).
- O webhook valida a assinatura HMAC da Cakto e ignora pedido já processado (idempotente, também por período de assinatura).
- **Pin de dispositivo:** o primeiro aparelho que ativar fica vinculado à assinatura; outro aparelho recebe `409 device_mismatch`.
- Para trocar de aparelho (suporte): `curl -X POST https://SEU-WORKER/admin/reset-device -H 'content-type: application/json' -d '{"email":"cliente@email.com","token":"SEU_ADMIN_TOKEN"}'`
- Cancelamento mantém o acesso até o fim do período pago; reembolso/chargeback revoga na hora. `/license` tem limite simples de 20 tentativas/min por e-mail.

## Inventário, snapshot e recuperação (R1)
- Todo e-mail tocado (webhook, `/license`, reset) é **registrado primeiro** na instância `__registry__` do DO; sem registro confirmado, a operação falha sem mutar a licença. DOs sem registro (pré-índice) só entram via bootstrap.
- **Bootstrap histórico:** `POST /admin/bootstrap {"token":"...","emails":["externo@x.com"]}` — registra também o censo `sub:*` do KV legado. O manifesto diferencia fontes (KV × externo); **sem lista externa, a cobertura histórica é declaradamente incompleta** (registros DO-only anteriores ao índice só são descobertos via histórico da Cakto).
- **Exportação paginada:** `POST /admin/export {"token":"...","limit":50,"cursor":null}` → lotes com `records`, `cursor`, `complete` e manifesto (versão, data, contagens, SHA-256 por registro). Qualquer falha = `export_incomplete`, sem parcial válido.
- **Congelamento técnico (barreira no registry):** `POST /admin/freeze` → `POST /admin/freeze/confirm` (só efetiva com `activeOperations === 0`) trava webhook, `/license`, reset e bootstrap (**503 `frozen`**); leases liberam em `finally`, inclusive em erro, e operações em andamento terminam antes da confirmação. `GET`-style via `POST /admin/freeze/state` consulta; `POST /admin/freeze/unlock` (explícito, recusa com operação ativa) passa por `unfreezing` → `running` na consulta seguinte. Pausar só a Cakto **não** basta — use o freeze.
- **Rollback seguro:** nunca faça rollback direto ao código KV sem exportar+restaurar antes — registros só-DO (renovações, revogações, pins, pedidos) ficariam invisíveis ao Worker antigo.
