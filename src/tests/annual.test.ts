import { describe, it, expect } from 'vitest'
import { annualSummary, compareAnnual, financialScore, spendingTrend, proInsights } from '../calculations/annual'
import type { Transaction } from '../types'

const tx: Transaction[] = [
  { id: '1', description: 'Salario', amount: 3000, type: 'in', category: 'Salário', date: '2026-01-05', createdAt: '' },
  { id: '2', description: 'Salario', amount: 3000, type: 'in', category: 'Salário', date: '2026-02-05', createdAt: '' },
  { id: '3', description: 'Mercado', amount: 500, type: 'out', category: 'Alimentação', date: '2026-01-10', createdAt: '' },
  { id: '4', description: 'Mercado', amount: 700, type: 'out', category: 'Alimentação', date: '2026-02-10', createdAt: '' },
  { id: '5', description: 'Bus', amount: 100, type: 'out', category: 'Transporte', date: '2026-01-11', createdAt: '' },
  { id: '6', description: 'Ano passado', amount: 9999, type: 'out', category: 'Outros', date: '2025-06-01', createdAt: '' },
]

describe('resumo anual', () => {
  it('soma só o ano escolhido', () => {
    const a = annualSummary(tx, 2026)
    expect(a.income).toBe(6000); expect(a.expense).toBe(1300); expect(a.balance).toBe(4700)
    expect(a.months).toHaveLength(12); expect(a.activeMonths).toBe(2)
  })
  it('média, melhor mês e categoria do ano', () => {
    const a = annualSummary(tx, 2026)
    expect(a.avgIncome).toBe(3000); expect(a.biggestCategory?.name).toBe('Alimentação')
    expect(a.bestMonth?.month).toBe('2026-01'); expect(a.savingsRate).toBeGreaterThan(70)
  })
  it('ano vazio não quebra', () => { const a = annualSummary([], 2026); expect(a.balance).toBe(0); expect(a.bestMonth).toBeUndefined() })
  it('comparativo com ano anterior', () => {
    const c = compareAnnual(tx, 2026)
    expect(c.hasPrev).toBe(true); expect(c.prev.expense).toBe(9999); expect(c.expenseDiff).toBeLessThan(0)
    expect(compareAnnual(tx, 2025).hasPrev).toBe(false)
  })
  it('score 0-100: quem guarda mais pontua mais', () => {
    expect(financialScore(tx, 2026).score).toBeGreaterThan(70)
    expect(financialScore([], 2026).score).toBe(0)
    const bad: Transaction[] = [{ id: 'x', description: 'g', amount: 2000, type: 'out', category: 'Compras', date: '2026-03-01', createdAt: '' }, { id: 'y', description: 's', amount: 1000, type: 'in', category: 'Salário', date: '2026-03-01', createdAt: '' }]
    expect(financialScore(bad, 2026).score).toBeLessThan(financialScore(tx, 2026).score)
  })
  it('tendência de gastos', () => {
    const ref = new Date('2026-02-15T12:00:00')
    const older: Transaction[] = [
      { id: 'o1', description: 'g', amount: 100, type: 'out', category: 'Outros', date: '2025-09-01', createdAt: '' },
      { id: 'o2', description: 'g', amount: 100, type: 'out', category: 'Outros', date: '2025-10-01', createdAt: '' },
      { id: 'o3', description: 'g', amount: 100, type: 'out', category: 'Outros', date: '2025-11-01', createdAt: '' },
    ]
    expect(spendingTrend([...tx, ...older], ref).direction).toBe('subiu')
    expect(spendingTrend(tx, ref).direction).toBe('igual')
  })
  it('dicas pro em linguagem simples', () => { expect(proInsights(tx, 2026, new Date('2026-02-15T12:00:00')).join(' ')).toContain('Alimentação') })
})
