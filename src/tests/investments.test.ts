import { describe, it, expect } from 'vitest'
import { validateInvestment, validateInvestmentTransaction, validateAgainstPosition, isDuplicateTransaction, applyTransaction, applyTransactionDetailed, reverseTransaction, investmentGain, summarizeInvestments, filterByUser } from '../calculations/investments'
import type { Investment, InvestmentTransaction } from '../types'

let n = 0
const inv = (over: Partial<Investment> = {}): Investment => ({ id: `i${++n}`, userId: 'u1', name: 'Tesouro', category: 'Renda fixa', ticker: 'TESOURO', institution: 'Tesouro Direto', quantity: 0, averagePrice: 0, investedAmount: 0, currentValue: 0, startedAt: '2026-01-01', notes: '', createdAt: '', updatedAt: '', ...over })
const tx = (over: Partial<InvestmentTransaction> = {}): InvestmentTransaction => ({ id: `t${++n}`, investmentId: 'i1', userId: 'u1', type: 'compra', quantity: 10, unitPrice: 100, amount: 1000, date: '2026-01-05', description: '', createdAt: '', ...over })

describe('investimentos — validação', () => {
  it('cadastro válido passa; inválidos são rejeitados', () => {
    expect(validateInvestment(inv())).toEqual([])
    expect(validateInvestment(inv({ name: '' })).length).toBeGreaterThan(0)
    expect(validateInvestment(inv({ category: 'X' })).length).toBeGreaterThan(0)
    expect(validateInvestment(inv({ investedAmount: -5 })).length).toBeGreaterThan(0)
    expect(validateInvestment(inv({ currentValue: -1 })).length).toBeGreaterThan(0)
    expect(validateInvestment(inv({ startedAt: '2026-02-31' })).length).toBeGreaterThan(0)
    expect(validateInvestment(inv({ ticker: 'PETR4' }))).toEqual([])
  })
  it('movimentação: valor, data overflow, tipo e consistência qtd×preço×valor', () => {
    expect(validateInvestmentTransaction(tx())).toEqual([])
    expect(validateInvestmentTransaction(tx({ amount: 0 })).length).toBeGreaterThan(0)
    expect(validateInvestmentTransaction(tx({ amount: -10 })).length).toBeGreaterThan(0)
    expect(validateInvestmentTransaction(tx({ date: '2026-02-31' })).length).toBeGreaterThan(0)
    expect(validateInvestmentTransaction(tx({ type: 'x' as any })).length).toBeGreaterThan(0)
    expect(validateInvestmentTransaction(tx({ quantity: -1 })).length).toBeGreaterThan(0)
    expect(validateInvestmentTransaction(tx({ quantity: 0 })).length).toBe(0) // caixa sem quantidade (ex.: aporte em CDB)
    expect(validateInvestmentTransaction(tx({ quantity: 10, unitPrice: 100, amount: 999 })).length).toBeGreaterThan(0)
    expect(validateInvestmentTransaction(tx({ quantity: 10, unitPrice: 100, amount: 1000 })).length).toBe(0)
  })
  it('oversell é rejeitado; venda sem quantidade (caixa) não é oversell', () => {
    expect(validateAgainstPosition(inv({ quantity: 2 }), tx({ type: 'venda', quantity: 3 })).length).toBeGreaterThan(0)
    expect(validateAgainstPosition(inv({ quantity: 10 }), tx({ type: 'venda', quantity: 5 })).length).toBe(0)
    expect(() => applyTransaction(inv({ quantity: 2, investedAmount: 200 }), tx({ type: 'venda', quantity: 99, amount: 250 }))).toThrow('Quantidade maior')
    expect(validateAgainstPosition(inv({ quantity: 0, currentValue: 500, investedAmount: 500 }), tx({ type: 'resgate', quantity: 0, amount: 100 })).length).toBe(0)
  })
  it('duplicada idêntica é detectada', () => {
    const a = tx({ id: 'a' })
    expect(isDuplicateTransaction([a], tx({ id: 'b' }))).toBe(true)
    expect(isDuplicateTransaction([a], tx({ id: 'b', description: 'outra' }))).toBe(false)
  })
})

