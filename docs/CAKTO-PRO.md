# NoAzul Pro — venda pela Cakto (R$ 10/mês)

## Como funciona
O pagamento é feito **fora do app, na Cakto** (checkout seguro, cartão/Pix, assinatura mensal).

**Automático (recomendado):** um servidor pequeno (`server/`, Cloudflare Worker) recebe o
webhook da Cakto, guarda a assinatura por e-mail e emite a chave sozinho. O cliente só
digita o e-mail da compra na tela Pro → **Verificar minha assinatura**. Guia de deploy em
`server/README.md`.

**Manual (alternativa):** você confirma o pagamento no painel da Cakto e gera a chave
com a ferramenta abaixo; o cliente cola a chave na tela Pro.

## Passo a passo para vender

1. **Na Cakto:** crie um produto de assinatura mensal de **R$ 10,00** chamado "NoAzul Pro".
   Copie o link de checkout (ex.: `https://pay.cakto.com.br/seu-produto`).
2. **No app:** Ajustes → "Link de pagamento da Cakto" → cole o link e salve.
   (Alternativa: editar `CAKTO_CHECKOUT_URL` em `src/config/plans.ts` e rebuildar.)
3. **Quando alguém pagar:** no painel da Cakto confirme o pagamento. Peça ao cliente o
   **ID do aparelho** (ele aparece na tela Pro do app). Gere a chave:
   ```bash
   node tools/generate-license.mjs --holder "Nome do Cliente" --device <id-do-aparelho> --plan monthly --months 1
   ```
   Envie a linha `PRP1....` para o cliente. Ele cola na tela Pro → **Ativar Pro**.
4. **Renovação:** a cada mês, ao confirmar o pagamento recorrente na Cakto, gere uma nova
   chave de 1 mês para o mesmo aparelho. Se expirar, o app volta para o grátis **sem perder dados**.

## Segurança
- `tools/private.key.pem` é a chave **privada** do dono: nunca publique, nunca suba para
  repositório público, guarde offline. Sem ela, ninguém consegue forjar chaves.
- A chave pública fica dentro do app (`src/licensing/licensing.ts`) — ela só verifica.
- Chaves geradas antes da correção de assinatura (DER→cru) são inválidas; gere novas.

## Grátis x Pro
- **Grátis:** tudo do mês, resumo anual básico, até 3 metas e 3 recorrências.
- **Pro (R$ 10/mês):** resumo anual avançado (comparativo, nota 0–100, análise de gastos),
  PDF/Excel anual, metas que guardam sozinhas todo mês, metas/recorrências ilimitadas e temas premium.
