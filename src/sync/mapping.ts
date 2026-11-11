import type { SyncEntity, SyncRow } from './engine'

/**
 * Mapeamento explícito entre o formato local (camelCase, usado pelo SQLite e pelo motor)
 * e as colunas do Postgres/Supabase (snake_case). Manter isso explícito evita que campos
 * internos do motor (version, deletedAt) ou nomes de colunas vazem no upsert.
 */
const REMOTE_OF: Record<string, string> = {
  userId: 'user_id', createdAt: 'created_at', updatedAt: 'updated_at', deletedAt: 'deleted_at',
  dueDay: 'due_day', autoMonthly: 'auto_monthly', billId: 'bill_id', recurrenceId: 'recurrence_id', goalId: 'goal_id',
  averagePrice: 'average_price', investedAmount: 'invested_amount', currentValue: 'current_value', startedAt: 'started_at',
  investmentId: 'investment_id', unitPrice: 'unit_price', costRemoved: 'cost_removed', realizedGain: 'realized_gain',
  cardId: 'card_id', limitAmount: 'limit_amount', closingDay: 'closing_day', totalAmount: 'total_amount', firstDate: 'first_date',
}

const FIELDS: Record<SyncEntity, string[]> = {
  transactions: ['description', 'amount', 'type', 'category', 'date', 'note', 'createdAt'],
  fixed_bills: ['name', 'amount', 'dueDay', 'category', 'createdAt'],
  goals: ['name', 'target', 'saved', 'deadline', 'autoMonthly', 'createdAt'],
  budgets: ['category', 'limit'],
  bill_payments: ['billId', 'month', 'paidAt'],
  recurrences: ['description', 'amount', 'type', 'category', 'day', 'active', 'createdAt'],
  recurrence_launches: ['recurrenceId', 'month'],
  categories: ['name', 'type'],
  goal_auto_launches: ['goalId', 'month'],
  investments: ['name', 'category', 'ticker', 'institution', 'quantity', 'averagePrice', 'investedAmount', 'currentValue', 'startedAt', 'notes', 'createdAt'],
  investment_transactions: ['investmentId', 'type', 'quantity', 'unitPrice', 'amount', 'date', 'description', 'costRemoved', 'realizedGain', 'createdAt'],
  credit_cards: ['name', 'brand', 'limitAmount', 'closingDay', 'dueDay', 'color', 'createdAt', 'updatedAt'],
  credit_card_purchases: ['cardId', 'description', 'category', 'totalAmount', 'installments', 'firstDate', 'notes', 'createdAt', 'updatedAt'],
  credit_card_payments: ['cardId', 'month', 'paidAt'],
}

const NUMERIC = new Set(['amount', 'target', 'saved', 'autoMonthly', 'limit', 'quantity', 'averagePrice', 'investedAmount', 'currentValue', 'unitPrice', 'costRemoved', 'realizedGain', 'dueDay', 'day', 'limitAmount', 'closingDay', 'totalAmount', 'installments'])

/** Entidades cuja PK na nuvem é composta (não têm `id`). O motor usa uma chave natural estável. */
const NATURAL = new Set<SyncEntity>(['budgets', 'categories', 'bill_payments', 'recurrence_launches', 'goal_auto_launches', 'credit_card_payments'])
export const HAS_UPDATED_AT = new Set<SyncEntity>(['transactions', 'fixed_bills', 'goals', 'recurrences', 'investments', 'investment_transactions', 'credit_cards', 'credit_card_purchases'])

export function stableId(entity: SyncEntity, row: any): string {
  switch (entity) {
    case 'budgets': return String(row.category || '')
    case 'categories': return `${row.type || ''}:${row.name || ''}`
    case 'bill_payments': return `${row.billId || ''}:${row.month || ''}`
    case 'recurrence_launches': return `${row.recurrenceId || ''}:${row.month || ''}`
    case 'goal_auto_launches': return `${row.goalId || ''}:${row.month || ''}`
    case 'credit_card_payments': return `${row.cardId || ''}:${row.month || ''}`
    default: return String(row.id || '')
  }
}

export function toRemoteRow(entity: SyncEntity, row: SyncRow): Record<string, any> {
  const out: Record<string, any> = { user_id: row.userId }
  if (!NATURAL.has(entity)) out.id = row.id
  for (const field of FIELDS[entity]) {
    if (row[field] === undefined) continue
    out[REMOTE_OF[field] || field] = row[field]
  }
  if (row.version !== undefined && !NATURAL.has(entity)) out.version = row.version
  return out
}

export function fromRemoteRow(entity: SyncEntity, remote: any): SyncRow {
  const data: any = {}
  for (const field of FIELDS[entity]) {
    const value = remote[REMOTE_OF[field] || field]
    if (value === undefined) continue
    data[field] = NUMERIC.has(field) ? Number(value ?? 0) : value
    if (data[field] === null && !NUMERIC.has(field)) data[field] = ''
  }
  if (!NATURAL.has(entity)) data.id = String(remote.id || '')
  const row: SyncRow = { ...data, userId: String(remote.user_id || ''), version: Number(remote.version || 1) }
  if (remote.deleted_at) row.deletedAt = remote.deleted_at
  row.id = stableId(entity, row)
  return row
}
