# NoAzul

Suas finanças no azul: organizador de finanças pessoais para pessoas comuns — sem jargão.
Registre o que entra e sai, veja quanto sobra no mês, acompanhe contas fixas e metas.
100% offline: seus dados ficam só neste aparelho.

## Como rodar

```bash
npm install
npm run dev         # http://localhost:5173
npm test            # 130 testes
npm run build       # gera dist/
npm run preview
npm run tauri:dev   # app de desktop (Tauri v2)
npm run tauri:build # instalador (msi/exe, dmg ou deb/rpm/AppImage)
```

Pré-requisitos do desktop (Rust + dependências do sistema) em `docs/INSTALACAO.md`.

## O que tem

- **Início:** quanto sobrou no mês, quanto pode gastar por dia, saldo total, dicas, alertas de limite/conta vencida, checklist de primeiros passos, gráficos
- **Movimentos:** entrada/saída com categorias do dia a dia, **editar e apagar**, busca e filtro
- **Todo mês:** recorrências (salário, assinatura) que entram sozinhas todo mês, com botão "Lançar" por mês
- **Contas fixas:** marcar como **paga/pendente** no mês, alertas de vencimento, editar
- **Limites:** orçamento por categoria (ex.: Alimentação até R$ 800) com alertas quando chega perto ou passa
- **Metas:** viagem, reserva, quitar dívidas, com barra de progresso e quanto guardar por mês
- **Investimentos:** cadastro manual de carteira (CDB, LCI/LCA, Tesouro, poupança, ações, FIIs, ETFs, fundos, cripto), dashboard de patrimônio/ganhos, distribuição por categoria/instituição e movimentações (compra, aporte, venda, resgate, dividendos/rendimentos) — valores atualizados manualmente, sem cotações automáticas
- **Resumo:** previsão de fim de mês ("se continuar assim"), últimos 12 meses, onde mais gastou, **PDF do mês, CSV do mês e completo**
- **Resumo anual:** opção "Ano todo" no Resumo — totais do ano, mês a mês, média, melhor/pior mês e onde mais gastou (grátis básico)
- **NoAzul Pro (R$ 10/mês via Cakto):** análise anual avançada com nota 0–100, comparativo com o ano anterior, PDF/Excel anual, metas que guardam sozinhas todo mês, metas/recorrências ilimitadas e temas premium. Assinatura e ativação por chave na tela **Pro** — guia completo em `docs/CAKTO-PRO.md`
- **Ajustes:** nome, modo escuro, **categorias próprias**, importar planilha CSV, cópia/restauração completa, apagar tudo, link da Cakto

Motor de cálculo em `src/calculations/personal.ts` e `src/calculations/annual.ts` (testados em `src/tests/`).
Banco SQLite local via sql.js em `src/database/db.ts`.
O motor antigo de precificação (`pricing.ts`) foi mantido para compatibilidade, mas saiu da interface.
