import { describe, it, expect } from 'vitest'
import { canonicalHash } from '../sync/engine'
import { fromRemoteRow, stableId, toRemoteRow } from '../sync/mapping'

describe('sync — mapeamento local ↔ Supabase', () => {
  it('gera IDs naturais estáveis para tabelas com PK composta', () => {
    expect(stableId('budgets', { category: 'Moradia' })).toBe('Moradia')
    expect(stableId('categories', { name: 'Lazer', type: 'out' })).toBe('out:Lazer')
    expect(stableId('bill_payments', { billId: 'b1', month: '2026-01' })).toBe('b1:2026-01')
    expect(stableId('recurrence_launches', { recurrenceId: 'r1', month: '2026-01' })).toBe('r1:2026-01')
    expect(stableId('goal_auto_launches', { goalId: 'g1', month: '2026-01' })).toBe('g1:2026-01')
    expect(stableId('transactions', { id: 't1' })).toBe('t1')
  })

  it('toRemoteRow envia somente colunas da nuvem (sem id em PK composta)', () => {
    expect(toRemoteRow('budgets', { id: 'Moradia', userId: 'u1', category: 'Moradia', limit: 500, version: 1 })).toEqual({ user_id: 'u1', category: 'Moradia', limit: 500, version: 1 })
    expect(toRemoteRow('investment_transactions', { id: 'x', userId: 'u1', investmentId: 'i1', type: 'compra', quantity: 1, unitPrice: 10, amount: 10, date: '2026-01-01', description: '', costRemoved: 0, realizedGain: 0, createdAt: '2026-01-01T00:00:00.000Z', version: 1 } as any)).toEqual({ id: 'x', user_id: 'u1', investment_id: 'i1', type: 'compra', quantity: 1, unit_price: 10, amount: 10, date: '2026-01-01', description: '', cost_removed: 0, realized_gain: 0, created_at: '2026-01-01T00:00:00.000Z', version: 1 })
  })

  it('fromRemoteRow devolve o formato local e faz round-trip de hash', () => {
    const local = { id: 'i1', userId: 'u1', name: 'CDB', category: 'Renda fixa', ticker: '', institution: 'Banco', quantity: 2, averagePrice: 50, investedAmount: 100, currentValue: 110, startedAt: '2026-01-01', notes: '', createdAt: '2026-01-01T00:00:00.000Z', version: 1 }
    const remote = { id: 'i1', user_id: 'u1', name: 'CDB', category: 'Renda fixa', ticker: '', institution: 'Banco', quantity: '2', average_price: '50.00', invested_amount: '100.00', current_value: '110.00', started_at: '2026-01-01', notes: '', created_at: '2026-01-01T00:00:00+00:00', updated_at: '2026-02-01T00:00:00+00:00', version: 3, deleted_at: null }
    const mapped = fromRemoteRow('investments', remote)
    expect(mapped).toMatchObject({ id: 'i1', userId: 'u1', quantity: 2, averagePrice: 50, investedAmount: 100, currentValue: 110, version: 3 })
    expect(canonicalHash(mapped)).toBe(canonicalHash(local))
  })

  it('hash ignora versão/updatedAt e normaliza null, vazio e timestamps', () => {
    const a = { id: '1', userId: 'u1', name: 'Meta', target: 100, saved: 0, deadline: '', createdAt: '2026-01-01T00:00:00.000Z', version: 1 }
    const b = { id: '1', userId: 'u1', name: 'Meta', target: 100, saved: 0, deadline: null, createdAt: '2026-01-01T00:00:00+00:00', updatedAt: '2026-05-01T00:00:00.000Z', version: 9, deletedAt: null }
    expect(canonicalHash(a)).toBe(canonicalHash(b))
    expect(canonicalHash({ ...a, saved: 10 })).not.toBe(canonicalHash(a))
  })

  it('mapeia contas e metas com campos opcionais nulos', () => {
    const goal = fromRemoteRow('goals', { id: 'g1', user_id: 'u1', name: 'Viagem', target: '1000.00', saved: '200.00', deadline: null, auto_monthly: '50.00', created_at: '2026-01-01T00:00:00+00:00', version: 1 })
    expect(goal).toMatchObject({ id: 'g1', name: 'Viagem', target: 1000, saved: 200, deadline: '', autoMonthly: 50 })
    const bill = fromRemoteRow('fixed_bills', { id: 'b1', user_id: 'u1', name: 'Luz', amount: '80.00', due_day: 10, category: 'Contas da casa', created_at: '2026-01-01T00:00:00+00:00', version: 1 })
    expect(bill).toMatchObject({ id: 'b1', name: 'Luz', dueDay: 10, category: 'Contas da casa' })
  })
})
