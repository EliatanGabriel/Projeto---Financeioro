import { canonicalHash, diffRecords, processQueue, type SyncEntity, type SyncQueueOp, type SyncConflict } from './engine'

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'conflict'
export interface SyncState { status: SyncStatus; lastSyncAt: string | null; pending: number; conflicts: SyncConflict[]; message: string | null }

export interface SyncClient {
  fetchAll(entity: SyncEntity, since?: string): Promise<any[]>
  upsert(entity: SyncEntity, row: any): Promise<any>
  softDelete(entity: SyncEntity, id: string): Promise<void>
}
export interface SyncStore {
  listLocal(entity: SyncEntity): Promise<any[]>
  replaceLocal(entity: SyncEntity, rows: any[]): Promise<void>
  getMeta(entity: SyncEntity): Promise<Map<string, { hash: string; version: number }>>
  setMeta(entity: SyncEntity, meta: Map<string, { hash: string; version: number }>): Promise<void>
  getLastPulledAt(entity: SyncEntity): Promise<string | null>
  setLastPulledAt(entity: SyncEntity, ts: string): Promise<void>
  getQueue(): Promise<SyncQueueOp[]>
  saveQueue(ops: SyncQueueOp[]): Promise<void>
  addConflicts(conflicts: SyncConflict[]): Promise<void>
  getConflicts(): Promise<SyncConflict[]>
  resolveConflictLocal(entity: SyncEntity, recordId: string, row: any): Promise<void>
}

export async function syncAll(store: SyncStore, client: SyncClient, entities: SyncEntity[], onState: (s: SyncState) => void): Promise<SyncState> {
  onState({ status: 'syncing', lastSyncAt: null, pending: 0, conflicts: [], message: null })
  const conflicts: SyncConflict[] = []
  try {
    // 1) Tombstones pendentes primeiro (idempotentes por id)
    const queue = await store.getQueue()
    if (queue.length) {
      const { pending } = await processQueue(queue, client)
      await store.saveQueue(pending)
      if (pending.length) { const s = { status: 'offline' as const, lastSyncAt: null, pending: pending.length, conflicts: [], message: 'Operações pendentes de exclusão.' }; onState(s); return s }
    }
    // 2) Por entidade: push do que mudou localmente, pull do que mudou na nuvem, conflito nunca sobrescreve
    for (const entity of entities) {
      const local = await store.listLocal(entity)
      const remote = await client.fetchAll(entity)
      const meta = await store.getMeta(entity)
      const { toPush, toPull, conflicts: cs } = diffRecords(entity, local, remote, meta)
      conflicts.push(...cs)
      const newMeta = new Map(meta)
      for (const row of toPush) {
        const saved = await client.upsert(entity, { ...row, version: (remote.find(r => r.id === row.id)?.version || 0) + 1 })
        newMeta.set(row.id, { hash: canonicalHash(row), version: saved.version || row.version || 1 })
      }
      for (const row of toPull) {
        if (cs.some(c => c.recordId === row.id)) continue
        await store.replaceLocal(entity, [row])
        newMeta.set(row.id, { hash: canonicalHash(row), version: row.version || 1 })
      }
      await store.setMeta(entity, newMeta)
      await store.setLastPulledAt(entity, new Date().toISOString())
    }
    if (conflicts.length) await store.addConflicts(conflicts)
    const state: SyncState = { status: conflicts.length ? 'conflict' : 'idle', lastSyncAt: new Date().toISOString(), pending: 0, conflicts, message: conflicts.length ? `${conflicts.length} conflito(s) aguardando decisão.` : null }
    onState(state); return state
  } catch (e: any) {
    const offline = typeof navigator !== 'undefined' && !navigator.onLine
    const state: SyncState = { status: offline ? 'offline' : 'error', lastSyncAt: null, pending: (await store.getQueue()).length, conflicts, message: e?.message || 'Falha na sincronização.' }
    onState(state); return state
  }
}
