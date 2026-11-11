import type { CreditCard, CreditCardPayment, CreditCardPurchase } from '../types'
import { monthKey, shiftMonth } from './personal'

const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100

export function invoiceMonthFor(date: string, closingDay: number): string {
  const d = new Date((date || '').slice(0, 10) + 'T12:00:00')
  if (isNaN(d.getTime())) return monthKey(new Date())
  const closing = Math.max(1, Math.min(28, Math.round(closingDay || 1)))
  const base = monthKey(d)
  return d.getDate() > closing ? shiftMonth(base, 1) : base
}

export interface Installment {
  month: string
  number: number
  amount: number
}

export function purchaseInstallments(purchase: CreditCardPurchase, closingDay: number): Installment[] {
  const count = Math.max(1, Math.min(60, Math.round(purchase.installments || 1)))
  const total = r2(purchase.totalAmount)
  const base = r2(Math.floor((total / count) * 100) / 100)
  const first = invoiceMonthFor(purchase.firstDate, closingDay)
  const out: Installment[] = []
  let allocated = 0
  for (let i = 0; i < count; i++) {
    const amount = i === count - 1 ? r2(total - allocated) : base
    allocated = r2(allocated + amount)
    out.push({ month: shiftMonth(first, i), number: i + 1, amount })
  }
  return out
}

export interface InvoiceItem {
  purchase: CreditCardPurchase
  installment: Installment
}

export interface Invoice {
  month: string
  dueDate: string
  items: InvoiceItem[]
  total: number
  paid: boolean
}

export function invoiceForMonth(card: CreditCard, purchases: CreditCardPurchase[], payments: CreditCardPayment[], month: string): Invoice {
  const items: InvoiceItem[] = []
  for (const purchase of purchases.filter((p) => p.cardId === card.id)) {
    for (const installment of purchaseInstallments(purchase, card.closingDay)) {
      if (installment.month === month) items.push({ purchase, installment })
    }
  }
  const dueMonth = shiftMonth(month, 1)
  const [y, m] = dueMonth.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  const dueDay = Math.min(Math.max(1, card.dueDay || 10), lastDay)
  const dueDate = `${dueMonth}-${String(dueDay).padStart(2, '0')}`
  return {
    month,
    dueDate,
    items,
    total: r2(items.reduce((a, i) => a + i.installment.amount, 0)),
    paid: payments.some((p) => p.cardId === card.id && p.month === month),
  }
}

export function cardOutstanding(card: CreditCard, purchases: CreditCardPurchase[], payments: CreditCardPayment[], fromMonth: string): number {
  const paid = new Set(payments.filter((p) => p.cardId === card.id).map((p) => p.month))
  let total = 0
  for (const purchase of purchases.filter((p) => p.cardId === card.id)) {
    for (const installment of purchaseInstallments(purchase, card.closingDay)) {
      if (installment.month >= fromMonth && !paid.has(installment.month)) total += installment.amount
    }
  }
  return r2(total)
}

export function cardSummary(card: CreditCard, purchases: CreditCardPurchase[], payments: CreditCardPayment[], month = monthKey(new Date())) {
  const invoice = invoiceForMonth(card, purchases, payments, month)
  const nextInvoice = invoiceForMonth(card, purchases, payments, shiftMonth(month, 1))
  const outstanding = cardOutstanding(card, purchases, payments, month)
  const limit = r2(card.limitAmount)
  return {
    invoice,
    nextInvoice,
    outstanding,
    limit,
    available: limit > 0 ? r2(Math.max(0, limit - outstanding)) : 0,
    usedPct: limit > 0 ? Math.min(100, Math.round((outstanding / limit) * 100)) : 0,
  }
}

export function cardColor(card: CreditCard): string {
  return /^#[0-9a-f]{6}$/i.test(card.color || '') ? card.color : '#0E9F6E'
}