describe('investimentos — custo médio ponderado e vendas (P1)', () => {
  it('venda parcial com lucro: custo remanescente 500, realizado +100', () => {
    const base = inv({ quantity: 10, averagePrice: 100, investedAmount: 1000 })
    const { investment, costRemoved, realizedGain } = applyTransactionDetailed(base, tx({ type: 'venda', quantity: 5, unitPrice: 120, amount: 600 }))
    expect(investment.investedAmount).toBe(500); expect(costRemoved).toBe(500); expect(realizedGain).toBe(100); expect(investment.quantity).toBe(5)
  })
  it('venda parcial com prejuízo: realizado -200, custo remanescente 500', () => {
    const { investment, costRemoved, realizedGain } = applyTransactionDetailed(inv({ quantity: 10, averagePrice: 100, investedAmount: 1000 }), tx({ type: 'venda', quantity: 5, unitPrice: 60, amount: 300 }))
    expect(investment.investedAmount).toBe(500); expect(costRemoved).toBe(500); expect(realizedGain).toBe(-200)
  })
  it('venda total com lucro e prejuízo', () => {
    const lucro = applyTransactionDetailed(inv({ quantity: 10, averagePrice: 100, investedAmount: 1000 }), tx({ type: 'venda', quantity: 10, unitPrice: 120, amount: 1200 }))
    expect(lucro.investment.investedAmount).toBe(0); expect(lucro.realizedGain).toBe(200)
    const prej = applyTransactionDetailed(inv({ quantity: 10, averagePrice: 100, investedAmount: 1000 }), tx({ type: 'venda', quantity: 10, unitPrice: 80, amount: 800 }))
    expect(prej.investment.investedAmount).toBe(0); expect(prej.realizedGain).toBe(-200)
  })
  it('vendas sucessivas com custo médio ponderado', () => {
    let cur = applyTransaction(inv({ quantity: 10, averagePrice: 100, investedAmount: 1000 }), tx({ type: 'compra', quantity: 10, unitPrice: 120, amount: 1200 }))
    expect(cur.averagePrice).toBe(110); expect(cur.investedAmount).toBe(2200)
    const s1 = applyTransactionDetailed(cur, tx({ type: 'venda', quantity: 10, unitPrice: 130, amount: 1300 }))
    expect(s1.costRemoved).toBe(1100); expect(s1.realizedGain).toBe(200); expect(s1.investment.investedAmount).toBe(1100)
    const s2 = applyTransactionDetailed(s1.investment, tx({ type: 'venda', quantity: 10, unitPrice: 90, amount: 900 }))
    expect(s2.costRemoved).toBe(1100); expect(s2.realizedGain).toBe(-200); expect(s2.investment.investedAmount).toBe(0); expect(s2.investment.quantity).toBe(0)
  })
  it('ativos fracionários com 8 casas decimais', () => {
    const r = applyTransaction(inv({ quantity: 0, averagePrice: 0, investedAmount: 0 }), tx({ type: 'compra', quantity: 0.00123456, unitPrice: 500000, amount: 617.28 }))
    expect(r.quantity).toBeCloseTo(0.00123456, 8); expect(r.investedAmount).toBe(617.28)
  })
  it('dividendos/rendimentos não alteram custo nem valor atual', () => {
    const base = inv({ investedAmount: 1000, currentValue: 1100 })
    const d = applyTransactionDetailed(base, tx({ type: 'dividendo', quantity: 0, unitPrice: 0, amount: 50 }))
    expect(d.investment.investedAmount).toBe(1000); expect(d.investment.currentValue).toBe(1100)
    const r = applyTransactionDetailed(base, tx({ type: 'rendimento', quantity: 0, unitPrice: 0, amount: 30 }))
    expect(r.investment.investedAmount).toBe(1000)
  })
  it('reversão: excluir venda restaura custo; excluir compra subtrai custo', () => {
    const base = inv({ quantity: 10, averagePrice: 100, investedAmount: 1000 })
    const venda = tx({ type: 'venda', quantity: 5, unitPrice: 120, amount: 600 })
    const after = applyTransaction(base, venda)
    const back = reverseTransaction(after, { ...venda, costRemoved: 500 })
    expect(back.investedAmount).toBe(1000); expect(back.quantity).toBe(10)
    const compra = tx({ type: 'compra', quantity: 10, unitPrice: 120, amount: 1200 })
    const withBuy = applyTransaction(base, compra)
    expect(reverseTransaction(withBuy, compra).investedAmount).toBe(1000)
  })
  it('gain não realizado por posição', () => {
    expect(investmentGain(inv({ investedAmount: 500, currentValue: 550 }))).toEqual({ gain: 50, pct: 10 })
    expect(investmentGain(inv({ investedAmount: 0, currentValue: 100 })).pct).toBe(0)
  })
})

describe('investimentos — dashboard separado e isolamento', () => {
  it('realizado, não realizado, rendimentos e retorno total sem duplicar patrimônio', () => {
    const venda = { ...tx({ id: 'v', type: 'venda', quantity: 5, unitPrice: 120, amount: 600, date: '2026-03-05' }), costRemoved: 500, realizedGain: 100 }
    const txs = [tx({ id: 'a', type: 'compra', amount: 1000, date: '2026-01-05' }), venda, tx({ id: 'b', type: 'dividendo', quantity: 0, unitPrice: 0, amount: 50, date: '2026-02-05' })]
    const s = summarizeInvestments([inv({ id: 'i1', investedAmount: 500, currentValue: 550 }), inv({ id: 'i2', category: 'Ações', institution: 'Corretora', investedAmount: 500, currentValue: 400 })], txs)
    expect(s.totalCurrent).toBe(950); expect(s.totalCostRemaining).toBe(1000)
    expect(s.realized).toBe(100); expect(s.unrealized).toBe(-50); expect(s.income).toBe(50); expect(s.totalReturn).toBe(100)
    // Capital líquido: inv.1 (1000-600=400) + inv.2 sem histórico (custo cadastrado 500) = 900; retorno 100/900 = 11,11%
    expect(s.totalReturnPct).toBe(11.11); expect(s.netCashInvested).toBe(900)
    expect(s.byCategory.find(c => c.name === 'Renda fixa')?.value).toBe(550)
    expect(s.evolution.at(-1)?.invested).toBe(900)
  })
  it('isolamento por usuário: filtro nunca vaza registros alheios', () => {
    const rows = [inv({ userId: 'u1' }), inv({ id: 'x', userId: 'u2' }), inv({ id: 'y', userId: 'u2' })]
    expect(filterByUser(rows, 'u1')).toHaveLength(1); expect(filterByUser(rows, 'u2')).toHaveLength(2); expect(filterByUser(rows, 'ninguem')).toHaveLength(0)
  })
})
