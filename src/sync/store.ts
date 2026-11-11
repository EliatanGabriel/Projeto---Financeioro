import * as db from '../database/db'
import { canonicalHash } from './engine'
import type { SyncEntity, SyncRow, SyncQueueOp, SyncConflict } from './engine'

export const SYNC_ENTITIES: SyncEntity[] = ['transactions','fixed_bills','goals','budgets','bill_payments','recurrences','recurrence_launches','categories','goal_auto_launches','investments','investment_transactions']

const LISTERS: Record<string, (u: string) => Promise<any[]>> = {
  transactions: u => db.listTransactions(u), fixed_bills: u => db.listFixedBills(u), goals: u => db.listGoals(u),
  budgets: u => db.listBudgets(u), bill_payments: u => db.listBillPayments(u), recurrences: u => db.listRecurrences(u),
  recurrence_launches: u => db.listRecurrenceLaunches(u), categories: u => db.listCategories(u),
  goal_auto_launches: u => db.listGoalAutoLaunches(u), investments: u => db.listInvestments(u), investment_transactions: u => db.listAllInvestmentTransactions(u),
}
const UPSERTS: Record<string, (row: any, u: string) => Promise<any>> = {
  transactions: (r, u) => db.addTransaction({ ...r, userId: u }), fixed_bills: (r, u) => db.upsertFixedBill({ ...r, userId: u }),
  goals: (r, u) => db.upsertGoal({ ...r, userId: u }), budgets: (r, u) => db.setBudget(r.category, r.limit, u).then(() => r),
  bill_payments: (r, u) => db.setBillPaid(r.billId, r.month, true, u).then(() => r), recurrences: (r, u) => db.upsertRecurrence({ ...r, userId: u }),
  recurrence_launches: (r, u) => db.markRecurrenceLaunched(r.recurrenceId, r.month, u).then(() => r), categories: (r, u) => db.addCategory(r.name, r.type, u).then(() => r),
  goal_auto_launches: (r, u) => db.markGoalAutoLaunched(r.goalId, r.month, u).then(() => r), investments: (r, u) => db.upsertInvestment({ ...r, userId: u }),
  investment_transactions: async (r, u) => { const invs = await db.listInvestments(u); const inv = invs.find((i: any) => i.id === r.investmentId); if (!inv) throw new Error('Investimento não encontrado para este usuário'); const { applyTransactionDetailed, reverseTransaction } = await import('../calculations/investments'); const existing = await db.getInvestmentTransaction(r.id, u); let base: any = inv; if (existing && existing.investmentId === r.investmentId) { const same = existing.type === r.type && Math.abs(existing.amount - (r.amount || 0)) < 0.005 && Math.abs((existing.quantity || 0) - (r.quantity || 0)) < 1e-8 && Math.abs((existing.unitPrice || 0) - (r.unitPrice || 0)) < 0.005 && existing.date === r.date && (existing.description || '') === (r.description || ''); if (same) return existing; base = reverseTransaction(inv, existing) } const { investment: updated, costRemoved, realizedGain } = applyTransactionDetailed(base, r); return db.addInvestmentTransaction({ ...r, costRemoved, realizedGain }, updated) },
}
const DELETES: Record<string, (id: string, u: string) => Promise<any>> = {
  transactions: (id, u) => db.deleteTransaction(id, u), fixed_bills: (id, u) => db.deleteFixedBill(id, u), goals: (id, u) => db.deleteGoal(id, u),
  budgets: (id, u) => db.setBudget(id, 0, u), bill_payments: (_id, _u) => Promise.resolve(), recurrences: (id, u) => db.deleteRecurrence(id, u),
  recurrence_launches: (_id, _u) => Promise.resolve(), categories: (_id, _u) => Promise.resolve(), goal_auto_launches: (_id, _u) => Promise.resolve(),
  investments: (id, u) => db.deleteInvestment(id, u), investment_transactions: (_id, _u) => Promise.resolve(),
}

export function makeSyncStore(userId: string) {
  return {
    async listLocal(entity: SyncEntity): Promise<SyncRow[]> {
      const rows = await LISTERS[entity](userId)
      return rows.map((r: any, i: number) => ({ ...r, id: r.id ?? `${entity}-${i}`, userId, version: 1 }))
    },
    async replaceLocal(entity: SyncEntity, rows: SyncRow[]) {
      for (const row of rows) {
        const up = UPSERTS[entity]; if (!up) continue
        await up(row, userId)
      }
    },
    async getMeta(entity: SyncEntity) { return db.getSyncMeta(entity, userId) },
    async setMeta(entity: SyncEntity, meta: Map<string, { hash: string; version: number }>) { await db.setSyncMeta(entity, userId, meta) },
    async getLastPulledAt(entity: SyncEntity) { const s = await db.getSyncState(entity); return s.lastPulledAt || null },
    async setLastPulledAt(entity: SyncEntity, ts: string) { const s = await db.getSyncState(entity); await db.setSyncState(entity, ts, s.lastSyncAt || ts) },
    async getQueue(): Promise<SyncQueueOp[]> { return db.listSyncQueue(userId) },
    async saveQueue(ops: SyncQueueOp[]) { await db.saveSyncQueue(ops.map(o => ({ ...o, userId }))) },
    async addConflicts(conflicts: SyncConflict[]) { await db.addSyncConflicts(conflicts, userId) },
    async getConflicts() { return db.listSyncConflicts(userId) },
    async resolveConflictLocal(entity: SyncEntity, recordId: string, row: SyncRow) {
      const up = UPSERTS[entity]; if (up) await up(row, userId)
      const meta = await db.getSyncMeta(entity, userId); meta.set(recordId, { hash: canonicalHash(row), version: row.version || 1 }); await db.setSyncMeta(entity, userId, meta)
    },
    async deleteLocal(entity: SyncEntity, id: string) { const del = DELETES[entity]; if (del) await del(id, userId) },
  }
}
export { canonicalHash }
