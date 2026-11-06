import { describe, it, expect } from 'vitest'
import { summarize, validateTransaction, goalProgress, monthlyHistory, monthKey, shiftMonth, overallBalance, budgetStatus, billsSummary, forecast, onboardingSteps, dateForDay, isRecurrenceLaunched } from '../calculations/personal'
import type { Transaction, FixedBill } from '../types'

const ref = new Date('2026-11-15T12:00:00')
const tx: Transaction[] = [
  { id: '1', description: 'Salário', amount: 3000, type: 'in', category: 'Salário', date: '2026-11-05', createdAt: '' },
  { id: '2', description: 'Supermercado', amount: 450, type: 'out', category: 'Alimentação', date: '2026-11-10', createdAt: '' },
  { id: '3', description: 'Ônibus', amount: 100, type: 'out', category: 'Transporte', date: '2026-11-11', createdAt: '' },
  { id: '4', description: 'Mês passado', amount: 9999, type: 'out', category: 'Outros', date: '2026-10-01', createdAt: '' },
]
const bills: FixedBill[] = [{ id: 'b1', name: 'Aluguel', amount: 1200, dueDay: 10, category: 'Moradia', createdAt: '' }]

describe('finanças pessoais (linguagem simples)', () => {
  it('resumo do mês ignora outro mês', () => {
    const s = summarize(tx, bills, '2026-11', ref)
    expect(s.income).toBe(3000); expect(s.expense).toBe(550); expect(s.balance).toBe(2450)
  })
  it('desconta contas fixas e calcula gasto por dia', () => {
    const s = summarize(tx, bills, '2026-11', ref)
    expect(s.billsTotal).toBe(1200); expect(s.afterBills).toBe(1250)
    expect(s.dailyAllowance).toBeGreaterThan(0); expect(s.dailyAllowance).toBeLessThanOrEqual(1250 / s.daysLeft + 0.01)
  })
  it('categoria mais gastada e dicas em português simples', () => {
    const s = summarize(tx, bills, '2026-11', ref)
    expect(s.biggest?.name).toBe('Alimentação'); expect(s.insights.length).toBeGreaterThan(0)
  })
  it('mês vazio sugere começar', () => {
    const s = summarize([], [], '2026-11', ref)
    expect(s.balance).toBe(0); expect(s.insights[0]).toContain('Comece')
  })
  it('validação rejeita sem nome/valor', () => {
    expect(validateTransaction({} as any).length).toBeGreaterThan(0)
    expect(validateTransaction({ description: 'Salário', amount: 1, type: 'in', category: 'Salário', date: '2026-11-01' })).toEqual([])
  })
  it('meta: progresso e quanto guardar por mês', () => {
    const p = goalProgress({ id: 'g', name: 'Viagem', target: 2000, saved: 500, deadline: '2027-05-01', createdAt: '' } as any)
    expect(p.pct).toBe(25); expect(p.remaining).toBe(1500); expect(p.perMonth).toBeGreaterThan(0)
  })
  it('histórico de 6 meses', () => {
    const h = monthlyHistory(tx, 6, ref); expect(h).toHaveLength(6); expect(h[5].expense).toBe(550)
  })
  it('monthKey/shiftMonth', () => { expect(monthKey('2026-01-15')).toBe('2026-01'); expect(shiftMonth('2026-01', -1)).toBe('2025-12') })
  it('saldo total acumulado somando todos os meses', () => { expect(overallBalance(tx)).toBe(3000 - 550 - 9999) })
  it('orçamento: dentro, atenção e estourou', () => {
    const r = budgetStatus(tx, [{ category: 'Alimentação', limit: 400 }, { category: 'Transporte', limit: 200 }, { category: 'Lazer', limit: 100 }], '2026-11')
    expect(r.find(x => x.category === 'Alimentação')?.status).toBe('estourou')
    expect(r.find(x => x.category === 'Transporte')?.status).toBe('ok')
    expect(r.find(x => x.category === 'Lazer')?.spent).toBe(0)
  })
  it('contas: paga, pendente, vencida e próxima', () => {
    const r = billsSummary(bills, [{ billId: 'b1', month: '2026-11', paidAt: '' }], '2026-11', ref)
    expect(r.paidTotal).toBe(1200); expect(r.pendingTotal).toBe(0)
    const r2 = billsSummary([{ ...bills[0], dueDay: 5 }], [], '2026-11', ref)
    expect(r2.overdue).toHaveLength(1); expect(r2.pendingTotal).toBe(1200)
  })
  it('previsão: se continuar assim até o fim do mês', () => {
    const f = forecast(tx, bills, '2026-11', ref)
    expect(f.day).toBe(15); expect(f.projectedExpense).toBeGreaterThan(550); expect(f.projectedAfterBills).toBeLessThan(f.projectedBalance)
  })
  it('checklist de primeiros passos', () => { const s = onboardingSteps(tx, bills, [], []); expect(s[0].done).toBe(true); expect(s[3].done).toBe(false); expect(s.filter(x => x.done)).toHaveLength(3) })
  it('recorrência: data no dia e lançamento único por mês', () => {
    expect(dateForDay('2026-02', 31)).toBe('2026-02-28')
    const r: any = { id: 'r1', day: 5 }
    expect(isRecurrenceLaunched([{ recurrenceId: 'r1', month: '2026-11' }], r, '2026-11')).toBe(true)
    expect(isRecurrenceLaunched([], r, '2026-11')).toBe(false)
  })
})
