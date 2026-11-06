# Arquitetura NoAzul

## Visão
App de finanças pessoais offline (web + Tauri/WebView). Sem SaaS.
Cálculo local, SQLite local, assinatura Pro mensal validada por chave ECDSA P-256 (pagamento pela Cakto).

## Stack
React 19 + TypeScript + Vite + Tailwind + Zod + Recharts + jsPDF + XLSX + sql.js (SQLite WASM, persistido em localStorage).

## Módulos
- calculations/personal.ts — resumo do mês, limites, contas pagas, recorrências, previsão, checklist
- calculations/annual.ts — resumo anual, comparativo, nota 0–100, tendência (Pro)
- database/db.ts — SQLite (transactions, fixed_bills, bill_payments, goals, budgets, recurrences, categories, settings)
- licensing/licensing.ts + config/plans.ts — Pro mensal via Cakto; tools/generate-license.mjs gera chaves
- pages (em App.tsx) — Início, Movimentos, Contas fixas, Metas, Resumo (mês/ano), Pro, Ajustes

## Segurança
- Chave privada nunca no app; só a pública. Chave Pro vinculada ao aparelho e com expiração mensal.
- Chaves internas de armazenamento mantidas por compatibilidade (não são visíveis na interface).
