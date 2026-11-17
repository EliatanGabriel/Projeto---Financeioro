// NoAzul — exclusão de conta (Edge Function, server-side).
// A service_role NUNCA sai do servidor: esta função valida o JWT do usuário e
// remove a identidade no Auth — as FKs ON DELETE CASCADE do schema apagam os dados.
// Deploy: supabase functions deploy delete-account (secrets configurados no painel Supabase).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }

function tokenIssuedAt(header: string | null): number {
  const token = (header || '').replace(/^Bearer\s+/i, '').trim()
  const part = token.split('.')[1]
  if (!part) return 0
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
    return Number(JSON.parse(atob(padded)).iat) || 0
  } catch {
    return 0
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { ...cors, 'content-type': 'application/json' } })
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...cors, 'content-type': 'application/json' } })
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
  const { data: { user }, error: uErr } = await userClient.auth.getUser()
  if (uErr || !user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...cors, 'content-type': 'application/json' } })
  // Revalidação exigida: o JWT precisa ser recente (última hora) para excluir a conta
  const iat = tokenIssuedAt(authHeader) * 1000
  if (!iat || Date.now() - iat > 60 * 60 * 1000) return new Response(JSON.stringify({ error: 'reauth_required', message: 'Entre novamente para excluir a conta.' }), { status: 403, headers: { ...cors, 'content-type': 'application/json' } })
  const admin = createClient(supabaseUrl, serviceKey)
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id)
  if (delErr) return new Response(JSON.stringify({ error: 'delete_failed' }), { status: 500, headers: { ...cors, 'content-type': 'application/json' } })
  return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'content-type': 'application/json' } })
})
