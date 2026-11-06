import { supabase } from '../supabase/client'
import type { SyncEntity, SyncRow } from './engine'

/** Adaptador Supabase (RLS já isola por auth.uid(); user_id é forçado do servidor, nunca confiado do cliente). */
export function supabaseSyncClient(userId: string) {
  if (!supabase) throw new Error('Supabase não configurado')
  const sb = supabase as NonNullable<typeof supabase>
  return {
    async fetchAll(entity: SyncEntity, since?: string): Promise<SyncRow[]> {
      let q = sb.from(entity).select('*').eq('user_id', userId).order('updated_at', { ascending: true })
      if (since) q = q.gt('updated_at', since as any)
      const { data, error } = await q
      if (error) throw error
      return (data || []).map(mapRow)
    },
    async upsert(entity: SyncEntity, row: SyncRow): Promise<SyncRow> {
      const { data, error } = await sb.from(entity).upsert({ ...row, user_id: userId }, { onConflict: entity === 'budgets' || entity === 'categories' || entity === 'bill_payments' || entity === 'recurrence_launches' || entity === 'goal_auto_launches' ? undefined : 'id' }).select().single()
      if (error) throw error
      return mapRow(data)
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
function mapRow(r: any): SyncRow {
  return { ...r, id: String(r.id || r.category || ''), userId: r.user_id, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, version: r.version }
}
