import { describe, it, expect } from 'vitest'
import { invoiceMonthFor, purchaseInstallments, invoiceForMonth, cardOutstanding, cardSummary, cardColor } from '../calculations/creditCards'
import type { CreditCard, CreditCardPurchase, CreditCardPayment } from '../types'

const card: CreditCard = { id: 'c1', userId: 'u1', name: 'Cartão', brand: 'Visa', limitAmount: 1000, closingDay: 30, dueDay: 31, color: '#0E9F6E', createdAt: '', updatedAt: '' }
const purchase = (over: Partial<CreditCardPurchase> = {}): CreditCardPurchase => ({ id: 'p1', userId: 'u1', cardId: 'c1', description: 'Notebook', category: 'Compras', totalAmount: 300, installments: 3, firstDate: '2026-01-05', notes: '', createdAt: '', updatedAt: '', ...over })

describe('cartões de crédito', () => {
  it('data posterior ao fechamento entra na fatura seguinte, com dia 31', () => {
    expect(invoiceMonthFor('2026-01-30', 30)).toBe('2026-01')
    expect(invoiceMonthFor('2026-01-31', 30)).toBe('2026-02')
  })
  it('parcelamento fecha a conta na última parcela sem perder centavos', () => {
    const items = purchaseInstallments(purchase({ totalAmount: 100, installments: 3 }), 30)
    expect(items.map(i => i.amount)).toEqual([33.33, 33.33, 33.34])
    expect(items.reduce((a, i) => a + i.amount, 0)).toBe(100)
    expect(items.map(i => i.month)).toEqual(['2026-01', '2026-02', '2026-03'])
  })
  it('fatura vence no último dia dos meses curtos e respeita pagamento', () => {
    const inv = invoiceForMonth(card, [purchase()], [], '2026-01')
    expect(inv.total).toBe(100)
    expect(inv.dueDate).toBe('2026-02-28')
    expect(inv.paid).toBe(false)
    const paid: CreditCardPayment[] = [{ cardId: 'c1', month: '2026-01', paidAt: '2026-02-01T00:00:00.000Z' }]
    expect(invoiceForMonth(card, [purchase()], paid, '2026-01').paid).toBe(true)
  })
  it('em aberto soma parcelas futuras não pagas e limita o disponível', () => {
    const p = purchase({ totalAmount: 300, installments: 3 })
    expect(cardOutstanding(card, [p], [], '2026-01')).toBe(300)
    const paid: CreditCardPayment[] = [{ cardId: 'c1', month: '2026-01', paidAt: '' }]
    expect(cardOutstanding(card, [p], paid, '2026-01')).toBe(200)
    expect(cardSummary(card, [p], [], '2026-01').available).toBe(700)
    expect(cardSummary(card, [p], [], '2026-01').usedPct).toBe(30)
    expect(cardColor({ ...card, color: 'azul' })).toBe('#0E9F6E')
  })
})
