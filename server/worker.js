// NoAzul — servidor de licenças (Cloudflare Worker, sem dependências)
// Recebe webhooks da Cakto, guarda a assinatura por e-mail no KV e emite a chave Pro sob demanda.
// Segredos (variáveis de ambiente / secrets do Worker):
//   CAKTO_WEBHOOK_SECRET  - segredo do webhook criado na Cakto
//   PRIVATE_KEY_PEM       - conteúdo de tools/private.key.pem (NUNCA no app, NUNCA no git)
// Binding: LICENSES (KV namespace) para guardar sub:<email>
// Rotas:
//   POST /webhook/cakto
//   GET  /license?email=...&deviceId=...
//   GET  /health

/**
 * Durable Object (uma instância por e-mail): serializa operações de leitura/decisão/escrita
 * sobre a assinatura (pin, watermarks, dedup, rate limit, reset) — atomicidade por instância.
 * A assinatura PRP1 continua no Worker (chave privada nunca sai de lá).
 * Classe sem extends de base para manter testabilidade em Node/Vitest; em produção o runtime
 * instancia com (ctx, env) e storage SQLite do DO.
 */
export class LicenseStore {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env || {}
    this.storage = ctx.storage
    this._queue = Promise.resolve()
  }
  _run(fn) {
    const p = this._queue.then(() => fn(), () => fn())
    this._queue = p.then(() => {}, () => {})
    return p
  }
  /** Adapter KV legado (migração preguiçosa e idempotente por chave; sem dual-write). */
  _adapter() {
    const storage = this.storage; const legacy = this.env?.LICENSES
    return {
      get: async (k) => {
        let v = await storage.get(k)
        if (v == null && legacy && typeof legacy.get === 'function') {
          const old = await legacy.get(k)
          if (old != null) { try { await storage.put(k, JSON.parse(old)) } catch { await storage.put(k, old) } v = old }
        }
        return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v))
      },
      put: async (k, v) => { let parsed = v; try { parsed = JSON.parse(v) } catch {} await storage.put(k, parsed) },
    }
  }
  async _getSub(email) {
    const raw = await this._adapter().get(`sub:${email}`)
    return raw ? JSON.parse(raw) : null
  }
  /** Transição reserved->started no registry (chamada pelo DO responsável ANTES de escrever). */
  async _startOp(opId) {
    if (!opId) return { ok: false, status: 400, body: { ok: false, error: 'op_required' } }
    const stub = this.env?.LICENSE_DO?.get(this.env.LICENSE_DO.idFromName('__registry__'))
    if (!stub) return { ok: false, status: 500, body: { ok: false, error: 'registry_failed' } }
    const r = await stub.fetch('https://license-store/internal/freeze-start-op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId }) })
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }
  }
  async _releaseOp(opId) {
    if (!opId) return
    try {
      const stub = this.env?.LICENSE_DO?.get(this.env.LICENSE_DO.idFromName('__registry__'))
      if (stub) await stub.fetch('https://license-store/internal/freeze-complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId }) })
    } catch { console.error('[freeze] do release failed') }
  }
  async fetch(input, init) {
    const request = typeof input === 'string' ? new Request(input, init) : input
    return this._run(async () => {
      // Liberação pelo DO somente para rotas mutáveis de e-mail e apenas após RESPOSTA definitiva.
      // Rotas do próprio registry (freeze/register/snapshot/admin) NÃO entram aqui — liberar nelas
      // reentraria a fila da mesma instância (deadlock) e/ou liberaria lease alheia.
      const pathname = new URL(request.url).pathname
      const MUTATING = new Set(['/internal/process', '/internal/license', '/internal/reset-device'])
      if (!MUTATING.has(pathname)) return this._handle(request)
      let opId = ''
      try {
        const clone = request.clone()
        if (clone.method === 'GET') opId = new URL(clone.url).searchParams.get('opId') || ''
        else { const b = await clone.json().catch(() => null); opId = String(b?.opId || '') }
      } catch {}
      const res = await this._handle(request)
      if (opId) await this._releaseOp(opId)
      return res
    })
  }
_freezeRecord() { return this.storage.get('freeze') }
async   _freezeState() {
  let rec = await this._freezeRecord() || { state: 'running', ops: {}, updatedAt: null }
  rec.ops = rec.ops || {}
  const now = Date.now()
  let changed = false
  for (const [op, v] of Object.entries(rec.ops)) {
    const phase = typeof v === 'number' ? 'started' : v?.phase // legado numérico = operação iniciada
    const at = typeof v === 'number' ? v : Number(v?.at || 0)
    // Nunca remover leases started por idade; reserved órfã só é reclamada após a rejeição definitiva do início.
    if (phase !== 'started' && now - at > 5 * 60 * 1000) { delete rec.ops[op]; changed = true }
  }
  if (changed) await this.storage.put('freeze', rec)
  return rec
}
async _handle(request) {
  const url = new URL(request.url)
  if (url.pathname === '/internal/freeze-acquire' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const opId = String(body?.opId || '')
    if (!opId) return json({ ok: false, error: 'op_required' }, 400)
    const rec = await this._freezeState()
    if (rec.state !== 'running') return json({ ok: false, error: 'frozen', state: rec.state }, 503)
    rec.ops[opId] = { phase: 'reserved', at: Date.now() }
    await this.storage.put('freeze', rec)
    return json({ ok: true, opId })
  }
  if (url.pathname === '/internal/freeze-start-op' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const opId = String(body?.opId || '')
    if (!opId) return json({ ok: false, error: 'op_required' }, 400)
    const rec = await this._freezeState()
    const opRec = rec.ops[opId]
    if (opRec == null) return json({ ok: false, error: 'lease_gone' }, 409)
    const phase = typeof opRec === 'number' ? 'started' : opRec.phase
    if (phase === 'started') return json({ ok: true, opId, duplicate: true })
    if (rec.state !== 'running') {
      // Tardia demais: a reserva é reclamada DEFINITIVAMENTE aqui (o DO não escreverá nada).
      delete rec.ops[opId]
      await this.storage.put('freeze', rec)
      return json({ ok: false, error: 'lease_rejected', state: rec.state }, 409)
    }
    rec.ops[opId] = { phase: 'started', at: Date.now() }
    await this.storage.put('freeze', rec)
    return json({ ok: true, opId })
  }
  if (url.pathname === '/internal/freeze-release-reserved' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const opId = String(body?.opId || '')
    const rec = await this._freezeState()
    const entry = opId ? rec.ops[opId] : null
    if (entry == null) return json({ ok: true, duplicate: true })
    const phase = typeof entry === 'number' ? 'started' : entry.phase
    if (phase === 'started') return json({ ok: false, error: 'lease_started' }, 409)
    delete rec.ops[opId]
    await this.storage.put('freeze', rec)
    return json({ ok: true })
  }
  if (url.pathname === '/internal/freeze-complete' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const opId = String(body?.opId || '')
    const rec = await this._freezeState()
    const entry = opId ? rec.ops[opId] : null
    if (entry == null) return json({ ok: true, duplicate: true })
    const phase = typeof entry === 'number' ? 'started' : entry.phase
    if (phase !== 'started') return json({ ok: false, error: 'lease_not_started' }, 409)
    delete rec.ops[opId]
    await this.storage.put('freeze', rec)
    return json({ ok: true })
  }
  if (url.pathname === '/internal/freeze-start' && request.method === 'POST') {
    const rec = await this._freezeState()
    if (rec.state === 'running') { rec.state = 'freezing'; rec.updatedAt = new Date().toISOString(); await this.storage.put('freeze', rec) }
    return json({ ok: true, state: rec.state, activeOperations: Object.keys(rec.ops || {}).length })
  }
  if (url.pathname === '/internal/freeze-confirm' && request.method === 'POST') {
    const rec = await this._freezeState()
    const active = Object.keys(rec.ops || {}).length
    if (rec.state === 'frozen') return json({ ok: true, state: 'frozen', activeOperations: 0 })
    if (rec.state === 'freezing' && active === 0) { rec.state = 'frozen'; rec.frozenAt = new Date().toISOString(); await this.storage.put('freeze', rec); return json({ ok: true, state: 'frozen', activeOperations: 0 }) }
    return json({ ok: false, error: 'freeze_draining', state: rec.state, activeOperations: active }, 409)
  }
  if (url.pathname === '/internal/freeze-state' && request.method === 'GET') {
    const rec = await this._freezeState()
    if (rec.state === 'unfreezing' && Object.keys(rec.ops || {}).length === 0) { rec.state = 'running'; rec.updatedAt = new Date().toISOString(); await this.storage.put('freeze', rec) }
    return json({ ok: true, state: rec.state, activeOperations: Object.keys(rec.ops || {}).length, frozenAt: rec.frozenAt || null })
  }
  if (url.pathname === '/internal/freeze-unlock' && request.method === 'POST') {
    const rec = await this._freezeState()
    const active = Object.keys(rec.ops || {}).length
    if (active !== 0) return json({ ok: false, error: 'operations_active', state: rec.state, activeOperations: active }, 409)
    if (rec.state === 'frozen') { rec.state = 'unfreezing'; rec.updatedAt = new Date().toISOString(); await this.storage.put('freeze', rec); return json({ ok: true, state: 'unfreezing', activeOperations: 0 }) }
    if (rec.state === 'unfreezing') { rec.state = 'running'; rec.updatedAt = new Date().toISOString(); await this.storage.put('freeze', rec); return json({ ok: true, state: 'running', activeOperations: 0 }) }
    return json({ ok: false, error: 'not_frozen', state: rec.state }, 409)
  }
  if (url.pathname === '/internal/register' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const email = normalizeEmail(body?.email)
    if (!email) return json({ ok: false, error: 'email_required' }, 400)
    const key = `index:${email}`
    const existing = await this.storage.get(key)
    if (!existing) await this.storage.put(key, { email, source: 'live', registeredAt: new Date().toISOString() })
    return json({ ok: true })
  }
  if (url.pathname === '/internal/bootstrap' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const entries = Array.isArray(body?.entries) ? body.entries : []
    let registered = 0
    for (const e of entries) {
      const email = normalizeEmail(e?.email); if (!email) continue
      const key = `index:${email}`
      if (await this.storage.get(key)) continue
      await this.storage.put(key, { email, source: String(e?.source || 'bootstrap'), registeredAt: new Date().toISOString() })
      registered++
    }
    return json({ ok: true, registered })
  }
  if (url.pathname === '/internal/snapshot-begin' && request.method === 'POST') {
    const emails = []; let cursor = undefined; const seenCursors = new Set()
    for (;;) {
      const listed = await this.storage.list({ prefix: 'index:', cursor, limit: 1000 })
      const entries = listed instanceof Map ? [...listed.entries()] : [...(listed.entries ? listed.entries() : [])]
      for (const [k] of entries) emails.push(String(k).slice('index:'.length))
      if (listed.list_complete !== false && !listed.cursor) break
      if (!listed.cursor || seenCursors.has(listed.cursor)) return json({ ok: false, error: 'export_incomplete' }, 500)
      seenCursors.add(listed.cursor); cursor = listed.cursor
    }
    emails.sort()
    const snapshotId = crypto.randomUUID()
    await this.storage.put(`snap:${snapshotId}`, { snapshotId, emails, createdAt: new Date().toISOString(), exportedOrders: 0, exportedCount: 0, batches: {}, concluded: emails.length === 0 })
    return json({ ok: true, snapshotId, totalRecords: emails.length })
  }
    if (url.pathname === '/internal/snapshot-session' && request.method === 'POST') {
      const body = await request.json().catch(() => null)
      const session = body?.snapshotId ? await this.storage.get(`snap:${body.snapshotId}`) : null
      if (!session) return json({ ok: false, error: 'snapshot_not_found' }, 404)
      return json({ ok: true, snapshotId: session.snapshotId, totalRecords: (session.emails || []).length, exportedOrders: session.exportedOrders || 0, exportedCount: session.exportedCount || 0, createdAt: session.createdAt, concluded: session.concluded === true, emails: session.emails || [], batches: session.batches || {} })
    }
    if (url.pathname === '/internal/snapshot-batch' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const session = body?.snapshotId ? await this.storage.get(`snap:${body.snapshotId}`) : null
    if (!session) return json({ ok: false, error: 'snapshot_not_found' }, 404)
    const limit = Math.min(100, Math.max(1, Number(body?.limit || 50)))
    const rawCursor = body?.cursor
    const start = rawCursor == null || rawCursor === '' ? 0 : Number(rawCursor)
    if (!Number.isInteger(start) || start < 0 || start > (session.emails || []).length) return json({ ok: false, error: 'invalid_cursor' }, 400)
    const emails = (session.emails || []).slice(start, start + limit)
    const next = start + emails.length
    return json({ ok: true, emails, cursor: next < (session.emails || []).length ? String(next) : null, complete: session.concluded === true, totalRecords: (session.emails || []).length, exportedAt: session.createdAt })
  }
  if (url.pathname === '/internal/snapshot-update' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const session = body?.snapshotId ? await this.storage.get(`snap:${body.snapshotId}`) : null
    if (!session) return json({ ok: false, error: 'snapshot_not_found' }, 404)
    const batchId = String(body?.batchId || '')
    if (!batchId || !batchId.startsWith(`${body.snapshotId}:`)) return json({ ok: false, error: 'invalid_batch' }, 400)
    session.batches = session.batches || {}
    const orders = Number(body?.orders) || 0; const records = Number(body?.records) || 0
    if (!Number.isInteger(orders) || orders < 0 || !Number.isInteger(records) || records < 0) return json({ ok: false, error: 'invalid_batch' }, 400)
    const start = body?.start != null ? Number(body.start) : NaN
    const end = body?.end != null ? Number(body.end) : NaN
    const total = (session.emails || []).length
    const prev = session.batches[batchId]
    if (!records) return json({ ok: true, totalOrders: session.exportedOrders || 0, exportedCount: session.exportedCount || 0, concluded: session.concluded === true, duplicate: true })
    if (session.concluded === true) {
      if (prev && prev.orders === orders && prev.records === records && prev.start === start && prev.end === end) {
        return json({ ok: true, totalOrders: session.exportedOrders, exportedCount: session.exportedCount, concluded: true, duplicate: true })
      }
      return json({ ok: false, error: 'snapshot_concluded' }, 409)
    }
    if (prev) {
      if (prev.orders !== orders || prev.records !== records || prev.start !== start || prev.end !== end) return json({ ok: false, error: 'batch_content_mismatch' }, 409)
      return json({ ok: true, totalOrders: session.exportedOrders, exportedCount: session.exportedCount, concluded: session.concluded === true, duplicate: true })
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > total) return json({ ok: false, error: 'invalid_interval' }, 400)
    for (const b of Object.values(session.batches)) {
      if (b && Number.isInteger(b.start) && Number.isInteger(b.end) && start < b.end && b.start < end) return json({ ok: false, error: 'batch_overlap' }, 409)
    }
    session.batches[batchId] = { orders, records, start, end }
    session.exportedOrders = Object.values(session.batches).reduce((acc, b) => acc + (b.orders || 0), 0)
    session.exportedCount = Object.values(session.batches).reduce((acc, b) => acc + (b.records || 0), 0)
    session.concluded = coverageComplete(session.batches, total)
    await this.storage.put(`snap:${body.snapshotId}`, session)
    return json({ ok: true, totalOrders: session.exportedOrders, exportedCount: session.exportedCount, concluded: session.concluded })
  }
  if (url.pathname === '/internal/list-index' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const limit = Math.min(100, Math.max(1, Number(body?.limit || 50)))
    const listed = await this.storage.list({ prefix: 'index:', cursor: body?.cursor || undefined, limit })
    const entries = listed instanceof Map ? [...listed.entries()] : [...(listed.entries ? listed.entries() : [])]
    const emails = entries.map(([k]) => String(k).slice('index:'.length))
    const cursor = listed.cursor || null
    const complete = listed.list_complete !== false && !cursor
    return json({ ok: true, emails, cursor, complete, total: entries.length })
  }
  if (url.pathname === '/internal/summary' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const email = normalizeEmail(body?.email)
    if (!email) return json({ ok: false, error: 'email_required' }, 400)
    return json({ ok: true, email, sub: await this._getSub(email) })
  }
  if (url.pathname === '/internal/portal-status' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const email = normalizeEmail(body?.email)
    if (!email) return json({ ok: false, error: 'email_required', message: 'Informe seu e-mail.' }, 400)
    const rlKey = `portrl:${email}:${new Date().toISOString().slice(0, 16)}`
    const rl = Number(await this.storage.get(rlKey) || 0)
    if (rl >= 30) return json({ ok: false, error: 'rate_limited', message: 'Muitas consultas. Tente novamente em instantes.' }, 429)
    await this.storage.put(rlKey, rl + 1)
    const sub = await this._getSub(email)
    if (!sub) return json({ ok: true, found: false })
    const expiresAt = sub.expiresAt || null
    const expired = !expiresAt || new Date(expiresAt) <= new Date()
    const paused = sub.revoked === true || sub.status === 'paused'
    const status = paused ? 'paused' : expired ? 'expired' : (sub.status === 'active' || sub.status === 'canceled') ? 'active' : 'inactive'
    return json({ ok: true, found: true, status, expiresAt, plan: 'pro-monthly', deviceLinked: Boolean(sub.deviceId) })
  }
  if (url.pathname === '/internal/export' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const email = normalizeEmail(body?.email)
    if (!email) return json({ ok: false, error: 'email_required' }, 400)
    const sub = await this._getSub(email)
    const orders = {}; let cursor = undefined; const seenCursors = new Set()
    for (;;) {
      const listed = await this.storage.list({ prefix: 'order:', cursor, limit: 100 })
      const orderEntries = listed instanceof Map ? [...listed.entries()] : [...(listed.entries ? listed.entries() : [])]
      for (const [k, v] of orderEntries) orders[String(k).slice('order:'.length)] = v
      if (listed.list_complete !== false && !listed.cursor) break
      if (!listed.cursor || seenCursors.has(listed.cursor)) return json({ ok: false, error: 'export_incomplete' }, 500)
      seenCursors.add(listed.cursor); cursor = listed.cursor
    }
    return json({ ok: true, email, sub, orders })
  }
    if (url.pathname === '/internal/process' && request.method === 'POST') {
      const payload = await request.json().catch(() => null)
      if (!payload) return json({ ok: false, error: 'invalid_json' }, 400)
      const opId = String(payload.opId || '')
      const started = await this._startOp(opId)
      if (!started.ok) return json(started.body, started.status)
      const results = await processEvent(payload, this._adapter())
      return json({ ok: true, results })
    }
    if (url.pathname === '/internal/license' && request.method === 'GET') {
      const email = normalizeEmail(url.searchParams.get('email'))
      const deviceId = String(url.searchParams.get('deviceId') || '').trim()
      if (!email) return json({ ok: false, error: 'email_required', message: 'Informe seu e-mail.' }, 400)
      if (!deviceId) return json({ ok: false, error: 'device_required', message: 'Identificação do aparelho ausente.' }, 400)
      const opId = String(url.searchParams.get('opId') || '')
      const started = await this._startOp(opId)
      if (!started.ok) return json(started.body, started.status)
      const rlKey = `rl:${email}:${new Date().toISOString().slice(0, 16)}`
      const rl = Number(await this.storage.get(rlKey) || 0)
      if (rl >= 20) return json({ ok: false, error: 'rate_limited', message: 'Muitas tentativas. Tente novamente em instantes.' }, 429)
      await this.storage.put(rlKey, rl + 1)
      const sub = await this._getSub(email)
      if (!sub) return json({ ok: false, error: 'not_active', message: 'Não encontramos assinatura ativa para este e-mail.' }, 404)
      const expired = !sub.expiresAt || new Date(sub.expiresAt) <= new Date()
      const revoked = sub.revoked === true || sub.status === 'paused'
      if (revoked || expired) return json({ ok: false, error: 'not_active', message: 'Não encontramos assinatura ativa para este e-mail.' }, 403)
      if (sub.status !== 'active' && sub.status !== 'canceled') return json({ ok: false, error: 'not_active', message: 'Não encontramos assinatura ativa para este e-mail.' }, 403)
      if (sub.deviceId && sub.deviceId !== deviceId) {
        return json({ ok: false, error: 'device_mismatch', message: 'Esta assinatura já está ativa em outro aparelho. Para trocar, fale com o suporte.' }, 409)
      }
      if (!sub.deviceId) { sub.deviceId = deviceId; sub.updatedAt = new Date(Math.max(Date.now(), Date.parse(sub.updatedAt) || 0)).toISOString(); await this._adapter().put(`sub:${email}`, JSON.stringify(sub)) }
      return json({ ok: true, expiresAt: sub.expiresAt, holder: sub.name || email, plan: 'pro-monthly' })
    }
    if (url.pathname === '/internal/admin-gate' && request.method === 'POST') {
      const body = await request.json().catch(() => null)
      const ipHash = String(body?.ipHash || 'unknown').slice(0, 128)
      const authenticated = body?.authenticated === true
      const now = Date.now()
      // Limite global (100 tentativas/min, janela deslizante com recuperação automática — nunca permanente)
      const gKey = 'admrl:global'
      let grec = await this.storage.get(gKey) || { count: 0, windowStart: now }
      if (now - grec.windowStart >= ADMIN_GLOBAL_WINDOW_MS) grec = { count: 0, windowStart: now }
      if (grec.count >= ADMIN_GLOBAL_LIMIT) {
        return json({ ok: false, error: 'rate_limited', retryAfter: Math.max(1, Math.ceil((grec.windowStart + ADMIN_GLOBAL_WINDOW_MS - now) / 1000)) }, 429)
      }
      grec.count = (grec.count || 0) + 1
      await this.storage.put(gKey, grec)
      // Per-IP: bloqueio verificado ANTES da autenticação — IP bloqueado não reseta nem com token válido
      const key = `admrl:${ipHash}`
      let rec = await this.storage.get(key) || { count: 0, windowStart: now, lockedUntil: 0 }
      if (rec.lockedUntil > now) return json({ ok: false, error: 'rate_limited', retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) }, 429)
      if (now - rec.windowStart >= ADMIN_WINDOW_MS) rec = { count: 0, windowStart: now, lockedUntil: 0 }
      if (authenticated) { await this.storage.delete(key); return json({ ok: true }) }
      rec.count = (rec.count || 0) + 1
      if (rec.count >= ADMIN_MAX_FAILURES) rec.lockedUntil = now + ADMIN_LOCK_MS
      await this.storage.put(key, rec)
      return json({ ok: false, error: 'unauthorized' }, 401)
    }
    if (url.pathname === '/internal/reset-device' && request.method === 'POST') {
      const body = await request.json().catch(() => null)
      const email = normalizeEmail(body?.email)
      if (!email) return json({ ok: false, error: 'email_required' }, 400)
      const opId = String(body?.opId || '')
      const started = await this._startOp(opId)
      if (!started.ok) return json(started.body, started.status)
      const sub = await this._getSub(email)
      if (!sub) return json({ ok: false, error: 'subscription_not_found' }, 404)
      sub.deviceId = null
      sub.updatedAt = new Date(Math.max(Date.now(), Date.parse(sub.updatedAt) || 0)).toISOString()
      await this._adapter().put(`sub:${email}`, JSON.stringify(sub))
      return json({ ok: true })
    }
    return json({ ok: false, error: 'not_found' }, 404)
  }
}

