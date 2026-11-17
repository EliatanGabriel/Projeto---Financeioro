# Arquitetura NoAzul

## Visão
App de finanças pessoais que funciona offline (web + Tauri/WebView).
Cálculo local e SQLite local por padrão; sincronização opcional com Supabase (Auth + Postgres com RLS) quando configurada.
Assinatura Pro mensal validada por chave ECDSA P-256 (pagamento pela Cakto).

## Stack
React 19 + TypeScript + Vite + Tailwind + Zod + Recharts + jsPDF + XLSX + sql.js (SQLite WASM, persistido em localStorage) + Supabase opcional. Worker Cloudflare (`server/worker.js`) emite chaves Pro e valida webhooks da Cakto.

## Módulos
- calculations/personal.ts — resumo do mês, limites, contas pagas, recorrências, previsão, checklist
- calculations/annual.ts — resumo anual, comparativo, nota 0–100, tendência (Pro)
- calculations/investments.ts e creditCards.ts — custo médio/posições e faturas parceladas
- database/db.ts — SQLite (movimentos, contas, metas, orçamentos, recorrências, categorias, investimentos, cartões, licença e fila de sincronização)
- sync/ — diff por hash, tombstones, conflitos e adaptador Supabase
- licensing/licensing.ts + config/plans.ts — Pro mensal via Cakto; tools/generate-license.mjs gera chaves
- pages (em App.tsx) — Início, Movimentos, Contas fixas, Cartões, Metas, Investimentos, Resumo (mês/ano), Pro, Perfil, Ajustes

## Segurança
- Chave privada nunca no app; só a pública. Chave Pro vinculada ao aparelho e com expiração mensal.
- Chaves internas de armazenamento mantidas por compatibilidade (não são visíveis na interface).
