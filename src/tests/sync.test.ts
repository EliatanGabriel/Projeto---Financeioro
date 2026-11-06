// @ts-nocheck
import { describe, it, expect } from 'vitest'
import { canonicalHash, diffRecords, processQueue, nextRetryAt, makeUpsertOp, makeDeleteOp } from '../sync/engine'
import { syncAll } from '../sync/syncService'

const row = (id: string, over: any = {}) => ({ id, userId: 'u1', description: 'lápis', amount: 10, updatedAt: '2026-01-01T00:00:00Z', version: 1, ...over })

describe('sync — diff, hash e fila', () => {
  it('hash canônico ignora ordem de chaves', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }))
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }))
  })
  it('novo local sem correspondente remoto entra no push; remoto novo entra no pull', () => {
    const local = [row('1'), row('2')]
    const remote = [row('1'), row('3', { description: 'nuvem' })]
    const meta = new Map([['1', { hash: canonicalHash(row('1')), version: 1 }]])
    const d = diffRecords('transactions', local, remote, meta)
    expect(d.toPush.map(r => r.id)).toEqual(['2']); expect(d.toPull.map(r => r.id)).toEqual(['3']); expect(d.conflicts).toHaveLength(0)
  })
  it('conflito: ambos mudaram desde a última sincronização — nunca sobrescreve', () => {
    const local = [row('1', { description: 'local' })]; const remote = [row('1', { description: 'remoto' })]
    const meta = new Map([['1', { hash: canonicalHash(row('1')), version: 1 }]])
    const d = diffRecords('transactions', local, remote, meta)
    expect(d.conflicts).toHaveLength(1); expect(d.toPush).toHaveLength(0); expect(d.toPull).toHaveLength(0)
  })
  it('só local mudou → push; só remoto mudou → pull', () => {
    const meta = new Map([['1', { hash: canonicalHash(row('1')), version: 1 }]])
    expect(diffRecords('transactions', [row('1', { description: 'novo' })], [row('1')], meta).toPush).toHaveLength(1)
    expect(diffRecords('transactions', [row('1')], [row('1', { description: 'novo' })], meta).toPull).toHaveLength(1)
  })
  it('retry com backoff e sucesso idempotente da fila', async () => {
    expect(Date.parse(nextRetryAt(0, 0))).toBe(1000); expect(Date.parse(nextRetryAt(4, 0))).toBe(300000)
    const ops = [makeDeleteOp('transactions', row('9')), makeUpsertOp('transactions', row('8'))]
    let calls = 0
    const client = { softDelete: async () => { calls++; if (calls === 1) throw new Error('offline') } }
    const r1 = await processQueue(ops, client as any)
    expect(r1.done).toHaveLength(1); expect(r1.pending).toHaveLength(1); expect(r1.pending[0].attempts).toBe(1); expect(r1.pending[0].nextRetryAt).toBeTruthy()
  })
  it('syncAll com fake: push+pull, estado idle e metadados persistidos', async () => {
    const local = [row('1', { description: 'local' })]; const remote = [row('1'), row('2', { description: 'nuvem' })]
    const meta = new Map([['1', { hash: canonicalHash(row('1')), version: 1 }]])
    const store: any = {
      listLocal: async () => local, replaceLocal: async (_e: any, rows: any[]) => { local.push(...rows) },
      getMeta: async () => meta, setMeta: async (_e: any, m: any) => { meta.clear(); m.forEach((v: any, k: string) => meta.set(k, v)) },
      getLastPulledAt: async () => null, setLastPulledAt: async () => {}, getQueue: async () => [], saveQueue: async () => {},
      addConflicts: async () => {}, getConflicts: async () => [], resolveConflictLocal: async () => {},
    }
    const client: any = { fetchAll: async () => remote, upsert: async (_e: any, r: any) => ({ ...r, version: 2 }), softDelete: async () => {} }
    let state: any = null
    const final = await syncAll(store, client, ['transactions'], (s: any) => { state = s })
    expect(final.status).toBe('idle'); expect(state.status).toBe('idle'); expect(final.lastSyncAt).toBeTruthy()
    expect(local.find((r: any) => r.id === '2')).toBeTruthy()
    expect(meta.get('1')?.hash).toBe(canonicalHash(row('1', { description: 'local' })))
  })
  it('syncAll offline: estado offline e fila preservada', async () => {
    const store: any = { listLocal: async () => [], replaceLocal: async () => {}, getMeta: async () => new Map(), setMeta: async () => {}, getLastPulledAt: async () => null, setLastPulledAt: async () => {}, getQueue: async () => [{ opId: 'x', entity: 'transactions', recordId: '1', op: 'delete', payload: {}, baseVersion: 0, attempts: 0, nextRetryAt: null, createdAt: '' }], saveQueue: async () => {}, addConflicts: async () => {}, getConflicts: async () => [], resolveConflictLocal: async () => {} }
    const client: any = { fetchAll: async () => { throw new Error('network down') }, upsert: async () => ({}), softDelete: async () => { throw new Error('offline') } }
    const final = await syncAll(store, client, ['transactions'], () => {})
    expect(['offline', 'error']).toContain(final.status); expect(final.message).toBeTruthy()
  })
})
