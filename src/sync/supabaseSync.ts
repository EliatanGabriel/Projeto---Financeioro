import { supabase } from '../supabase/client'
import type { SyncEntity, SyncRow } from './engine'
import { fromRemoteRow, HAS_UPDATED_AT, toRemoteRow } from './mapping'

/** Adaptador Supabase (RLS já isola por auth.uid(); user_id é forçado do servidor, nunca confiado do cliente). */
export function supabaseSyncClient(userId: string) {
  if (!supabase) throw new Error('Supabase não configurado')
  const sb = supabase as NonNullable<typeof supabase>
  return {
    async fetchAll(entity: SyncEntity, since?: string): Promise<SyncRow[]> {
      let q: any = sb.from(entity).select('*').eq('user_id', userId)
      if (HAS_UPDATED_AT.has(entity)) {
        q = q.order('updated_at', { ascending: true })
        if (since) q = q.gt('updated_at', since as any)
      }
      const { data, error } = await q
      if (error) throw error
      return (data || []).map((r: any) => fromRemoteRow(entity, r))
    },
    async upsert(entity: SyncEntity, row: SyncRow): Promise<SyncRow> {
      const onConflict = ['budgets', 'categories', 'bill_payments', 'recurrence_launches', 'goal_auto_launches', 'credit_card_payments'].includes(entity) ? undefined : 'id'
      const { data, error } = await sb.from(entity).upsert(toRemoteRow(entity, row), { onConflict }).select().single()
      if (error) throw error
      return fromRemoteRow(entity, data)
    },
    async softDelete(entity: SyncEntity, id: string): Promise<void> {
      const { error } = await sb.from(entity).update({ deleted_at: new Date().toISOString(), version: (await thisRowVersion(entity, id)) + 1, updated_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
    },
  }
  async function thisRowVersion(entity: string, id: string): Promise<number> {
    const { data } = await sb.from(entity).select('version').eq('id', id).single()
    return Number((data as any)?.version || 0)
  }
}
