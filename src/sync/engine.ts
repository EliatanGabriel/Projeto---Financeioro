/**
 * Motor de sincronização (lógica pura, testável): fila de tombstones, diff por hash,
 * detecção de conflitos e política de retry — sem depender de rede ou do Supabase.
 * O adaptador real (Supabase) injeta fetchAll/upsert/softDelete; testes injetam um fake.
 */
export type SyncEntity = 'transactions'|'fixed_bills'|'goals'|'budgets'|'bill_payments'|'recurrences'|'recurrence_launches'|'categories'|'goal_auto_launches'|'investments'|'investment_transactions'|'credit_cards'|'credit_card_purchases'|'credit_card_payments'
export const SYNC_ENTITIES: SyncEntity[] = ['transactions','fixed_bills','goals','budgets','bill_payments','recurrences','recurrence_launches','categories','goal_auto_launches','investments','investment_transactions','credit_cards','credit_card_purchases','credit_card_payments']
export interface SyncRow { id: string; userId: string; updatedAt?: string; version?: number; deletedAt?: string | null; [k: string]: any }
export interface SyncQueueOp { opId: string; entity: SyncEntity; recordId: string; op: 'upsert' | 'delete'; payload: any; baseVersion: number; userId?: string; attempts: number; nextRetryAt: string | null; createdAt: string }
export interface SyncConflict { id: string; entity: SyncEntity; recordId: string; local: any; remote: any; localVersion: number; remoteVersion: number; createdAt: string; resolvedAt: string | null }

export function canonicalHash(row: any): string {
  const canon = (x: any): string => {
    if (x === null || x === undefined || x === '') return '""'
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x)) { const t = Date.parse(x); if (!Number.isNaN(t)) return JSON.stringify(new Date(t).toISOString()) }
    if (typeof x !== 'object') return JSON.stringify(x)
    return Array.isArray(x) ? `[${x.map(canon).join(',')}]` : `{${Object.keys(x).sort().filter(k => k !== '__sync' && k !== 'version' && k !== 'updatedAt' && k !== 'deletedAt').map(k => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`
  }
  let h1 = 5381, h2 = 52711
  const s = canon(row)
  for (let i = 0; i < s.length; i++) { h1 = ((h1 << 5) + h1 + s.charCodeAt(i)) >>> 0; h2 = ((h2 << 5) + h2 + s.charCodeAt(i)) >>> 0 }
  return `${h1.toString(16)}-${h2.toString(16)}-${s.length}`
}
export const newOpId = () => (crypto as any)?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
export function nextRetryAt(attempts: number, now = Date.now()): string {
  const backoff = [1000, 5000, 30000, 120000, 300000][Math.min(attempts, 4)]
  return new Date(now + backoff).toISOString()
}
export function makeUpsertOp(entity: SyncEntity, row: SyncRow, baseVersion = 0): SyncQueueOp {
  return { opId: newOpId(), entity, recordId: row.id, op: 'upsert', payload: row, baseVersion, attempts: 0, nextRetryAt: null, createdAt: new Date().toISOString() }
}
export function makeDeleteOp(entity: SyncEntity, row: SyncRow): SyncQueueOp {
  return { opId: newOpId(), entity, recordId: row.id, op: 'delete', payload: { id: row.id, userId: row.userId, deletedAt: new Date().toISOString() }, baseVersion: row.version || 0, attempts: 0, nextRetryAt: null, createdAt: new Date().toISOString() }
}

/** Compara local/remoto/meta (último hash sincronizado) e classifica cada registro. */
export function diffRecords(entity: SyncEntity, local: SyncRow[], remote: SyncRow[], meta: Map<string, { hash: string; version: number }>) {
  const remoteById = new Map(remote.map(r => [r.id, r]))
  const localById = new Map(local.map(r => [r.id, r]))
  const toPush: SyncRow[] = []; const toPull: SyncRow[] = []; const conflicts: SyncConflict[] = []; const tombstonesToPush: SyncRow[] = []
  const now = new Date().toISOString()
  for (const l of local) {
    const r = remoteById.get(l.id)
    const m = meta.get(l.id)
    const lh = canonicalHash(l)
    if (!r) { if (!m || m.hash !== lh) toPush.push(l); continue }
    const rh = canonicalHash(r)
    if (r.deletedAt) { if (!m || m.hash !== lh) tombstonesToPush.push(r); continue }
    if (m) {
      const localChanged = lh !== m.hash; const remoteChanged = rh !== m.hash
      if (localChanged && remoteChanged && lh !== rh) {
        conflicts.push({ id: newOpId(), entity, recordId: l.id, local: l, remote: r, localVersion: l.version || 1, remoteVersion: r.version || 1, createdAt: now, resolvedAt: null })
      } else if (localChanged) toPush.push(l)
      else if (remoteChanged) toPull.push(r)
    } else if (lh !== rh) toPush.push(l)
  }
  for (const r of remote) {
    if (!localById.has(r.id) && !r.deletedAt) toPull.push(r)
  }
  return { toPush, toPull, conflicts, tombstonesToPush }
}

/** Processa a fila de tombstones: cada op é idempotente (soft-delete por id). Retorna ops ainda pendentes. */
export async function processQueue(ops: SyncQueueOp[], client: { softDelete(entity: SyncEntity, id: string): Promise<void> }, now = Date.now()) {
  const done: string[] = []; const pending: SyncQueueOp[] = []
  for (const op of ops) {
    if (op.nextRetryAt && new Date(op.nextRetryAt).getTime() > now) { pending.push(op); continue }
    try { await client.softDelete(op.entity, op.recordId); done.push(op.opId) }
    catch { pending.push({ ...op, attempts: op.attempts + 1, nextRetryAt: nextRetryAt(op.attempts, now) }) }
  }
  return { done, pending }
}
export function resolveConflict(conflict: SyncConflict, choice: 'local' | 'remote'): SyncRow {
  // 'local' prevalece no próximo push (versão do remoto+1); 'remote' aceita a nuvem e descarta a cópia local da fila.
  return choice === 'local' ? { ...conflict.local, version: conflict.remoteVersion + 1 } : conflict.remote
}
