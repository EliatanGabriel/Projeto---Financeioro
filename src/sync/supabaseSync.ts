import { supabase } from '../supabase/client'
import type { SyncEntity, SyncRow } from './engine'
import { fromRemoteRow, HAS_UPDATED_AT, toRemoteRow, NATURAL } from './mapping'

/** Adaptador Supabase (RLS já isola por auth.uid(); user_id é forçado do servidor, nunca confiado do cliente). */
export function supabaseSyncClient(userId: string) {
  if (!supabase) throw new Error('Supabase não configurado')
  const sb = supabase as NonNullable<typeof supabase>
  const pkColumns: Partial<Record<SyncEntity, string[]>> = {
    budgets: ['user_id', 'category'],
    categories: ['user_id', 'name', 'type'],
    bill_payments: ['user_id', 'bill_id', 'month'],
    recurrence_launches: ['user_id', 'recurrence_id', 'month'],
    goal_auto_launches: ['user_id', 'goal_id', 'month'],
    credit_card_payments: ['user_id', 'card_id', 'month'],
  }

  async function deleteByCompositePk(entity: SyncEntity, rowId: string): Promise<void> {
    const cols = pkColumns[entity]
    if (!cols) throw new Error(`Colunas PK não definidas para entidade ${entity}`)
    const parts = String(rowId).split(':')
    let query = sb.from(entity).update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    if (entity === 'budgets') {
      query = query.eq('user_id', userId).eq('category', parts[0] || '')
    } else if (entity === 'categories') {
      const typePart = parts[0] || ''
      const namePart = parts.slice(1).join(':') || ''
      query = query.eq('user_id', userId).eq('type', typePart).eq('name', namePart)
    } else if (entity === 'bill_payments') {
      const bid = parts[0] || ''
      const monthPart = parts[1] || ''
      query = query.eq('user_id', userId).eq('bill_id', bid).eq('month', monthPart)
    } else if (entity === 'recurrence_launches') {
      const rid = parts[0] || ''
      const monthPart = parts[1] || ''
      query = query.eq('user_id', userId).eq('recurrence_id', rid).eq('month', monthPart)
    } else if (entity === 'goal_auto_launches') {
      const gid = parts[0] || ''
      const monthPart = parts[1] || ''
      query = query.eq('user_id', userId).eq('goal_id', gid).eq('month', monthPart)
    } else if (entity === 'credit_card_payments') {
      const cid = parts[0] || ''
      const monthPart = parts[1] || ''
      query = query.eq('user_id', userId).eq('card_id', cid).eq('month', monthPart)
    }
    const { error } = await query.select().single()
    if (error) throw error
  }

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
      if (NATURAL.has(entity)) {
        await deleteByCompositePk(entity, id)
      } else {
        const { error } = await sb.from(entity).update({ deleted_at: new Date().toISOString(), version: (await thisRowVersion(entity, id)) + 1, updated_at: new Date().toISOString() }).eq('id', id)
        if (error) throw error
      }
    },
  }
  async function thisRowVersion(entity: string, id: string): Promise<number> {
    const { data } = await sb.from(entity).select('version').eq('id', id).single()
    return Number((data as any)?.version || 0)
  }
}
