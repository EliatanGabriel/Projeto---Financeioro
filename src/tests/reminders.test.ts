import { describe, it, expect } from 'vitest'
import { parseReminderSettings, dueBills, reminderMessage, reminderFingerprint } from '../utils/reminders'
import type { FixedBill } from '../types'

const bill = (id: string, dueDay: number): FixedBill => ({ id, name: `Conta ${id}`, amount: 10, dueDay, category: 'Outros', createdAt: '' })

describe('lembretes de contas', () => {
  it('zero é um valor válido: avisar no dia e às 00:00', () => {
    expect(parseReminderSettings(JSON.stringify({ enabled: true, daysBefore: 0, hour: 0 }))).toEqual({ enabled: true, daysBefore: 0, hour: 0 })
    expect(parseReminderSettings('invalido').daysBefore).toBe(3)
    expect(parseReminderSettings(JSON.stringify({ daysBefore: 99, hour: -5 }))).toMatchObject({ daysBefore: 14, hour: 0 })
  })
  it('ignora contas pagas e avisa no dia do vencimento', () => {
    const now = new Date(2026, 1, 10, 12)
    const bills = [bill('a', 10), bill('b', 13)]
    expect(dueBills(bills, [], now, 0).map(d => d.bill.id)).toEqual(['a'])
    expect(dueBills(bills, [{ billId: 'a', month: '2026-02', paidAt: '' }], now, 3).map(d => d.bill.id)).toEqual(['b'])
    expect(reminderMessage(dueBills([bill('a', 10)], [], now, 0))).toBe('Conta a vence hoje')
    expect(reminderFingerprint(dueBills([bill('a', 10)], [], now, 0), now)).toBe('2026-02-10:a')
  })
})