const ACTIVATE_EVENTS = new Set(['purchase_approved', 'subscription_created', 'subscription_renewed', 'subscription_late_recovered', 'subscription_resumed'])
const DEACTIVATE_EVENTS = new Set(['subscription_canceled', 'subscription_paused', 'refund', 'chargeback', 'subscription_renewal_refused'])
const tolerance = 5 * 60

export const normalizeEmail = (e) => String(e || '').trim().toLowerCase()
export function addMonths(date, months = 1) { const d = new Date(date); d.setMonth(d.getMonth() + months); return d }

export const normalizeSecret = (s) => String(s || '').trim()
export const ADMIN_WINDOW_MS = 15 * 60 * 1000
export const ADMIN_MAX_FAILURES = 5
export const ADMIN_LOCK_MS = 15 * 60 * 1000
export const ADMIN_GLOBAL_LIMIT = 100
export const ADMIN_GLOBAL_WINDOW_MS = 60 * 1000
/** Comparação em tempo constante via digest SHA-256 (Web Crypto, sem APIs Node). */
export async function timingSafeEqualStr(a, b) {
  const da = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(a ?? '')))
  const db = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(b ?? '')))
  const va = new Uint8Array(da), vb = new Uint8Array(db)
  let diff = va.length ^ vb.length
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]
  return diff === 0
}
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s ?? '')))
  return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join('')
}
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`
}
export async function sha256HexObj(value) { return sha256Hex(canonicalStringify(value)) }
export function extractV1(signature) {
  const s = String(signature || '').trim()
  if (!s) return ''
  const parts = s.split(',').map(p => p.trim()).filter(Boolean)
  const v1 = parts.find(p => p.startsWith('v1=')) || parts[0]
  return v1.replace(/^v1=/, '').trim().toLowerCase()
}
/** Retorna {ok, reason} — reason nunca contém segredo/assinatura, só o motivo (para diagnóstico). */
export async function verifyCaktoSignature(rawBody, timestamp, signature, secret) {
  const cleanSecret = normalizeSecret(secret)
  if (!cleanSecret) return { ok: false, reason: 'server_secret_not_configured' }
  const ts = String(timestamp || '').trim()
  const sigHex = extractV1(signature)
  if (ts && sigHex) {
    const age = Math.abs(Date.now() / 1000 - Number(ts))
    if (!Number.isFinite(age) || age > tolerance) return { ok: false, reason: 'stale_timestamp' }
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(cleanSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const msg = new Uint8Array(ts.length + 1 + rawBody.length)
    msg.set(new TextEncoder().encode(`${ts}.`))
    msg.set(new Uint8Array(rawBody), ts.length + 1)
    const sig = await crypto.subtle.sign('HMAC', key, msg)
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
    return sigHex === hex ? { ok: true, reason: 'header_signature' } : { ok: false, reason: 'signature_mismatch' }
  }
  return { ok: false, reason: 'missing_signature_headers' }
}
export function verifyBodySecret(payload, secret) {
  const cleanSecret = normalizeSecret(secret)
  if (!cleanSecret) return { ok: false, reason: 'server_secret_not_configured' }
  const received = normalizeSecret(payload?.secret)
  if (!received) return { ok: false, reason: 'missing_body_secret' }
  return received === cleanSecret ? { ok: true, reason: 'body_secret' } : { ok: false, reason: 'body_secret_mismatch' }
}
/**
 * Autenticação do webhook (anti-replay):
 * - Se a entrega traz headers de assinatura (timestamp e/ou signature), eles são obrigatórios:
 *   timestamp expirado ou assinatura inválida REJEITA na hora, sem cair para o corpo.
 *   (O segredo trafega no corpo, então aceitar o corpo aqui permitiria replay de uma entrega
 *   capturada após a janela de 5 minutos.)
 * - O fallback pelo `payload.secret` (comparação exata com CAKTO_WEBHOOK_SECRET) só vale
 *   quando a entrega NÃO traz nenhum header de assinatura (ex.: teste legado sem headers).
 */
export async function authenticateWebhook(rawBody, timestamp, signature, payload, secret) {
  const hasTimestamp = Boolean(String(timestamp || '').trim())
  const hasSignature = Boolean(String(signature || '').trim())
  if (hasTimestamp || hasSignature) {
    if (!hasTimestamp || !hasSignature) return { ok: false, reason: 'missing_signature_headers' }
    return verifyCaktoSignature(rawBody, timestamp, signature, secret)
  }
  return verifyBodySecret(payload, secret)
}

function b64url(bytes) {
  let s = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function importPrivateKey(pem) {
  const b64 = String(pem).replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '')
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', bin, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

export async function signLicense(payload, privateKeyPem) {
  const key = await importPrivateKey(privateKeyPem)
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data)
  return `PRP1.${b64url(data)}.${b64url(sig)}`
}

/**
 * Número sequencial do ciclo (payload real da Cakto:
 * subscription: { id, current_period, recurrence_period, paid_payments_quantity, ... }
 * e, no pedido, subscription_period == recurrence_period — duração do plano, NÃO o ciclo).
 * Validação estrita: só inteiro >= 1 (number) ou string só de dígitos (após trim).
 * Booleanos, null, vazio, negativos, decimais, zero e não-numéricos retornam null.
 */
export function parseCycleNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 ? value : null
  if (typeof value === 'string') {
    const t = value.trim()
    if (!/^\d+$/.test(t)) return null
    const n = Number(t)
    return Number.isInteger(n) && n >= 1 ? n : null
  }
  return null
}
/** Prioridade: current_period; fallback: paid_payments_quantity (só se o primeiro for ausente/inválido). */
export function cycleNumber(data) {
  return parseCycleNumber(data?.subscription?.current_period) ?? parseCycleNumber(data?.subscription?.paid_payments_quantity)
}
export function subscriptionId(data) {
  const id = data?.subscription?.id
  return id != null && String(id).trim() !== '' ? String(id) : ''
}

/** Cobertura integral de [0,total) pelos intervalos registrados (sem lacunas/sobreposições). */
export function coverageComplete(batches, total) {
  if (!Number.isInteger(total) || total < 0) return false
  if (total === 0) return true
  const intervals = []
  for (const b of Object.values(batches || {})) {
    if (!Number.isInteger(b?.start) || !Number.isInteger(b?.end) || b.start < 0 || b.end <= b.start || b.end > total) return false
    intervals.push([b.start, b.end])
  }
  intervals.sort((a, b) => a[0] - b[0])
  let expect = 0
  for (const [s, e] of intervals) { if (s !== expect) return false; expect = e }
  return expect === total
}

export function extractOrders(payload) {
  const d = payload?.data
  if (!d) return []
  return Array.isArray(d) ? d : [d]
}

export async function processEvent(payload, kv) {
  const event = payload?.event || ''
  const results = []
  for (const data of extractOrders(payload)) {
    const email = normalizeEmail(data?.customer?.email || data?.customerEmail)
    if (!email) continue
    const orderId = data?.id || ''
    if (orderId) {
      const seen = await kv.get(`order:${orderId}`)
      if (seen) { results.push({ email, skipped: 'duplicate' }); continue }
    }
    const subKey = `sub:${email}`
    const existingRaw = await kv.get(subKey)
    const existing = existingRaw ? JSON.parse(existingRaw) : null
    const now = new Date()
    const isResume = event === 'subscription_resumed'
    // Watermark por assinatura: mapa subscription.id -> maior ciclo já estendido (migra lastCycle legado).
    const lastCycles = { ...(existing?.lastCycles || {}) }
    if (existing?.lastCycleSubId && existing?.lastCycleNum != null && lastCycles[existing.lastCycleSubId] == null) lastCycles[existing.lastCycleSubId] = existing.lastCycleNum
    const subId = subscriptionId(data)
    const cycleNum = cycleNumber(data)
    // Dedup monotônica (só com subscription.id + ciclo válido, e nunca para retomada):
    // mesmo ciclo ou ciclo atrasado (<= watermark) não estende; ciclo maior processa.
    // Sem subscription.id: apenas order:<id> (acima) — nenhuma comparação entre assinaturas.
    if (ACTIVATE_EVENTS.has(event) && !isResume && subId && cycleNum != null && cycleNum <= (lastCycles[subId] ?? 0)) {
      results.push({ email, skipped: 'duplicate_cycle' })
      if (orderId) await kv.put(`order:${orderId}`, '1')
      continue
    }
    if (isResume) {
      // Retomada não é nova cobrança/ciclo: restaura o acesso SEM estender e SEM avançar o watermark.
      if (!existing) { results.push({ email, skipped: 'resume_without_subscription' }) }
      else {
        await kv.put(subKey, JSON.stringify({ ...existing, email, status: 'active', revoked: false, updatedAt: now.toISOString(), lastOrderId: orderId }))
        results.push({ email, status: 'active', expiresAt: existing.expiresAt || null, resumed: true })
      }
    } else if (ACTIVATE_EVENTS.has(event)) {
      const base = existing?.expiresAt && new Date(existing.expiresAt) > now && existing.status === 'active' ? new Date(existing.expiresAt) : now
      const expiresAt = addMonths(base, 1).toISOString()
      if (subId && cycleNum != null) lastCycles[subId] = cycleNum
      await kv.put(subKey, JSON.stringify({ email, name: data?.customer?.name || existing?.name || '', status: 'active', revoked: false, deviceId: existing?.deviceId || null, plan: 'pro-monthly', expiresAt, updatedAt: now.toISOString(), lastOrderId: orderId, lastCycles, lastCycleSubId: subId || existing?.lastCycleSubId || null, lastCycleNum: subId ? (lastCycles[subId] ?? existing?.lastCycleNum ?? null) : (existing?.lastCycleNum ?? null) }))
      results.push({ email, status: 'active', expiresAt })
    } else if (DEACTIVATE_EVENTS.has(event)) {
      // Cancelamento/pausa de renovação mantém acesso até o fim do período pago; reembolso/chargeback revoga na hora.
      const immediate = event === 'refund' || event === 'chargeback' || event === 'subscription_paused'
      const expiresAt = immediate && (event === 'refund' || event === 'chargeback') ? now.toISOString() : (existing?.expiresAt || now.toISOString())
      const status = event === 'subscription_paused' ? 'paused' : 'canceled'
      await kv.put(subKey, JSON.stringify({ ...(existing || { email, name: data?.customer?.name || '' }), email, status, revoked: immediate, plan: 'pro-monthly', expiresAt, updatedAt: now.toISOString(), lastOrderId: orderId }))
      results.push({ email, status, expiresAt })
    } else {
      results.push({ email, skipped: 'event_ignored' })
    }
    if (orderId) await kv.put(`order:${orderId}`, '1')
  }
  return results
}

const json = (obj, status = 200, extraHeaders = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', ...extraHeaders } })

async function adminGate(request, env, token) {
  if (!env.LICENSE_DO) return { status: 500, body: { ok: false, error: 'do_not_configured' } }
  const rawIp = (request.headers.get('cf-connecting-ip') || '').trim()
  const ipHash = await sha256Hex(/^[0-9a-fA-F:.]+$/.test(rawIp) ? rawIp : 'unknown')
  const adminToken = normalizeSecret(env.ADMIN_TOKEN || '')
  const authenticated = adminToken ? await timingSafeEqualStr(normalizeSecret(token || ''), adminToken) : false
  const adminStub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('admin'))
  let ar
  try {
    ar = await adminStub.fetch('https://license-store/internal/admin-gate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ipHash, authenticated }) })
  } catch { return { status: 500, body: { ok: false, error: 'failed' } } }
  const ad = await ar.json().catch(() => ({}))
  if (ar.status === 429) return { status: 429, body: { ok: false, error: 'rate_limited' }, retryAfter: ad.retryAfter || 900 }
  if (!ad.ok) return { status: 401, body: { ok: false, error: 'unauthorized' } }
  return { status: 200, body: { ok: true } }
}
async function freezeAcquire(env, opId) {
  const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
  const r = await stub.fetch('https://license-store/internal/freeze-acquire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId }) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(d.error || 'frozen'); e.status = r.status; e.body = d; throw e }
  return d
}
async function freezeRelease(env, opId) {
  // Backup do Worker: só reservas (nunca started — a conclusão de started é exclusiva do DO responsável).
  try {
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    await stub.fetch('https://license-store/internal/freeze-release-reserved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId }) })
  } catch (e) { console.error('[freeze] release failed') }
}
async function freezeState(env) {
  const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
  const r = await stub.fetch('https://license-store/internal/freeze-state')
  return r.json().catch(() => ({}))
}
async function registerEmail(env, email) {
  const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
  const r = await stub.fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
  if (!r.ok) throw new Error('registry_failed')
  return r.json().catch(() => ({}))
}

function htmlPage(body, status = 200) {
  return new Response(body, { status, headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } })
}
function licenseSummary(email, sub) {
  if (!sub) return { email, status: 'none' }
  const expiresAt = sub.expiresAt || null
  const expired = !expiresAt || new Date(expiresAt) <= new Date()
  const paused = sub.revoked === true || sub.status === 'paused'
  const status = paused ? 'paused' : expired ? 'expired' : (sub.status === 'active' || sub.status === 'canceled') ? 'active' : 'inactive'
  return { email, status, expiresAt, plan: sub.plan || 'pro-monthly', device: sub.deviceId ? '…' + String(sub.deviceId).slice(-6) : '', updatedAt: sub.updatedAt || sub.createdAt || '' }
}
async function listLicenses(env, email, cursor, limit) {
  const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
  let emails = []; let next = null; let complete = true
  if (email) emails = [email]
  else {
    const r = await reg.fetch('https://license-store/internal/list-index', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: cursor || undefined, limit }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error('registry_failed')
    emails = d.emails || []; next = d.cursor || null; complete = d.complete === true
  }
  const entries = []
  for (const em of emails) {
    try {
      const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName(em))
      const r = await stub.fetch('https://license-store/internal/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: em }) })
      const d = await r.json().catch(() => ({}))
      entries.push(licenseSummary(em, d.sub))
    } catch { entries.push({ email: em, status: 'error' }) }
  }
  return { entries, cursor: next, complete }
}

const ADMIN_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NoAzul — Admin</title><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#0b1220;color:#e5edf7}header{display:flex;align-items:center;gap:.6rem;padding:1rem 1.2rem;background:#111a2c;border-bottom:1px solid #22314a}header b{color:#34d399}main{max-width:1100px;margin:0 auto;padding:1.2rem}.card{background:#111a2c;border:1px solid #22314a;border-radius:14px;padding:1.1rem;margin-bottom:1rem}h1,h2{margin:.2rem 0 .8rem;font-size:1.1rem}.muted{color:#94a3b8}.row{display:flex;gap:.5rem;flex-wrap:wrap}input{flex:1;min-width:200px;background:#0b1220;border:1px solid #2b3b58;color:#e5edf7;border-radius:10px;padding:.65rem .8rem;font:inherit}button{background:#059669;border:0;color:#fff;border-radius:10px;padding:.65rem .9rem;font:inherit;font-weight:700;cursor:pointer}button.ghost{background:#1e293b;border:1px solid #334155}button.mini{padding:.35rem .6rem;font-size:.78rem;background:#334155}button:disabled{opacity:.5;cursor:not-allowed}table{width:100%;border-collapse:collapse;background:#111a2c;border:1px solid #22314a;border-radius:14px;overflow:hidden}th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid #1c2a42;vertical-align:middle}th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8}td{font-size:.85rem}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.6rem;margin-bottom:1rem}.stat{background:#111a2c;border:1px solid #22314a;border-radius:12px;padding:.7rem .8rem}.stat .num{font-size:1.35rem;font-weight:800}.pill{display:inline-block;border-radius:999px;padding:.15rem .5rem;font-size:.72rem;font-weight:800}.ok{background:#064e3b;color:#6ee7b7}.warn{background:#78350f;color:#fcd34d}.bad{background:#7f1d1d;color:#fecaca}.msg{min-height:1.2rem;color:#fcd34d;margin:.4rem 0}.freeze{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
</style></head><body><header><b>NoAzul</b><span class="muted">painel administrativo</span></header><main>
<section id="login" class="card"><h1>Entrar</h1><p class="muted">Informe o ADMIN_TOKEN configurado no Worker. Recomendado proteger esta rota com Cloudflare Access.</p><div class="row"><input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password"><button onclick="login()">Entrar</button></div></section>
<section id="panel" hidden>
<div class="card"><div class="row"><input id="q" placeholder="Buscar por e-mail"><button onclick="load()">Buscar</button><button class="ghost" id="more" onclick="fetchPage(true)">Carregar mais</button><button class="ghost" onclick="logout()">Sair</button></div><div class="msg" id="msg"></div><div class="stats" id="stats"></div><table><thead><tr><th>E-mail</th><th>Status</th><th>Expira</th><th>Aparelho</th><th>Atualizado</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="card"><h2>Congelamento (manutenção)</h2><p class="muted">Congela escritas durante exportação/restauração. Use Confirmar para concluir e Descongelar para voltar.</p><div class="freeze"><button onclick="freeze('freeze')">Congelar</button><button class="ghost" onclick="freeze('freeze/confirm')">Confirmar</button><button class="ghost" onclick="freeze('freeze/unlock')">Descongelar</button><button class="ghost" onclick="freeze('freeze/state')">Atualizar estado</button></div><p class="muted" id="freeze"></p></div>
</section></main><script>
var TOKEN_KEY='noazul.admin.token';var token='',cursor=null,rows=[],loadedAll=true;
function $(id){return document.getElementById(id)}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function toast(m){var el=$('msg');el.textContent=m||'';if(m)setTimeout(function(){el.textContent=''},5000)}
function api(path,body){body=body||{};body.token=token;return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok)throw new Error((d&&d.error)||('HTTP '+r.status));return d})})}
function login(){var t=$('token').value.trim();if(!t)return;token=t;sessionStorage.setItem(TOKEN_KEY,t);showPanel();load()}
function logout(){token='';sessionStorage.removeItem(TOKEN_KEY);$('panel').hidden=true;$('login').hidden=false;$('token').value=''}
function showPanel(){$('login').hidden=true;$('panel').hidden=false}
function load(){cursor=null;rows=[];fetchPage(false)}
function fetchPage(more){var body={limit:25};var q=$('q').value.trim();if(q)body.email=q;if(more&&cursor)body.cursor=cursor;api('/admin/licenses',body).then(function(d){if(!more)rows=[];rows=rows.concat(d.entries||[]);cursor=d.cursor;loadedAll=d.complete===true;render();$('more').disabled=loadedAll}).catch(function(e){toast(e.message)})}
function label(s){return {active:'Ativa',expired:'Expirada',paused:'Pausada',none:'Sem assinatura',inactive:'Inativa',error:'Erro'}[s]||s}
function fmt(s){if(!s)return '—';var d=new Date(s);return isNaN(d)?String(s):d.toLocaleString('pt-BR')}
function card(l,v){return '<div class="stat"><div class="muted">'+esc(l)+'</div><div class="num">'+esc(v)+'</div></div>'}
function render(){var now=Date.now();var active=0,expired=0,paused=0,none=0,expiring=0;rows.forEach(function(r){if(r.status==='active'){active++;if(r.expiresAt){var d=(new Date(r.expiresAt).getTime()-now)/86400000;if(d>=0&&d<=7)expiring++}}else if(r.status==='expired')expired++;else if(r.status==='paused')paused++;else if(r.status==='none')none++});$('stats').innerHTML=card('Ativas',active)+card('Expirando (7d)',expiring)+card('Expiradas',expired)+card('Pausadas',paused)+card('Sem assinatura',none)+card('Carregadas',rows.length);var out='';rows.forEach(function(r){var cls=r.status==='active'?'ok':r.status==='expired'?'warn':'bad';out+='<tr><td>'+esc(r.email)+'</td><td><span class="pill '+cls+'">'+esc(label(r.status))+'</span></td><td>'+esc(fmt(r.expiresAt))+'</td><td>'+esc(r.device||'—')+'</td><td>'+esc(fmt(r.updatedAt))+'</td><td><button class="mini" data-email="'+esc(r.email)+'">Resetar aparelho</button></td></tr>'});$('rows').innerHTML=out||'<tr><td colspan="6" class="muted">Nenhum resultado.</td></tr>';Array.prototype.forEach.call(document.querySelectorAll('button[data-email]'),function(b){b.onclick=function(){resetDevice(b.getAttribute('data-email'))}})}
function resetDevice(email){if(!confirm('Resetar o vínculo de aparelho de '+email+'?'))return;api('/admin/reset-device',{email:email}).then(function(){toast('Aparelho resetado');fetchPage(false)}).catch(function(e){toast(e.message)})}
function freeze(path){api('/admin/'+path,{}).then(function(d){$('freeze').textContent='Estado: '+(d.state||'ok');toast('Operação concluída')}).catch(function(e){toast(e.message)})}
var saved=sessionStorage.getItem(TOKEN_KEY);if(saved){token=saved;showPanel();load()}
</script></body></html>`

const PORTAL_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NoAzul — Minha assinatura</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;background:#f1f5f9;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}.card{background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:1.5rem;max-width:430px;width:100%;box-shadow:0 16px 40px rgba(15,23,42,.08)}h1{margin:0 0 .3rem;font-size:1.35rem}.muted{color:#64748b}input{width:100%;margin:.8rem 0;border:1px solid #cbd5e1;border-radius:12px;padding:.75rem .9rem;font:inherit}button{width:100%;background:#059669;border:0;color:#fff;border-radius:12px;padding:.8rem;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.6}.result{margin-top:1rem;padding:.9rem;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0}.ok{color:#047857;font-weight:800}.warn{color:#b45309;font-weight:800}.bad{color:#b91c1c;font-weight:800}
</style></head><body><div class="card"><h1>Minha assinatura NoAzul Pro</h1><p class="muted">Consulte a validade da assinatura vinculada ao seu e-mail. Por segurança, não mostramos dados do aparelho.</p><form onsubmit="check(event)"><input id="email" type="email" required placeholder="seu@email.com" autocomplete="email"><button id="btn" type="submit">Consultar</button></form><div id="out"></div></div><script>
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function fmt(s){if(!s)return '—';var d=new Date(s);return isNaN(d)?String(s):d.toLocaleDateString('pt-BR')}
function check(e){e.preventDefault();var email=document.getElementById('email').value.trim();var out=document.getElementById('out');var btn=document.getElementById('btn');if(!email)return;btn.disabled=true;out.innerHTML='<div class="result muted">Consultando…</div>';fetch('/portal/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email})}).then(function(r){return r.json().catch(function(){return {}})}).then(function(d){if(!d.ok){out.innerHTML='<div class="result bad">'+esc(d.message||'Não foi possível consultar agora.')+'</div>';return}if(!d.found||d.status==='none'){out.innerHTML='<div class="result bad">Não encontramos assinatura para este e-mail.</div>';return}var cls=d.status==='active'?'ok':d.status==='paused'?'warn':'bad';var label=d.status==='active'?'Ativa':d.status==='paused'?'Pausada':'Expirada';out.innerHTML='<div class="result"><div class="'+cls+'">'+label+'</div><div class="muted">Plano: '+esc(d.plan||'Pro')+'</div><div class="muted">Validade: '+esc(fmt(d.expiresAt))+'</div>'+(d.status==='active'?'<div class="muted">Tudo certo! Se precisar trocar de aparelho, peça o reset no suporte.</div>':'<div class="muted">Para renovar, use o link de compra que você recebeu.</div>')+'</div>'}).catch(function(){out.innerHTML='<div class="result bad">Sem conexão. Tente novamente.</div>'}).then(function(){btn.disabled=false})}
</script></body></html>`

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return json({}, 204)
    if (url.pathname === '/health' || url.pathname === '/') return json({ ok: true, service: 'noazul-license' })

    if (url.pathname === '/admin' && request.method === 'GET') return htmlPage(ADMIN_HTML)
    if (url.pathname === '/portal' && request.method === 'GET') return htmlPage(PORTAL_HTML)
    if (url.pathname === '/portal/status' && request.method === 'POST') {
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured', message: 'Serviço indisponível.' }, 500)
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json', message: 'Requisição inválida.' }, 400) }
      const email = normalizeEmail(body.email)
      if (!email) return json({ ok: false, error: 'email_required', message: 'Informe seu e-mail.' }, 400)
      const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName(email))
      const r = await stub.fetch('https://license-store/internal/portal-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
      return json(await r.json().catch(() => ({ ok: false, error: 'failed', message: 'Tente novamente.' })), r.status)
    }
    if (url.pathname === '/admin/licenses' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      const email = body.email ? normalizeEmail(body.email) : ''
      if (body.email && !email) return json({ ok: false, error: 'invalid_email' }, 400)
      const limit = Math.min(50, Math.max(1, Number(body.limit) || 25))
      try {
        const data = await listLicenses(env, email, body.cursor, limit)
        return json({ ok: true, ...data })
      } catch { return json({ ok: false, error: 'registry_failed' }, 500) }
    }

    if (url.pathname === '/webhook/cakto' && request.method === 'POST') {
      const raw = await request.arrayBuffer()
      const timestamp = request.headers.get('x-cakto-timestamp') || ''
      const signature = request.headers.get('x-cakto-signature') || ''
      let payload
      try { payload = JSON.parse(new TextDecoder().decode(raw)) } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const secret = normalizeSecret(env.CAKTO_WEBHOOK_SECRET || '')
      const auth = await authenticateWebhook(new Uint8Array(raw), timestamp, signature, payload, secret)
      if (!auth.ok) {
        console.warn('[webhook] auth failed', { reason: auth.reason, event: payload?.event || null, hasTimestamp: Boolean(timestamp), hasSignature: Boolean(signature) })
        return json({ ok: false, error: 'unauthorized' }, 401)
      }
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured' }, 500)
      // Um DO por e-mail: agrupa os pedidos por cliente e processa cada grupo na sua instância.
      const orders = extractOrders(payload); const byEmail = new Map()
      for (const o of orders) { const em = normalizeEmail(o?.customer?.email || o?.customerEmail); if (!em) continue; if (!byEmail.has(em)) byEmail.set(em, []); byEmail.get(em).push(o) }
      const results = []
      let groupIndex = 0
      for (const [em, group] of byEmail) {
        // Lease por grupo (o DO libera ao concluir a chamada) — um webhook multi-e-mail não compartilha um lease único.
        const opId = crypto.randomUUID()
        try { await freezeAcquire(env, opId) } catch (e) { const s = e?.status || 500; return json({ ok: false, error: s === 503 ? 'frozen' : 'registry_failed' }, s === 503 ? 503 : 500) }
        try {
          try { await registerEmail(env, em) } catch { console.error('[webhook] registry failed', { event: payload?.event || null }); return json({ ok: false, error: 'registry_failed' }, 500) }
          const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName(em))
          const r = await stub.fetch('https://license-store/internal/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: payload.event, data: group, opId }) })
          if (!r.ok) {
            console.error('[webhook] license store failed', { status: r.status, event: payload?.event || null, groupIndex })
            return json({ ok: false, error: 'license_store_failed' }, 500)
          }
          const d = await r.json().catch(() => ({})); results.push(...(d.results || []))
        } finally { await freezeRelease(env, opId) }
        groupIndex++
      }
      return json({ ok: true, results })
    }

    if (url.pathname === '/admin/freeze' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured' }, 500)
      const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
      const r = await stub.fetch('https://license-store/internal/freeze-start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      return json(await r.json().catch(() => ({ ok: false, error: 'failed' })), r.status)
    }
    if (url.pathname === '/admin/freeze/confirm' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured' }, 500)
      const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
      const r = await stub.fetch('https://license-store/internal/freeze-confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      return json(await r.json().catch(() => ({ ok: false, error: 'failed' })), r.status)
    }
    if (url.pathname === '/admin/freeze/state' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured' }, 500)
      const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
      const r = await stub.fetch('https://license-store/internal/freeze-state')
      return json(await r.json().catch(() => ({ ok: false, error: 'failed' })), r.status)
    }
    if (url.pathname === '/admin/freeze/unlock' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured' }, 500)
      const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
      const r = await stub.fetch('https://license-store/internal/freeze-unlock', { method: 'POST', headers: { 'content-type': 'application.json' }, body: '{}' })
      return json(await r.json().catch(() => ({ ok: false, error: 'failed' })), r.status)
    }

    if (url.pathname === '/admin/reset-device' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      const email = normalizeEmail(body.email)
      if (!email) return json({ ok: false, error: 'email_required' }, 400)
      const opId = crypto.randomUUID()
      try { await freezeAcquire(env, opId) } catch (e) { const s = e?.status || 500; return json({ ok: false, error: s === 503 ? 'frozen' : 'registry_failed' }, s === 503 ? 503 : 500) }
      try {
        try { await registerEmail(env, email) } catch { return json({ ok: false, error: 'registry_failed' }, 500) }
        const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName(email))
        const r = await stub.fetch('https://license-store/internal/reset-device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, opId }) })
        return json(await r.json().catch(() => ({ ok: false, error: 'failed' })), r.status)
      } finally { await freezeRelease(env, opId) }
    }

    if (url.pathname === '/admin/bootstrap' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      const entries = []
      if (Array.isArray(body.emails)) for (const e of body.emails) { const em = normalizeEmail(e); if (em) entries.push({ email: em, source: 'bootstrap-external' }) }
      let kvCount = 0
      if (env.LICENSES && typeof env.LICENSES.list === 'function') {
        let cursor = undefined
        do {
          const page = await env.LICENSES.list({ prefix: 'sub:', cursor, limit: 1000 })
          const keys = page.keys || []
          for (const k of keys) { const em = normalizeEmail(String(k.name).slice(4)); if (em) entries.push({ email: em, source: 'bootstrap-kv' }) }
          cursor = page.cursor; if (!page.list_complete && !cursor) break
        } while (cursor)
        kvCount = entries.filter(e => e.source === 'bootstrap-kv').length
      }
      const opId = crypto.randomUUID()
      try { await freezeAcquire(env, opId) } catch (e) { const s = e?.status || 500; return json({ ok: false, error: s === 503 ? 'frozen' : 'registry_failed' }, s === 503 ? 503 : 500) }
      try {
        const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
        const r = await stub.fetch('https://license-store/internal/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries }) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) return json(d, r.status)
        return json({ ok: true, registered: d.registered || 0, kvCensus: kvCount, external: entries.filter(e => e.source === 'bootstrap-external').length })
      } finally { await freezeRelease(env, opId) }
    }

    if (url.pathname === '/admin/export' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured' }, 500)
      const fs = await freezeState(env)
      if (fs.state !== 'frozen') return json({ ok: false, error: 'freeze_required', state: fs.state || 'running' }, 409)
      const limit = Math.min(100, Math.max(1, Number(body.limit || 50)))
      const regStub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
      let snapshotId = typeof body.snapshotId === 'string' && body.snapshotId ? body.snapshotId : null
      let totalRecords = null; let exportedAt = null
      if (!snapshotId) {
        const begin = await regStub.fetch('https://license-store/internal/snapshot-begin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        const bd = await begin.json().catch(() => ({}))
        if (!begin.ok || !bd.snapshotId) return json({ ok: false, error: 'export_incomplete' }, 500)
        snapshotId = bd.snapshotId; totalRecords = bd.totalRecords
      }
      const fsb = await freezeState(env)
      if (fsb.state !== 'frozen') return json({ ok: false, error: 'freeze_required', state: fsb.state || 'running' }, 409)
      const lr = await regStub.fetch('https://license-store/internal/snapshot-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId, cursor: body.cursor || null, limit }) })
      const listed = await lr.json().catch(() => ({}))
      if (!lr.ok) return json({ ok: false, error: 'export_incomplete' }, 500)
      totalRecords = listed.totalRecords; exportedAt = listed.exportedAt
      const records = []; const checksums = {}; let batchOrders = 0
      for (const email of listed.emails || []) {
        const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName(email))
        const r = await stub.fetch('https://license-store/internal/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
        if (!r.ok) return json({ ok: false, error: 'export_incomplete' }, 500)
        const d = await r.json().catch(() => null)
        if (!d || !d.ok) return json({ ok: false, error: 'export_incomplete' }, 500)
        records.push({ email, sub: d.sub, orders: d.orders || {} })
        checksums[email] = await sha256HexObj({ sub: d.sub, orders: d.orders || {} })
        batchOrders += Object.keys(d.orders || {}).length
      }
      const start = Number(body.cursor || 0) || 0
      const upd = await regStub.fetch('https://license-store/internal/snapshot-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId, batchId: `${snapshotId}:batch:${start}`, start, end: start + records.length, orders: batchOrders, records: records.length }) })
      const ud = await upd.json().catch(() => ({}))
      if (!upd.ok) return json({ ok: false, error: 'export_incomplete' }, 500)
      const manifest = { version: 1, snapshotId, exportedAt, complete: ud.concluded === true, totalRecords, batchCount: records.length, totalOrders: ud.totalOrders, checksums, coverage: { indexBatch: (listed.emails || []).length, historicallyComplete: false, note: 'DO-only records predating the registry cannot be discovered; historically complete only after bootstrap with an external email list.' } }
      return json({ ok: true, snapshotId, cursor: listed.cursor || null, complete: ud.concluded === true, records, manifest })
    }

    if (url.pathname === '/admin/restore-kv' && request.method === 'POST') {
      let body = {}
      try { body = JSON.parse(await request.text() || '{}') } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
      const gate = await adminGate(request, env, body.token)
      if (gate.status === 429) return json({ ok: false, error: 'rate_limited' }, 429, { 'retry-after': String(gate.retryAfter || 900) })
      if (gate.status !== 200) return json(gate.body, gate.status)
      if (!env.LICENSES) return json({ ok: false, error: 'kv_not_configured' }, 500)
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured' }, 500)
      const fsr = await freezeState(env)
      if (fsr.state !== 'frozen') return json({ ok: false, error: 'freeze_required', state: fsr.state || 'running' }, 409)
      const records = Array.isArray(body.records) ? body.records : null
      const manifest = body.manifest
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const HEX64_RE = /^[0-9a-f]{64}$/i
      // Fase 1: validar TUDO (manifesto, estrutura, contagens, checksums) antes de gravar qualquer coisa.
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return json({ ok: false, error: 'manifest_missing' }, 400)
      if (manifest.version !== 1) return json({ ok: false, error: 'unsupported_version' }, 400)
      if (typeof manifest.snapshotId !== 'string' || !UUID_RE.test(manifest.snapshotId)) return json({ ok: false, error: 'invalid_snapshot_id' }, 400)
      if (manifest.complete !== true) return json({ ok: false, error: 'snapshot_incomplete' }, 400)
      if (!records || !records.length) return json({ ok: false, error: 'invalid_records' }, 400)
      const checksums = manifest.checksums
      if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums)) return json({ ok: false, error: 'manifest_missing_checksums' }, 400)
      // H-S1: o manifesto não é sua própria prova — a sessão precisa existir e estar concluída no registry.
      const regStub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
      const sr = await regStub.fetch('https://license-store/internal/snapshot-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: manifest.snapshotId }) })
      const session = await sr.json().catch(() => ({}))
      if (!sr.ok) return json({ ok: false, error: 'snapshot_not_found' }, 400)
      if (session.concluded !== true) return json({ ok: false, error: 'snapshot_not_concluded' }, 400)
      if (!coverageComplete(session.batches || {}, session.totalRecords)) return json({ ok: false, error: 'snapshot_incomplete' }, 400)
      if (manifest.totalRecords !== session.totalRecords || manifest.totalOrders !== session.exportedOrders) return json({ ok: false, error: 'count_mismatch' }, 400)
      // F-3: recalcular a partir dos lotes persistidos — o total acumulado declarado não é confiável sozinho.
      const recalcOrders = Object.values(session.batches || {}).reduce((acc, b) => acc + (Number(b?.orders) || 0), 0)
      for (const b of Object.values(session.batches || {})) {
        if (!Number.isInteger(b?.start) || !Number.isInteger(b?.end) || !Number.isInteger(b?.orders) || b.orders < 0 || !Number.isInteger(b?.records) || b.records !== b.end - b.start) return json({ ok: false, error: 'count_mismatch' }, 400)
      }
      if (recalcOrders !== session.exportedOrders) return json({ ok: false, error: 'count_mismatch' }, 400)
      if (manifest.exportedAt !== session.createdAt) return json({ ok: false, error: 'snapshot_mismatch' }, 400)
      const plan = []; const seenEmails = new Set(); let ordersTotal = 0
      for (const rec of records) {
        const email = normalizeEmail(rec?.email)
        if (!email || !rec.sub || typeof rec.sub !== 'object' || Array.isArray(rec.sub) || normalizeEmail(rec.sub.email) !== email) return json({ ok: false, error: 'invalid_record', email: email || null }, 400)
        if (seenEmails.has(email)) return json({ ok: false, error: 'duplicate_record', email }, 400)
        seenEmails.add(email)
        const sub = rec.sub
        if (typeof sub.status !== 'string' || !sub.status) return json({ ok: false, error: 'invalid_record', email }, 400)
        if (!(sub.expiresAt === null || (typeof sub.expiresAt === 'string' && !Number.isNaN(Date.parse(sub.expiresAt))))) return json({ ok: false, error: 'invalid_record', email }, 400)
        if (sub.revoked != null && typeof sub.revoked !== 'boolean') return json({ ok: false, error: 'invalid_record', email }, 400)
        if (sub.deviceId != null && typeof sub.deviceId !== 'string') return json({ ok: false, error: 'invalid_record', email }, 400)
        if (sub.plan != null && typeof sub.plan !== 'string') return json({ ok: false, error: 'invalid_record', email }, 400)
        if (rec.orders != null && (typeof rec.orders !== 'object' || Array.isArray(rec.orders))) return json({ ok: false, error: 'invalid_orders', email }, 400)
        const orders = rec.orders || {}
        for (const [oid, val] of Object.entries(orders)) { if (!oid || (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean')) return json({ ok: false, error: 'invalid_orders', email }, 400) }
        ordersTotal += Object.keys(orders).length
        const expected = checksums[email]
        if (typeof expected !== 'string' || !expected) return json({ ok: false, error: 'checksum_missing', email }, 400)
        if (!HEX64_RE.test(expected)) return json({ ok: false, error: 'checksum_invalid', email }, 400)
        const actual = await sha256HexObj({ sub, orders })
        if (actual !== expected.toLowerCase()) return json({ ok: false, error: 'checksum_mismatch', email }, 400)
        plan.push({ email, sub, orders })
      }
      // Correspondência exata registros <-> manifesto (nada ausente, nada extra)
      const checksumEmails = Object.keys(checksums)
      if (checksumEmails.length !== seenEmails.size || checksumEmails.some(e => !seenEmails.has(normalizeEmail(e)))) return json({ ok: false, error: 'manifest_mismatch' }, 400)
      if (!Number.isInteger(manifest.totalRecords) || manifest.totalRecords !== records.length) return json({ ok: false, error: 'count_mismatch' }, 400)
      if (!Number.isInteger(manifest.totalOrders) || manifest.totalOrders !== ordersTotal) return json({ ok: false, error: 'count_mismatch' }, 400)
      if (manifest.batchCount != null && (!Number.isInteger(manifest.batchCount) || manifest.batchCount < 1)) return json({ ok: false, error: 'count_mismatch' }, 400)
      // Registros devem cobrir exatamente a lista congelada da sessão (nada ausente, nada extra)
      const sessionEmails = new Set((session.emails || []).map(e => normalizeEmail(e)))
      if (seenEmails.size !== sessionEmails.size || [...seenEmails].some(e => !sessionEmails.has(e))) return json({ ok: false, error: 'manifest_mismatch' }, 400)
      // H-S2: anti-ressurreição — snapshot mais antigo que o estado atual no DO é rejeitado (sem escritas).
      for (const p of plan) {
        const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName(p.email))
        let cr
        try { cr = await stub.fetch('https://license-store/internal/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: p.email }) }) }
        catch { return json({ ok: false, error: 'current_state_unavailable', email: p.email }, 500) }
        if (!cr.ok) return json({ ok: false, error: 'current_state_unavailable', email: p.email }, 500)
        const cur = await cr.json().catch(() => null)
        if (!cur || !cur.ok) return json({ ok: false, error: 'current_state_unavailable', email: p.email }, 500)
        const curSub = cur?.sub
        if (curSub) {
          if (curSub.revoked === true && p.sub.revoked !== true) return json({ ok: false, error: 'stale_snapshot', email: p.email }, 400)
          const curUp = Date.parse(curSub.updatedAt); const snapUp = Date.parse(p.sub.updatedAt)
          if (!Number.isFinite(curUp) || !Number.isFinite(snapUp)) return json({ ok: false, error: 'temporal_unverifiable', email: p.email }, 400)
          if (curUp > snapUp) return json({ ok: false, error: 'stale_snapshot', email: p.email }, 400)
        }
      }
      // Fase 2: gravar idempotentemente (nunca apaga; overwrite do mesmo valor é seguro e retomável)
      for (const p of plan) {
        await env.LICENSES.put(`sub:${p.email}`, JSON.stringify(p.sub))
        for (const [oid, val] of Object.entries(p.orders)) await env.LICENSES.put(`order:${oid}`, String(val))
      }
      // Fase 3: verificar por leitura posterior
      for (const p of plan) {
        const back = await env.LICENSES.get(`sub:${p.email}`)
        if (!back || JSON.parse(back).email !== p.email) return json({ ok: false, error: 'verify_failed', email: p.email }, 500)
        for (const [oid, val] of Object.entries(p.orders)) { const ov = await env.LICENSES.get(`order:${oid}`); if (ov == null || String(ov) !== String(val)) return json({ ok: false, error: 'verify_failed', email: p.email }, 500) }
      }
      return json({ ok: true, restored: plan.length, verified: plan.length })
    }

    if (url.pathname === '/license' && request.method === 'GET') {
      const email = normalizeEmail(url.searchParams.get('email'))
      const deviceId = String(url.searchParams.get('deviceId') || '').trim()
      if (!email) return json({ ok: false, error: 'email_required', message: 'Informe seu e-mail.' }, 400)
      if (!deviceId) return json({ ok: false, error: 'device_required', message: 'Identificação do aparelho ausente.' }, 400)
      if (!env.LICENSE_DO) return json({ ok: false, error: 'do_not_configured' }, 500)
      const opId = crypto.randomUUID()
      try { await freezeAcquire(env, opId) } catch (e) { const s = e?.status || 500; return json({ ok: false, error: s === 503 ? 'frozen' : 'registry_failed' }, s === 503 ? 503 : 500) }
      try {
        try { await registerEmail(env, email) } catch { return json({ ok: false, error: 'registry_failed' }, 500) }
        const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName(email))
        const r = await stub.fetch(`https://license-store/internal/license?email=${encodeURIComponent(email)}&deviceId=${encodeURIComponent(deviceId)}&opId=${encodeURIComponent(opId)}`)
        const decision = await r.json().catch(() => ({}))
        if (!decision.ok) return json(decision, r.status)
        if (!env.PRIVATE_KEY_PEM) return json({ ok: false, error: 'server_not_configured' }, 500)
        const payload = { holder: decision.holder || email, deviceId, issuedAt: new Date().toISOString(), expiresAt: decision.expiresAt, plan: 'pro-monthly' }
        const key = await signLicense(payload, env.PRIVATE_KEY_PEM)
        return json({ ok: true, key, expiresAt: decision.expiresAt, holder: payload.holder, plan: 'pro-monthly' })
      } finally { await freezeRelease(env, opId) }
    }

    return json({ ok: false, error: 'not_found' }, 404)
  },
}
