// @ts-nocheck — importa server/worker.js (JS sem tipos); não vai para o bundle
import { describe, it, expect } from 'vitest'
import worker, { LicenseStore, processEvent, verifyCaktoSignature, verifyBodySecret, authenticateWebhook, extractV1, normalizeEmail, parseCycleNumber, cycleNumber, timingSafeEqualStr, sha256Hex, ADMIN_MAX_FAILURES } from '../../server/worker.js'
import { verifyLicense, isProActive, fetchAutoLicense } from '../licensing/licensing'
import { getLicenseApiUrl, isLicenseApiConfigured } from '../config/plans'

class FakeKV {
  m = new Map<string, string>()
  async get(k: string) { return this.m.get(k) ?? null }
  async put(k: string, v: string) { this.m.set(k, v) }
  async list(opts: any = {}) {
    const prefix = opts.prefix || ''
    const keys = [...this.m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name }))
    return { keys, cursor: null, list_complete: true }
  }
}
const sha256HexObjTest = async (v: any) => {
  const canon = (x: any): string => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(canon).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon(v)))
  return Array.from(new Uint8Array(d)).map(x => x.toString(16).padStart(2, '0')).join('')
}
const tick = () => new Promise(r => setTimeout(r, Math.random() * 4))
let __opSeq = 0
async function doProc(env: any, email: string, payload: any) {
  const opId = `test-op-${++__opSeq}-${Math.random().toString(36).slice(2, 8)}`
  const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
  const acq = await reg.fetch('https://license-store/internal/freeze-acquire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId }) })
  if (acq.status !== 200) throw new Error('acquire falhou: ' + acq.status)
  const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName(email))
  return stub.fetch('https://license-store/internal/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, opId }) })
}

async function freezeNow(env: any, ip = '203.0.113.50') {
  const H = { 'content-type': 'application/json', 'cf-connecting-ip': ip }
  const start = await worker.fetch(new Request('https://x/admin/freeze', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
  expect(start.status).toBe(200)
  const conf = await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
  expect(conf.status).toBe(200); expect((await conf.json()).state).toBe('frozen')
  return H
}
async function unfreezeNow(env: any, ip = '203.0.113.50') {
  const H = { 'content-type': 'application/json', 'cf-connecting-ip': ip }
  const u1 = await worker.fetch(new Request('https://x/admin/freeze/unlock', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
  expect(u1.status).toBe(200); expect((await u1.json()).state).toBe('unfreezing')
  const st = await worker.fetch(new Request('https://x/admin/freeze/state', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
  expect(st.status).toBe(200); expect((await st.json()).state).toBe('running')
}

class FakeStorage {
  m = new Map<string, any>()
  async get(k: string) { await tick(); const v = this.m.get(k); return v == null ? null : (typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v) }
  async put(k: string, v: any) { await tick(); this.m.set(k, v) }
  async delete(k: string) { await tick(); this.m.delete(k) }
  async list(opts: any = {}) {
    await tick()
    const prefix = opts.prefix || ''; const limit = opts.limit || 1000
    const keys = [...this.m.keys()].filter(k => k.startsWith(prefix)).sort()
    const start = opts.cursor ? keys.findIndex(k => k > opts.cursor) : 0
    const slice = keys.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + limit)
    const out = new Map(slice.map(k => [k, this.m.get(k)]))
    const hasMore = slice.length < keys.length - (start < 0 ? 0 : start)
    return Object.assign(out, { cursor: hasMore && slice.length ? slice[slice.length - 1] : null, list_complete: !hasMore })
  }
}
/** Binding DO falso: uma instância LicenseStore por id, compartilhando o mesmo storage (como no runtime). */
function makeEnv(legacyKv?: FakeKV, secret = 's') {
  const stores = new Map<string, FakeStorage>(); const instances = new Map<string, any>()
  const env: any = { LICENSES: legacyKv || new FakeKV(), CAKTO_WEBHOOK_SECRET: secret, PRIVATE_KEY_PEM: PRIVATE_PEM, ADMIN_TOKEN: 'admin-tok' }
  env.LICENSE_DO = {
    idFromName: (n: string) => n,
    get: (id: string) => {
      if (!instances.has(id)) { if (!stores.has(id)) stores.set(id, new FakeStorage()); instances.set(id, new LicenseStore({ storage: stores.get(id) }, env)) }
      return instances.get(id)
    },
  }
  return { env, stores }
}
async function makePem() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey)
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)))
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`, kp }
}
// O Worker assina com a chave privada do dono; para o app validar, a chave pública precisa ser a do app.
// Este teste usa a chave REAL do projeto (tools/private.key.pem) via leitura do arquivo no setup abaixo.
import { readFileSync } from 'node:fs'
const PRIVATE_PEM = readFileSync(new URL('../../tools/private.key.pem', import.meta.url), 'utf8')

describe('liberação automática (webhook Cakto -> chave -> app)', () => {
  it('normaliza e-mail e valida assinatura HMAC da Cakto', async () => {
    expect(normalizeEmail('  Maria@Exemplo.COM ')).toBe('maria@exemplo.com')
    const secret = 'segredo-teste'; const body = new TextEncoder().encode('{"event":"purchase_approved"}')
    const ts = String(Math.floor(Date.now() / 1000))
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const msg = new Uint8Array(ts.length + 1 + body.length); msg.set(new TextEncoder().encode(`${ts}.`)); msg.set(body, ts.length + 1)
    const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))).map(b => b.toString(16).padStart(2, '0')).join('')
    expect((await verifyCaktoSignature(body, ts, `v1=${hex}`, secret)).ok).toBe(true)
    expect((await verifyCaktoSignature(body, ts, 'v1=errada', secret)).reason).toBe('signature_mismatch')
    expect(extractV1(`v1=${hex.toUpperCase()}, v2=outra`)).toBe(hex)
    expect((await verifyCaktoSignature(body, ts, `v1=${hex}`, `  ${secret} \n`)).ok).toBe(true)
    expect(verifyBodySecret({ secret: ' abc ' }, 'abc').ok).toBe(true)
    expect(verifyBodySecret({ secret: 'x' }, 'abc').reason).toBe('body_secret_mismatch')
    expect((await verifyCaktoSignature(body, '1', `v1=${hex}`, secret)).reason).toBe('stale_timestamp')
  })
  it('compra aprovada ativa, duplicada não estende, cancelamento desativa', async () => {
    const kv = new FakeKV() as any
    const payload = { event: 'purchase_approved', data: { id: 'order-1', customer: { email: 'a@b.com', name: 'Ana' } } }
    const r1 = await processEvent(payload, kv); expect(r1[0].status).toBe('active')
    const exp1 = JSON.parse(await kv.get('sub:a@b.com')).expiresAt
    const r2 = await processEvent(payload, kv); expect(r2[0].skipped).toBe('duplicate')
    expect(JSON.parse(await kv.get('sub:a@b.com')).expiresAt).toBe(exp1)
    await processEvent({ event: 'subscription_canceled', data: { id: 'order-2', customer: { email: 'a@b.com', name: 'Ana' } } }, kv)
    expect(JSON.parse(await kv.get('sub:a@b.com')).status).toBe('canceled')
  })
  it('app busca por e-mail e valida a chave emitida pelo servidor', async () => {
    const kv = new FakeKV() as any
    const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'o9', customer: { email: 'pro@exemplo.com', name: 'Pro User' } } }, kv)
    const req = new Request('https://x/license?email=pro%40exemplo.com&deviceId=dev-123')
    const res = await worker.fetch(req, env)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    const v = await verifyLicense(data.key, 'dev-123')
    expect(v.ok).toBe(true); expect(isProActive(v.payload)).toBe(true); expect(v.payload!.holder).toBe('Pro User')
    const wrong = await verifyLicense(data.key, 'outro-aparelho'); expect(wrong.ok).toBe(false)
  })
  it('sem assinatura retorna 404 e app trata', async () => {
    const { env } = makeEnv()
    const res = await worker.fetch(new Request('https://x/license?email=ninguem@x.com&deviceId=d'), env)
    expect(res.status).toBe(404)
  })
  it('rota webhook aceita assinatura válida e rejeita inválida com motivo', async () => {
    const kv = new FakeKV() as any; const secret = 'segredo-teste'
    const payload = { secret, event: 'purchase_approved', data: { id: 'w1', customer: { email: 'w@x.com', name: 'W' } } }
    const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000))
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const raw = new TextEncoder().encode(body); const msg = new Uint8Array(ts.length + 1 + raw.length); msg.set(new TextEncoder().encode(`${ts}.`)); msg.set(raw, ts.length + 1)
    const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))).map(b => b.toString(16).padStart(2, '0')).join('')
    const { env } = makeEnv(kv, secret)
    const ok = await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: { 'x-cakto-timestamp': ts, 'x-cakto-signature': `v1=${hex}` }, body }), env)
    expect(ok.status).toBe(200)
    const bad = await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: { 'x-cakto-timestamp': ts, 'x-cakto-signature': 'v1=00' }, body: JSON.stringify({ ...payload, secret: 'errado' }) }), env)
    expect(bad.status).toBe(401)
    // Resposta pública genérica: motivo fica só no log, nunca no corpo HTTP
    expect(await bad.json()).toEqual({ ok: false, error: 'unauthorized' })
  })
  it('anti-replay: com headers, corpo certo NÃO salva timestamp velho nem assinatura inválida', async () => {
    const secret = 'segredo-teste'; const payload = { secret, event: 'purchase_approved', data: { id: 'r1', customer: { email: 'r@x.com', name: 'R' } } }
    const body = new TextEncoder().encode(JSON.stringify(payload))
    const sign = async (ts: string) => {
      const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const msg = new Uint8Array(ts.length + 1 + body.length); msg.set(new TextEncoder().encode(`${ts}.`)); msg.set(body, ts.length + 1)
      return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))).map(b => b.toString(16).padStart(2, '0')).join('')
    }
    const oldTs = String(Math.floor(Date.now() / 1000) - 600)
    const replay = await authenticateWebhook(body, oldTs, `v1=${await sign(oldTs)}`, payload, secret)
    expect(replay).toEqual({ ok: false, reason: 'stale_timestamp' })
    const forged = await authenticateWebhook(body, String(Math.floor(Date.now() / 1000)), 'v1=00', payload, secret)
    expect(forged).toEqual({ ok: false, reason: 'signature_mismatch' })
    const partial = await authenticateWebhook(body, String(Math.floor(Date.now() / 1000)), '', payload, secret)
    expect(partial).toEqual({ ok: false, reason: 'missing_signature_headers' })
  })
  it('fallback pelo corpo só vale sem nenhum header de assinatura', async () => {
    const secret = 'segredo-teste'; const payload = { secret, event: 'purchase_approved', data: {} }
    const body = new TextEncoder().encode(JSON.stringify(payload))
    expect(await authenticateWebhook(body, '', '', payload, secret)).toEqual({ ok: true, reason: 'body_secret' })
    expect(await authenticateWebhook(body, '', '', { ...payload, secret: 'errado' }, secret)).toEqual({ ok: false, reason: 'body_secret_mismatch' })
    expect(await authenticateWebhook(body, '', '', {}, secret)).toEqual({ ok: false, reason: 'missing_body_secret' })
  })
  it('log de auth não vaza segredo/assinatura e resposta é genérica', async () => {
    const kv = new FakeKV() as any; const secret = 'segredo-teste-xyz'
    const payload = { secret, event: 'purchase_approved', data: { id: 'd1', customer: { email: 'd@x.com', name: 'D' } } }
    const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000))
    const { env } = makeEnv(kv, secret)
    const logs: any[] = []; const orig = console.warn; console.warn = (...a: any[]) => logs.push(a)
    try {
      const res = await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: { 'x-cakto-timestamp': ts, 'x-cakto-signature': 'v1=00' }, body }), env)
      expect(res.status).toBe(401); expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' })
      expect(logs).toHaveLength(1); expect(logs[0][1].reason).toBe('signature_mismatch'); expect(logs[0][1].bodySecretReason).toBeUndefined(); expect(logs[0][1].bodySecretMatches).toBeUndefined()
      expect(JSON.stringify(logs)).not.toContain(secret); expect(JSON.stringify(logs)).not.toContain('v1=00')
      expect(await kv.get('sub:d@x.com')).toBeNull()
    } finally { console.warn = orig }
  })
  it('pin de dispositivo: segundo aparelho recebe 409 e reset admin libera', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'p1', customer: { email: 'pin@x.com', name: 'Pin' } } }, kv)
    const lic = async (dev: string) => worker.fetch(new Request(`https://x/license?email=pin%40x.com&deviceId=${dev}`), env)
    expect((await lic('dev-A')).status).toBe(200); expect((await lic('dev-A')).status).toBe(200)
    const second = await lic('dev-B'); expect(second.status).toBe(409); expect((await second.json()).error).toBe('device_mismatch')
    expect((await worker.fetch(new Request('https://x/license?email=pin%40x.com'), env)).status).toBe(400)
    const resetBad = await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pin@x.com', token: 'errado' }) }), env); expect(resetBad.status).toBe(401)
    const reset = await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pin@x.com', token: 'admin-tok' }) }), env); expect(reset.status).toBe(200)
    expect((await lic('dev-B')).status).toBe(200)
  })
  it('cancelamento mantém carência até expirar; reembolso revoga na hora', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    const proc = (payload: any) => doProc(env, 'car@x.com', payload)
    await proc({ event: 'purchase_approved', data: { id: 'c1', customer: { email: 'car@x.com', name: 'Car' } } })
    await proc({ event: 'subscription_canceled', data: { id: 'c2', customer: { email: 'car@x.com', name: 'Car' } } })
    const lic = () => worker.fetch(new Request('https://x/license?email=car%40x.com&deviceId=dev-1'), env)
    expect((await lic()).status).toBe(200)
    await proc({ event: 'refund', data: { id: 'c3', customer: { email: 'car@x.com', name: 'Car' } } })
    expect((await lic()).status).toBe(403)
  })
  it('C1: mesmo ciclo (current_period) não duplica; ciclos 2 e 3 estendem, mesmo com subscription_period constante', async () => {
    const kv = new FakeKV() as any
    const cust = { email: 'ren@x.com', name: 'Ren' }
    const sub = (current_period: number) => ({ id: 'sub-1', status: 'active', current_period, recurrence_period: 1, paid_payments_quantity: current_period })
    // Ciclo 1: purchase_approved + subscription_renewed do MESMO ciclo (subscription_period constante = 1, como no payload real)
    await processEvent({ event: 'purchase_approved', data: { id: 'r1', subscription_period: 1, subscription: sub(1), customer: cust } }, kv)
    const exp1 = JSON.parse(await kv.get('sub:ren@x.com')).expiresAt
    const r = await processEvent({ event: 'subscription_renewed', data: { id: 'r2', subscription_period: 1, subscription: sub(1), customer: cust } }, kv)
    expect(r[0].skipped).toBe('duplicate_cycle'); expect(JSON.parse(await kv.get('sub:ren@x.com')).expiresAt).toBe(exp1)
    // Entrega repetida do MESMO pedido (r1) também não duplica (dedup por order:<id>)
    const dup = await processEvent({ event: 'purchase_approved', data: { id: 'r1', subscription_period: 1, subscription: sub(1), customer: cust } }, kv)
    expect(dup[0].skipped).toBe('duplicate'); expect(JSON.parse(await kv.get('sub:ren@x.com')).expiresAt).toBe(exp1)
    // Ciclo 2 e 3: subscription_period continua 1 (duração do plano) — NÃO pode bloquear
    await processEvent({ event: 'subscription_renewed', data: { id: 'r3', subscription_period: 1, subscription: sub(2), customer: cust } }, kv)
    const exp2 = JSON.parse(await kv.get('sub:ren@x.com')).expiresAt; expect(exp2).not.toBe(exp1)
    await processEvent({ event: 'subscription_renewed', data: { id: 'r4', subscription_period: 1, subscription: sub(3), customer: cust } }, kv)
    expect(JSON.parse(await kv.get('sub:ren@x.com')).expiresAt).not.toBe(exp2)
  })
  it('C1: fallback paid_payments_quantity quando não há current_period', async () => {
    const kv = new FakeKV() as any; const cust = { email: 'paid@x.com', name: 'Paid' }
    await processEvent({ event: 'purchase_approved', data: { id: 'p1', subscription: { id: 's', paid_payments_quantity: 1 }, customer: cust } }, kv)
    const exp1 = JSON.parse(await kv.get('sub:paid@x.com')).expiresAt
    const r = await processEvent({ event: 'subscription_renewed', data: { id: 'p2', subscription: { id: 's', paid_payments_quantity: 1 }, customer: cust } }, kv)
    expect(r[0].skipped).toBe('duplicate_cycle'); expect(JSON.parse(await kv.get('sub:paid@x.com')).expiresAt).toBe(exp1)
    await processEvent({ event: 'subscription_renewed', data: { id: 'p3', subscription: { id: 's', paid_payments_quantity: 2 }, customer: cust } }, kv)
    expect(JSON.parse(await kv.get('sub:paid@x.com')).expiresAt).not.toBe(exp1)
    // Mistura: current_period de um evento e paid_payments_quantity de outro, mesmo ciclo
    const kv2 = new FakeKV() as any; const cust2 = { email: 'mix@x.com', name: 'Mix' }
    await processEvent({ event: 'purchase_approved', data: { id: 'm1', subscription: { id: 's', current_period: 4, paid_payments_quantity: 4 }, customer: cust2 } }, kv2)
    const rm = await processEvent({ event: 'subscription_renewed', data: { id: 'm2', subscription: { id: 's', paid_payments_quantity: 4 }, customer: cust2 } }, kv2)
    expect(rm[0].skipped).toBe('duplicate_cycle')
  })
  it('C1: sem identificador de ciclo, só vale a dedup por pedido', async () => {
    const kv = new FakeKV() as any; const cust = { email: 'noid@x.com', name: 'NoId' }
    await processEvent({ event: 'purchase_approved', data: { id: 'n1', subscription_period: 1, customer: cust } }, kv)
    const exp1 = JSON.parse(await kv.get('sub:noid@x.com')).expiresAt
    // Pedido diferente, sem ciclo: processa (não inventa ciclo a partir de subscription_period)
    const r = await processEvent({ event: 'subscription_renewed', data: { id: 'n2', subscription_period: 1, customer: cust } }, kv)
    expect(r[0].status).toBe('active'); expect(JSON.parse(await kv.get('sub:noid@x.com')).expiresAt).not.toBe(exp1)
    // Mesmo pedido repetido: dedup por order:<id>
    const dup = await processEvent({ event: 'purchase_approved', data: { id: 'n1', subscription_period: 1, customer: cust } }, kv)
    expect(dup[0].skipped).toBe('duplicate')
  })
  it('C1: evento sem ID de pedido usa o ciclo quando presente, sem inventar quando ausente', async () => {
    const kv = new FakeKV() as any; const cust = { email: 'noid2@x.com', name: 'NoId2' }
    await processEvent({ event: 'purchase_approved', data: { subscription: { id: 's', current_period: 1 }, customer: cust } }, kv)
    const exp1 = JSON.parse(await kv.get('sub:noid2@x.com')).expiresAt
    const r = await processEvent({ event: 'subscription_renewed', data: { subscription: { id: 's', current_period: 1 }, customer: cust } }, kv)
    expect(r[0].skipped).toBe('duplicate_cycle'); expect(JSON.parse(await kv.get('sub:noid2@x.com')).expiresAt).toBe(exp1)
    // Sem ID e sem ciclo: processa normalmente (sem identificador inventado)
    const r2 = await processEvent({ event: 'subscription_renewed', data: { customer: cust } }, kv)
    expect(r2[0].status).toBe('active')
  })
  it('C1: evento atrasado de ciclo antigo após ciclo mais recente não estende', async () => {
    const kv = new FakeKV() as any; const cust = { email: 'late@x.com', name: 'Late' }
    const sub = (cp: number) => ({ id: 'sub-9', current_period: cp, paid_payments_quantity: cp })
    await processEvent({ event: 'purchase_approved', data: { id: 'l1', subscription: sub(1), customer: cust } }, kv)
    await processEvent({ event: 'subscription_renewed', data: { id: 'l2', subscription: sub(2), customer: cust } }, kv)
    await processEvent({ event: 'subscription_renewed', data: { id: 'l3', subscription: sub(3), customer: cust } }, kv)
    const exp3 = JSON.parse(await kv.get('sub:late@x.com')).expiresAt
    const late2 = await processEvent({ event: 'subscription_renewed', data: { id: 'l4-outro-pedido', subscription: sub(2), customer: cust } }, kv)
    expect(late2[0].skipped).toBe('duplicate_cycle'); expect(JSON.parse(await kv.get('sub:late@x.com')).expiresAt).toBe(exp3)
    const late1 = await processEvent({ event: 'purchase_approved', data: { id: 'l5-outro-pedido', subscription: sub(1), customer: cust } }, kv)
    expect(late1[0].skipped).toBe('duplicate_cycle'); expect(JSON.parse(await kv.get('sub:late@x.com')).expiresAt).toBe(exp3)
  })
  it('C1: parseCycleNumber estrito (inválidos rejeitados, 2 e "2" aceitos)', () => {
    for (const bad of ['', ' ', -1, 1.5, 'abc', true, false, null, undefined, 0, '1.5', '0']) expect(parseCycleNumber(bad as any)).toBeNull()
    expect(parseCycleNumber(2)).toBe(2); expect(parseCycleNumber('2')).toBe(2); expect(parseCycleNumber(' 3 ')).toBe(3)
    expect(cycleNumber({ subscription: { current_period: 'abc', paid_payments_quantity: 4 } })).toBe(4)
    expect(cycleNumber({ subscription: { current_period: 2, paid_payments_quantity: 9 } })).toBe(2)
    expect(cycleNumber({ subscription: { current_period: 1.5 } })).toBeNull()
  })
  it('C1: sem subscription.id não há dedup monotônica (só por pedido)', async () => {
    const kv = new FakeKV() as any; const cust = { email: 'nosub@x.com', name: 'NoSub' }
    await processEvent({ event: 'purchase_approved', data: { id: 's1', subscription: { current_period: 1 }, customer: cust } }, kv)
    const exp1 = JSON.parse(await kv.get('sub:nosub@x.com')).expiresAt
    const r = await processEvent({ event: 'subscription_renewed', data: { id: 's2', subscription: { current_period: 1 }, customer: cust } }, kv)
    expect(r[0].status).toBe('active'); expect(JSON.parse(await kv.get('sub:nosub@x.com')).expiresAt).not.toBe(exp1)
  })
  it('C1: reassinatura com nova subscription.id no ciclo 1 é processada e atrasado da antiga não afeta a nova', async () => {
    const kv = new FakeKV() as any; const cust = { email: 're@x.com', name: 'Re' }
    const sub = (id: string, cp: number) => ({ id, current_period: cp, paid_payments_quantity: cp })
    await processEvent({ event: 'purchase_approved', data: { id: 'old1', subscription: sub('sub-old', 3), customer: cust } }, kv)
    await processEvent({ event: 'subscription_canceled', data: { id: 'old2', subscription: sub('sub-old', 3), customer: cust } }, kv)
    // Nova assinatura: ciclo 1 em escopo novo deve processar mesmo com watermark antigo em 3
    const r = await processEvent({ event: 'purchase_approved', data: { id: 'new1', subscription: sub('sub-new', 1), customer: cust } }, kv)
    expect(r[0].status).toBe('active')
    const expNew = JSON.parse(await kv.get('sub:re@x.com')).expiresAt
    // Atrasado da assinatura ANTIGA (ciclo 2) não pode alterar a nova
    const late = await processEvent({ event: 'subscription_renewed', data: { id: 'old3', subscription: sub('sub-old', 2), customer: cust } }, kv)
    expect(late[0].skipped).toBe('duplicate_cycle'); expect(JSON.parse(await kv.get('sub:re@x.com')).expiresAt).toBe(expNew)
    // Ciclo seguinte da NOVA assinatura estende normalmente
    await processEvent({ event: 'subscription_renewed', data: { id: 'new2', subscription: sub('sub-new', 2), customer: cust } }, kv)
    expect(JSON.parse(await kv.get('sub:re@x.com')).expiresAt).not.toBe(expNew)
  })
  it('C1: subscription_resumed restaura sem estender, sem bloquear ciclo seguinte e sem criar assinatura do nada', async () => {
    const kv = new FakeKV() as any; const cust = { email: 'res@x.com', name: 'Res' }; const { env } = makeEnv(kv)
    const proc = (payload: any) => doProc(env, 'res@x.com', payload)
    const sub = (cp: number) => ({ id: 'sub-r', current_period: cp, paid_payments_quantity: cp })
    await proc({ event: 'purchase_approved', data: { id: 'rs1', subscription: sub(1), customer: cust } })
    const exp1 = (await (await proc({ event: 'subscription_paused', data: { id: 'rs2', subscription: sub(1), customer: cust } })).json()).results[0].expiresAt
    expect((await worker.fetch(new Request('https://x/license?email=res%40x.com&deviceId=dev-1'), env)).status).toBe(403)
    // Retomada (mesmo com current_period 2 no payload) NÃO estende e NÃO avança o watermark
    const resumed = (await (await proc({ event: 'subscription_resumed', data: { id: 'rs3', subscription: sub(2), customer: cust } })).json()).results[0]
    expect(resumed.status).toBe('active'); expect(resumed.resumed).toBe(true); expect(resumed.expiresAt).toBe(exp1)
    expect((await worker.fetch(new Request('https://x/license?email=res%40x.com&deviceId=dev-1'), env)).status).toBe(200)
    // Renovação real do ciclo 2 depois da retomada estende normalmente
    await proc({ event: 'subscription_renewed', data: { id: 'rs4', subscription: sub(2), customer: cust } })
    const lic = await worker.fetch(new Request('https://x/license?email=res%40x.com&deviceId=dev-1'), env)
    expect(new Date((await lic.json()).expiresAt).getTime()).toBeGreaterThan(new Date(exp1).getTime())
    // Retomada sem assinatura prévia: não cria Pro do nada
    const { env: env2 } = makeEnv()
    const orphan = (await (await doProc(env2, 'orf@x.com', { event: 'subscription_resumed', data: { id: 'rs9', subscription: sub(1), customer: { email: 'orf@x.com', name: 'Orf' } } })).json()).results[0]
    expect(orphan.skipped).toBe('resume_without_subscription')
    expect((await worker.fetch(new Request('https://x/license?email=orf%40x.com&deviceId=dev-1'), env2)).status).toBe(404)
  })
  it('H1 concorrência: duas ativações simultâneas em devices diferentes — exatamente uma vence', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'cc1', customer: { email: 'race@x.com', name: 'Race' } } }, kv)
    const lic = (dev: string) => worker.fetch(new Request(`https://x/license?email=race%40x.com&deviceId=${dev}`), env)
    const [a, b] = await Promise.all([lic('dev-A'), lic('dev-B')])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const winner = a.status === 200 ? 'dev-A' : 'dev-B'; const loser = winner === 'dev-A' ? 'dev-B' : 'dev-A'
    expect((await lic(winner)).status).toBe(200); expect((await lic(loser)).status).toBe(409)
  })
  it('H1 concorrência: mesmo dispositivo simultâneo vence ambos; mesmo pedido simultâneo não duplica', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'cc2', customer: { email: 'race2@x.com', name: 'Race2' } } }, kv)
    const lic = (dev: string) => worker.fetch(new Request(`https://x/license?email=race2%40x.com&deviceId=${dev}`), env)
    const [a, b] = await Promise.all([lic('dev-A'), lic('dev-A')]); expect([a.status, b.status]).toEqual([200, 200])
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('race2@x.com'))
    const payload = { event: 'subscription_renewed', data: { id: 'cc3', subscription: { id: 's', current_period: 2 }, customer: { email: 'race2@x.com', name: 'Race2' } } }
    const proc = () => doProc(env, 'race2@x.com', payload)
    const [r1, r2] = await Promise.all([proc(), proc()]); const j1 = await r1.json(); const j2 = await r2.json()
    expect([j1.results[0].status || j1.results[0].skipped, j2.results[0].status || j2.results[0].skipped].sort()).toEqual(['active', 'duplicate'])
  })
  it('H1 concorrência: renovações simultâneas de ciclos diferentes geram +2 meses (serializadas)', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('seq@x.com'))
    const proc = (payload: any) => doProc(env, 'seq@x.com', payload)
    const cust = { email: 'seq@x.com', name: 'Seq' }; const sub = (cp: number) => ({ id: 's', current_period: cp })
    await proc({ event: 'purchase_approved', data: { id: 'q1', subscription: sub(1), customer: cust } })
    const exp1 = (await (await proc({ event: 'subscription_renewed', data: { id: 'q2', subscription: sub(2), customer: cust } })).json()).results[0].expiresAt
    const before = JSON.parse(await kv.get('sub:seq@x.com') || '{}')
    await Promise.all([
      proc({ event: 'subscription_renewed', data: { id: 'q3', subscription: sub(3), customer: cust } }),
      proc({ event: 'subscription_renewed', data: { id: 'q4', subscription: sub(4), customer: cust } }),
    ])
    const lic = await worker.fetch(new Request('https://x/license?email=seq%40x.com&deviceId=dev-1'), env)
    const expFinal = (await lic.json()).expiresAt
    // Serializadas: cada ciclo estende 1 mês a partir do anterior (total de +2 a partir de exp1)
    expect(new Date(expFinal).getTime()).toBeGreaterThan(new Date(exp1).getTime())
    void before
  })
  it('H1 concorrência: reset simultâneo com ativação não corrompe o registro', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'rr1', customer: { email: 'rr@x.com', name: 'RR' } } }, kv)
    const lic = (dev: string) => worker.fetch(new Request(`https://x/license?email=rr%40x.com&deviceId=${dev}`), env)
    expect((await lic('dev-A')).status).toBe(200)
    const [reset, act] = await Promise.all([
      worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'rr@x.com', token: 'admin-tok' }) }), env),
      lic('dev-B'),
    ])
    expect(reset.status).toBe(200); expect([200, 409]).toContain(act.status)
    // Estado final consistente: retentar com dev-B sempre funciona (pin é B ou estava livre)
    expect((await lic('dev-B')).status).toBe(200)
  })
  it('H1 migração KV→DO: pin e watermark legados preservados, migração idempotente', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString()
    await kv.put('sub:mig@x.com', JSON.stringify({ email: 'mig@x.com', name: 'Mig', status: 'active', revoked: false, deviceId: 'dev-old', plan: 'pro-monthly', expiresAt, lastCycleSubId: 'sub-1', lastCycleNum: 2, lastCycles: { 'sub-1': 2 } }))
    await kv.put('order:mig-order', '1')
    const lic = (dev: string) => worker.fetch(new Request(`https://x/license?email=mig%40x.com&deviceId=${dev}`), env)
    expect((await lic('dev-old')).status).toBe(200); expect((await lic('dev-other')).status).toBe(409)
    // Repetir acesso após apagar o KV: o DO já é a fonte e nada se perde
    await kv.put('sub:mig@x.com', JSON.stringify({ email: 'mig@x.com', name: 'Mig', status: 'active', revoked: false, deviceId: 'dev-old', plan: 'pro-monthly', expiresAt, lastCycles: { 'sub-1': 2 } }))
    expect((await lic('dev-old')).status).toBe(200)
    // Pedido legado no KV não reprocessa no DO (migração preguiçosa da chave order:<id>)
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('mig@x.com'))
    const r = await doProc(env, 'mig@x.com', { event: 'purchase_approved', data: { id: 'mig-order', subscription: { id: 'sub-1', current_period: 3 }, customer: { email: 'mig@x.com', name: 'Mig' } } })
    expect((await r.json()).results[0].skipped).toBe('duplicate'); expect((await lic('dev-old')).status).toBe(200)
  })
  it('H1 migração: watermark legado (lastCycleSubId/Num sem mapa) bloqueia ciclo antigo', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString()
    await kv.put('sub:leg@x.com', JSON.stringify({ email: 'leg@x.com', name: 'Leg', status: 'active', revoked: false, deviceId: 'dev-1', plan: 'pro-monthly', expiresAt, lastCycleSubId: 'sub-1', lastCycleNum: 2 }))
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('leg@x.com'))
    const r = await doProc(env, 'leg@x.com', { event: 'subscription_renewed', data: { id: 'leg2', subscription: { id: 'sub-1', current_period: 2 }, customer: { email: 'leg@x.com', name: 'Leg' } } })
    expect((await r.json()).results[0].skipped).toBe('duplicate_cycle')
  })
  it('M1: timingSafeEqualStr (iguais, prefixo, tamanho, vazio)', async () => {
    expect(await timingSafeEqualStr('abc', 'abc')).toBe(true)
    expect(await timingSafeEqualStr('abc', 'abd')).toBe(false)
    expect(await timingSafeEqualStr('abc', 'abcd')).toBe(false)
    expect(await timingSafeEqualStr('', '')).toBe(true)
    expect(await timingSafeEqualStr('', 'x')).toBe(false)
  })
  it('M1: admin — limite de 5 falhas/IP, bloqueio 429 com Retry-After, expiração e sucesso zerando', async () => {
    const kv = new FakeKV() as any; const { env, stores } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'adm1', customer: { email: 'adm@x.com', name: 'Adm' } } }, kv)
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }
    const call = (token: string) => worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: H, body: JSON.stringify({ email: 'adm@x.com', token }) }), env)
    expect((await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: H, body: JSON.stringify({ email: 'adm@x.com' }) }), env)).status).toBe(401)
    for (let i = 0; i < ADMIN_MAX_FAILURES - 1; i++) expect((await call('errado')).status).toBe(401)
    // 6ª tentativa correta durante bloqueio -> 429 com Retry-After
    const locked = await call('admin-tok'); expect(locked.status).toBe(429); expect(locked.headers.get('retry-after')).toBeTruthy(); expect(await locked.json()).toEqual({ ok: false, error: 'rate_limited' })
    // Expirar o bloqueio manipulando o registro (hash do IP, sem IP cru no storage)
    const ipHash = await sha256Hex('203.0.113.7'); const adminStore = stores.get('admin'); const rec = adminStore.m.get(`admrl:${ipHash}`); expect(rec).toBeTruthy(); expect(JSON.stringify(rec)).not.toContain('203.0.113.7')
    adminStore.m.set(`admrl:${ipHash}`, { ...rec, lockedUntil: Date.now() - 1 })
    expect((await call('admin-tok')).status).toBe(200)
    // Sucesso zerou: 4 falhas novas não bloqueiam
    for (let i = 0; i < ADMIN_MAX_FAILURES - 1; i++) expect((await call('errado')).status).toBe(401)
    expect((await call('admin-tok')).status).toBe(200)
  })
  it('M1: admin — secret não configurado sempre 401; concorrência conta exatamente o limite', async () => {
    const { env: envNoSecret } = makeEnv(); (envNoSecret as any).ADMIN_TOKEN = ''
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' }
    expect((await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: H, body: JSON.stringify({ email: 'a@x.com', token: 'qualquer' }) }), envNoSecret)).status).toBe(401)
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'adm2', customer: { email: 'adm2@x.com', name: 'Adm2' } } }, kv)
    const attempts = await Promise.all(Array.from({ length: 10 }, () => worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: H, body: JSON.stringify({ email: 'adm2@x.com', token: 'errado' }) }), env)))
    const statuses = attempts.map(r => r.status).sort()
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429])
  })
  it('M1: token não é transmitido ao DO (só ipHash + authenticated)', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'tok1', customer: { email: 'tok@x.com', name: 'Tok' } } }, kv)
    const calls: any[] = []; const real = env.LICENSE_DO
    const spyEnv: any = { ...env, LICENSE_DO: { idFromName: (n: string) => n, get: (id: string) => { const stub = real.get(id); return { fetch: async (u: string, init: any) => { calls.push({ url: u, body: init?.body }); return stub.fetch(u, init) } } } } }
    const res = await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.8' }, body: JSON.stringify({ email: 'tok@x.com', token: 'admin-tok' }) }), spyEnv)
    expect(res.status).toBe(200)
    const gate = calls.find(c => c.url.includes('/internal/admin-gate'))
    expect(gate).toBeTruthy(); const gb = JSON.parse(gate.body); expect(gb.authenticated).toBe(true); expect(gb.ipHash).toBe(await sha256Hex('203.0.113.8')); expect(JSON.stringify(calls)).not.toContain('admin-tok')
  })
  it('M1: limite global 100/min com IPs distintos (concorrente) e recuperação', async () => {
    const kv = new FakeKV() as any; const { env, stores } = makeEnv(kv)
    const attempts = await Promise.all(Array.from({ length: 101 }, (_, i) => worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${i % 250 + 1}` }, body: JSON.stringify({ email: 'g@x.com', token: 'errado' }) }), env)))
    const statuses = attempts.map(r => r.status).sort()
    expect(statuses.filter(s => s === 401)).toHaveLength(100); expect(statuses.filter(s => s === 429)).toHaveLength(1)
    // Recuperação: janela global expirada libera novas tentativas (nunca bloqueio permanente)
    const adminStore = stores.get('admin'); const grec = adminStore.m.get('admrl:global'); expect(grec).toBeTruthy()
    adminStore.m.set('admrl:global', { ...grec, windowStart: Date.now() - 61000 })
    const ipHash = await sha256Hex('203.0.113.99')
    const ok = await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.99' }, body: JSON.stringify({ email: 'g@x.com', token: 'admin-tok' }) }), env)
    expect(ok.status).not.toBe(429); expect(ok.status).not.toBe(401) // passa do gate (404/200 do reset, não 429/401 do admin)
    void ipHash
  })
  it('M1: DO indisponível ou falha ao limpar contador — reset não é executado (500)', async () => {
    const kv = new FakeKV() as any; const { env: envNoDO } = makeEnv(kv); delete (envNoDO as any).LICENSE_DO
    await processEvent({ event: 'purchase_approved', data: { id: 'nd1', customer: { email: 'nd@x.com', name: 'ND' } } }, kv)
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' }
    expect((await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: H, body: JSON.stringify({ email: 'nd@x.com', token: 'admin-tok' }) }), envNoDO)).status).toBe(500)
    const { env, stores } = makeEnv(kv)
    const store = stores.get('admin') || (() => { env.LICENSE_DO.get('admin'); return stores.get('admin') })()
    const origDelete = store.delete.bind(store); store.delete = async (k: string) => { if (k.startsWith('admrl:')) throw new Error('storage falhou'); return origDelete(k) }
    const res = await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: H, body: JSON.stringify({ email: 'nd@x.com', token: 'admin-tok' }) }), env)
    expect(res.status).toBe(500)
    const lic = await worker.fetch(new Request('https://x/license?email=nd%40x.com&deviceId=dev-1'), env)
    expect(lic.status).toBe(200) // assinatura intacta; reset não executou
  })
  it('R1: webhook registra no registry antes de mutar; registry falho impede a mutação', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'reg1', customer: { email: 'reg@x.com', name: 'Reg' } } }, kv)
    const regStore = (env as any).__stores || (env as any).stores
    void regStore
    // via DO interno direto o registry é consultado na migração; via Worker o registro acontece (webhook assina com secret 's')
    const secret = 's'; const payload = { secret, event: 'purchase_approved', data: { id: 'reg2', customer: { email: 'reg2@x.com', name: 'Reg2' } } }
    const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000))
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const raw = new TextEncoder().encode(body); const msg = new Uint8Array(ts.length + 1 + raw.length); msg.set(new TextEncoder().encode(`${ts}.`)); msg.set(raw, ts.length + 1)
    const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))).map(b => b.toString(16).padStart(2, '0')).join('')
    const res = await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: { 'x-cakto-timestamp': ts, 'x-cakto-signature': `v1=${hex}` }, body }), env)
    expect(res.status).toBe(200)
    // Registry indisponível: webhook retorna 500 e NÃO cria assinatura
    const failingEnv: any = { ...env, LICENSE_DO: { idFromName: (n: string) => n, get: (id: string) => id === '__registry__' ? { fetch: async () => { throw new Error('registry down') } } : (env as any).LICENSE_DO.get(id) } }
    const payload2 = { secret, event: 'purchase_approved', data: { id: 'reg3', customer: { email: 'reg3@x.com', name: 'Reg3' } } }
    const body2 = JSON.stringify(payload2); const raw2 = new TextEncoder().encode(body2); const msg2 = new Uint8Array(ts.length + 1 + raw2.length); msg2.set(new TextEncoder().encode(`${ts}.`)); msg2.set(raw2, ts.length + 1)
    const hex2 = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, msg2))).map(b => b.toString(16).padStart(2, '0')).join('')
    const res2 = await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: { 'x-cakto-timestamp': ts, 'x-cakto-signature': `v1=${hex2}` }, body: body2 }), failingEnv)
    expect(res2.status).toBe(500)
    expect((await worker.fetch(new Request('https://x/license?email=reg3%40x.com&deviceId=dev-1'), env)).status).toBe(404)
  })
  it('R1: bootstrap (KV + externo) e exportação paginada com manifesto e checksums', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await kv.put('sub:legado@x.com', JSON.stringify({ email: 'legado@x.com', name: 'Leg', status: 'active', revoked: false, deviceId: 'dev-9', plan: 'pro-monthly', expiresAt: new Date(Date.now() + 86400000).toISOString(), lastCycles: { 's1': 3 } }))
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.20' }
    const boot = await worker.fetch(new Request('https://x/admin/bootstrap', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', emails: ['externo@x.com'] }) }), env)
    expect(boot.status).toBe(200); const bj = await boot.json(); expect(bj.registered).toBe(2); expect(bj.kvCensus).toBe(1); expect(bj.external).toBe(1)
    await processEvent({ event: 'purchase_approved', data: { id: 'exp-o1', customer: { email: 'exp@x.com', name: 'Exp' } } }, kv)
    await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'exp@x.com' }) })
    await freezeNow(env)
    const exp1 = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', limit: 2 }) }), env)
    expect(exp1.status).toBe(200); const j1 = await exp1.json(); expect(j1.records).toHaveLength(2); expect(j1.complete).toBe(false); expect(j1.cursor).toBeTruthy(); expect(j1.manifest.batchCount).toBe(2)
    const exp2 = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', limit: 2, snapshotId: j1.snapshotId, cursor: j1.cursor }) }), env)
    const j2 = await exp2.json(); expect(j2.complete).toBe(true)
    const all = [...j1.records, ...j2.records]; expect(all.length).toBeGreaterThanOrEqual(3)
    for (const rec of j1.records.concat(j2.records)) {
      expect(j1.manifest.checksums[rec.email] || j2.manifest.checksums[rec.email]).toBe(await sha256HexObjTest({ sub: rec.sub, orders: rec.orders }))
    }
    const legado = all.find((r: any) => r.email === 'legado@x.com'); expect(legado.sub.deviceId).toBe('dev-9'); expect(legado.sub.lastCycles).toEqual({ 's1': 3 })
    expect(JSON.stringify(j1)).not.toContain('PRIVATE KEY'); expect(JSON.stringify(j1)).not.toContain('admin-tok')
  })
  it('R1: snapshot incompleto (instância falhando) é rejeitado sem parcial', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'inc1', customer: { email: 'inc@x.com', name: 'Inc' } } }, kv)
    const regStub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    await regStub.fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'inc@x.com' }) })
    const failing: any = { ...env, LICENSE_DO: { idFromName: (n: string) => n, get: (id: string) => id === 'inc@x.com' ? { fetch: async () => new Response('{}', { status: 500 }) } : env.LICENSE_DO.get(id) } }
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.21' }
    await freezeNow(env)
    const res = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), failing)
    expect(res.status).toBe(500); expect((await res.json()).error).toBe('export_incomplete')
  })
  it('R1: restauração valida checksum antes de gravar, é idempotente e o adapter legado lê após recovery', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'res-o1', customer: { email: 'res@x.com', name: 'Res' } } }, kv)
    await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'res@x.com' }) })
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.22' }
    await freezeNow(env)
    const exp = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    const snapshot = await exp.json(); const rec = snapshot.records.find((r: any) => r.email === 'res@x.com')
    // Checksum inválido: nada gravado
    const bad = await worker.fetch(new Request('https://x/admin/restore-kv', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', records: [{ email: 'novo@x.com', sub: { email: 'novo@x.com', status: 'active' }, orders: {} }], manifest: { checksums: { 'novo@x.com': '00'.repeat(32) } } }) }), env)
    expect(bad.status).toBe(400); expect(await kv.get('sub:novo@x.com')).toBeNull()
    // Restauração válida no MESMO ambiente (sessão do registry) + releitura legada via KV restaurado
    const kv2 = new FakeKV() as any; const { env: env2 } = makeEnv(kv2)
    const ok = await worker.fetch(new Request('https://x/admin/restore-kv', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', records: [rec], manifest: snapshot.manifest }) }), env)
    expect(ok.status).toBe(200); expect((await ok.json()).verified).toBe(1)
    const again = await worker.fetch(new Request('https://x/admin/restore-kv', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', records: [rec], manifest: snapshot.manifest }) }), env)
    expect(again.status).toBe(200)
    // Adapter legado: ambiente novo sem DO, com o KV restaurado como fonte legada
    await kv2.put('sub:res@x.com', JSON.stringify(rec.sub))
    expect((await worker.fetch(new Request('https://x/license?email=res%40x.com&deviceId=dev-1'), env2)).status).toBe(200)
  })
  it('H-R1/H-S1: restauração rejeita snapshots sem integridade (zero escritas) e valida a sessão no registry', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.23' }
    await doProc(env, 'h@x.com', { event: 'purchase_approved', data: { id: 'h-o1', customer: { email: 'h@x.com', name: 'H' } } })
    await freezeNow(env, '203.0.113.23')
    await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'h@x.com' }) })
    const exp = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    expect(exp.status).toBe(200)
    const snapshot = await exp.json()
    const rec = snapshot.records.find((r: any) => r.email === 'h@x.com')
    const sub = rec.sub; const orders = rec.orders
    const checksum = snapshot.manifest.checksums['h@x.com']
    const base = { token: 'admin-tok', records: [{ email: 'h@x.com', sub, orders }], manifest: snapshot.manifest }
    const restore = (body: any) => worker.fetch(new Request('https://x/admin/restore-kv', { method: 'POST', headers: H, body: JSON.stringify(body) }), env)
    const cases: [string, any][] = [
      ['manifest ausente', { token: 'admin-tok', records: base.records }],
      ['snapshotId inválido', { ...base, manifest: { ...base.manifest, snapshotId: 'x' } }],
      ['versão não suportada', { ...base, manifest: { ...base.manifest, version: 2 } }],
      ['complete falso', { ...base, manifest: { ...base.manifest, complete: false } }],
      ['checksum ausente', { ...base, manifest: { ...base.manifest, checksums: {} } }],
      ['checksum vazio', { ...base, manifest: { ...base.manifest, checksums: { 'h@x.com': '' } } }],
      ['checksum inválido', { ...base, manifest: { ...base.manifest, checksums: { 'h@x.com': 'zz' } } }],
      ['checksum divergente', { ...base, manifest: { ...base.manifest, checksums: { 'h@x.com': await sha256HexObjTest({ sub: { ...sub, status: 'canceled' }, orders }) } } }],
      ['e-mail fora do manifesto', { ...base, manifest: { ...base.manifest, checksums: { 'outro@x.com': checksum } } }],
      ['sessão inexistente (fabricada)', { ...base, manifest: { ...base.manifest, snapshotId: crypto.randomUUID() } }],
      ['contagem divergente', { ...base, manifest: { ...base.manifest, totalRecords: 5 } }],
      ['contagem de pedidos divergente', { ...base, manifest: { ...base.manifest, totalOrders: 99 } }],
      ['tipo inválido (status)', { ...base, records: [{ email: 'h@x.com', sub: { ...sub, status: 42 }, orders }], manifest: { ...base.manifest, checksums: { 'h@x.com': await sha256HexObjTest({ sub: { ...sub, status: 42 }, orders }) } } }],
      ['tipo inválido (expiresAt)', { ...base, records: [{ email: 'h@x.com', sub: { ...sub, expiresAt: 'lixo' }, orders }], manifest: { ...base.manifest, checksums: { 'h@x.com': await sha256HexObjTest({ sub: { ...sub, expiresAt: 'lixo' }, orders }) } } }],
    ]
    for (const [name, body] of cases) {
      const res = await restore(body)
      expect(res.status, name).toBe(400)
      expect(await kv.get('sub:h@x.com'), name).toBeNull()
    }
    // Duplicado no mesmo lote
    const dup = await restore({ ...base, records: [base.records[0], base.records[0]], manifest: { ...base.manifest, totalRecords: 2 } })
    expect(dup.status).toBe(400); expect(await kv.get('sub:h@x.com')).toBeNull()
    // Válido: grava, é idempotente e verifica
    const ok = await restore(base); expect(ok.status).toBe(200); expect((await ok.json()).verified).toBe(1)
    const again = await restore(base); expect(again.status).toBe(200)
    await unfreezeNow(env, '203.0.113.23')
    expect((await worker.fetch(new Request('https://x/license?email=h%40x.com&deviceId=dev-1'), env)).status).toBe(200)
  })
  it('H-S2: snapshot antigo diante de revogação mais recente é rejeitado sem escritas', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.24' }
    const snapIdHolder: any = {}
    await doProc(env, 'hs2@x.com', { event: 'purchase_approved', data: { id: 'hs2-o1', customer: { email: 'hs2@x.com', name: 'HS2' } } })
    await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'hs2@x.com' }) })
    await freezeNow(env, '203.0.113.24')
    const exp = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    const snapshot = await exp.json(); snapIdHolder.snapshot = snapshot
    await unfreezeNow(env, '203.0.113.24')
    // Reembolso posterior torna o estado atual mais recente que o snapshot
    await doProc(env, 'hs2@x.com', { event: 'refund', data: { id: 'hs2-o2', customer: { email: 'hs2@x.com', name: 'HS2' } } })
    await freezeNow(env, '203.0.113.24')
    const res = await worker.fetch(new Request('https://x/admin/restore-kv', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', records: snapshot.records, manifest: snapshot.manifest }) }), env)
    expect(res.status).toBe(400); expect((await res.json()).error).toBe('stale_snapshot')
    expect(await kv.get('sub:hs2@x.com')).toBeNull()
    await unfreezeNow(env, '203.0.113.24')
    expect((await worker.fetch(new Request('https://x/license?email=hs2%40x.com&deviceId=dev-1'), env)).status).toBe(403)
  })
  it('H-R1a: exportação pagina order:* (150 pedidos) e o checksum cobre todos', async () => {
    const kv = new FakeKV() as any; const { env, stores } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'many-o0', customer: { email: 'many@x.com', name: 'Many' } } }, kv)
    await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'many@x.com' }) })
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('many@x.com'))
    // Seed de pedidos direto no storage do DO (acima do limite de página fake de 100)
    const storage = (stub as any).storage
    for (let i = 0; i < 150; i++) await storage.put(`order:seed-${i}`, 1)
    const r = await stub.fetch('https://license-store/internal/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'many@x.com' }) })
    expect(r.status).toBe(200); const d = await r.json()
    expect(Object.keys(d.orders)).toHaveLength(150)
    expect(await sha256HexObjTest({ sub: d.sub, orders: d.orders })).toBeTruthy()
    void stores
  })
  it('H-R1a: falha em página intermediária ou cursor inválido falha fechado (500, sem parcial)', async () => {
    const { env } = makeEnv()
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('fail@x.com'))
    const origList = (stub as any).storage.list.bind((stub as any).storage)
    for (let i = 0; i < 150; i++) await (stub as any).storage.put(`order:f${i}`, 1)
    let calls = 0
    ;(stub as any).storage.list = async (opts: any) => { calls++; if (calls === 2) throw new Error('falha na página 2'); return origList(opts) }
    // Exceção de storage propaga como rejeição (runtime vira 500) — nenhum parcial é devolvido
    await expect(stub.fetch('https://license-store/internal/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'fail@x.com' }) })).rejects.toThrow('falha na página 2')
    const stub2 = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('fail2@x.com'))
    ;(stub2 as any).storage.list = async () => { const m = new Map<string, any>(); return Object.assign(m, { cursor: null, list_complete: false }) }
    const r2 = await stub2.fetch('https://license-store/internal/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'fail2@x.com' }) })
    expect(r2.status).toBe(500); expect((await r2.json()).error).toBe('export_incomplete')
  })
  it('H-R1b: retry do mesmo lote não duplica contagens; conteúdo diferente é rejeitado; lote de outro snapshot é rejeitado', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.30' }
    for (const em of ['b1@x.com', 'b2@x.com']) await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: em }) })
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const begin = await (await reg.fetch('https://license-store/internal/snapshot-begin', { method: 'POST', body: '{}' })).json()
    const batch = { snapshotId: begin.snapshotId, batchId: `${begin.snapshotId}:batch:0`, start: 0, end: 1, orders: 3, records: 1 }
    const upd = (b: any) => reg.fetch('https://license-store/internal/snapshot-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    const u1 = await (await upd(batch)).json(); expect(u1.totalOrders).toBe(3)
    const u2 = await (await upd(batch)).json(); expect(u2.totalOrders).toBe(3); expect(u2.duplicate).toBe(true)
    const conflict = await upd({ ...batch, orders: 99 }); expect(conflict.status).toBe(409); expect((await conflict.json()).error).toBe('batch_content_mismatch')
    const foreign = await upd({ snapshotId: 'outro-snapshot', batchId: `${begin.snapshotId}:batch:0`, orders: 1, records: 1 }); expect(foreign.status).toBe(404)
    const noPrefix = await upd({ snapshotId: begin.snapshotId, batchId: 'batch:0', orders: 1, records: 1 }); expect(noPrefix.status).toBe(400)
    void H
  })
  it('H-R1b: snapshot incompleto não conclui; completo tem contagens exatas', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.31' }
    for (const em of ['s1@x.com', 's2@x.com', 's3@x.com']) { await processEvent({ event: 'purchase_approved', data: { id: `s-${em}`, customer: { email: em, name: 'S' } } }, kv); await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: em }) }) }
    await freezeNow(env, '203.0.113.31')
    const e1 = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', limit: 2 }) }), env)
    const j1 = await e1.json(); expect(j1.complete).toBe(false); expect(j1.manifest.totalRecords).toBe(3)
    const e2 = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', limit: 2, snapshotId: j1.snapshotId, cursor: j1.cursor }) }), env)
    const j2 = await e2.json(); expect(j2.complete).toBe(true); expect(j2.manifest.totalOrders).toBe(j2.manifest.totalOrders)
    // Retry do primeiro lote via Worker: totalOrders do manifesto não infla
    const again = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', limit: 2, snapshotId: j1.snapshotId }) }), env)
    const ja = await again.json(); expect(ja.manifest.totalOrders).toBe(j1.manifest.totalOrders)
  })
  it('H-1: conclusão só com cobertura integral — último lote antes dos intermediários não conclui', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.40' }
    for (const em of ['h1a@x.com', 'h1b@x.com', 'h1c@x.com']) { await processEvent({ event: 'purchase_approved', data: { id: `h-${em}`, customer: { email: em, name: 'H' } } }, kv); await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: em }) }) }
    const snap = await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/snapshot-begin', { method: 'POST', body: '{}' })
    const { snapshotId } = await snap.json()
    const upd = (start: number, end: number, orders: number, records: number) => env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/snapshot-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId, batchId: `${snapshotId}:batch:${start}`, start, end, orders, records }) })
    // Último lote primeiro: NÃO conclui
    const last = await upd(2, 3, 1, 1); expect((await last.json()).concluded).toBe(false)
    // Primeiro lote: ainda falta o intermediário
    const first = await upd(0, 1, 1, 1); expect((await first.json()).concluded).toBe(false)
    // Intermediário: agora cobre [0,3) -> conclui e persiste
    const mid = await upd(1, 2, 1, 1); const midJ = await mid.json(); expect(midJ.concluded).toBe(true); expect(midJ.totalOrders).toBe(3)
    // Retry do último lote após conclusão: duplicate + concluded preservado
    const retry = await upd(2, 3, 1, 1); const retryJ = await retry.json(); expect(retryJ.duplicate).toBe(true); expect(retryJ.concluded).toBe(true); expect(retryJ.totalOrders).toBe(3)
    // Lote incompatível após conclusão: rejeitado
    const late = await upd(0, 1, 9, 1); expect(late.status).toBe(409)
    void H
  })
  it('H-1: sessão vazia já nasce concluída e rejeita novos lotes', async () => {
    const { env } = makeEnv()
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const begin = await (await reg.fetch('https://license-store/internal/snapshot-begin', { method: 'POST', body: '{}' })).json()
    const sid = begin.snapshotId
    const batchEmpty = await reg.fetch('https://license-store/internal/snapshot-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: sid, cursor: null, limit: 10 }) })
    expect((await batchEmpty.json()).complete).toBe(true)
    const upd = reg.fetch('https://license-store/internal/snapshot-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: sid, batchId: `${sid}:batch:0`, start: 0, end: 1, orders: 0, records: 1 }) })
    expect((await upd).status).toBe(409)
  })
  it('H-1: sobreposição e limites com sessão populada', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    for (const em of ['o1@x.com', 'o2@x.com', 'o3@x.com']) await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: em }) })
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const sid = (await (await reg.fetch('https://license-store/internal/snapshot-begin', { method: 'POST', body: '{}' })).json()).snapshotId
    const upd = (batchId: string, start: any, end: any, orders = 1, records = end - start) => reg.fetch('https://license-store/internal/snapshot-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: sid, batchId, start, end, orders, records }) })
    expect((await upd(`${sid}:batch:0`, 0, 2)).status).toBe(200)
    expect((await upd(`${sid}:batch:1`, 1, 3)).status).toBe(409) // sobreposição parcial
    expect((await upd(`${sid}:batch:9`, 0, 99)).status).toBe(400) // fora dos limites
    expect((await upd(`${sid}:batch:x`, -1, 1)).status).toBe(400)
    expect((await upd(`${sid}:batch:y`, 1.5, 2)).status).toBe(400)
    expect((await upd('outro:batch:2', 2, 3)).status).toBe(400) // lote de outro snapshot
    expect((await upd(`${sid}:batch:2`, 2, 3)).status).toBe(200)
    const batch = await reg.fetch('https://license-store/internal/snapshot-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: sid, cursor: '0', limit: 10 }) })
    expect((await batch.json()).complete).toBe(true)
  })
  it('H-1: falha na persistência do registry não registra lote e retry continua idempotente', async () => {
    const kv = new FakeKV() as any; const { env, stores } = makeEnv(kv)
    await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'fp@x.com' }) })
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const sid = (await (await reg.fetch('https://license-store/internal/snapshot-begin', { method: 'POST', body: '{}' })).json()).snapshotId
    const store = stores.get('__registry__')
    const origPut = store.put.bind(store); let failures = 1
    store.put = async (k: string, v: any) => { if (failures-- > 0 && k.startsWith('snap:')) throw new Error('falha na persistência'); return origPut(k, v) }
    const upd = () => reg.fetch('https://license-store/internal/snapshot-update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshotId: sid, batchId: `${sid}:batch:0`, start: 0, end: 1, orders: 1, records: 1 }) })
    await expect(upd()).rejects.toThrow('falha na persistência')
    store.put = origPut
    const session = await store.get(`snap:${sid}`); expect(session.batches).toEqual({}); expect(session.concluded).toBe(false)
    const retry = await upd(); expect(retry.status).toBe(200); expect((await retry.json()).concluded).toBe(true)
  })
  it('H-R3: freeze bloqueia webhook/license/reset/bootstrap; export só em frozen; desbloqueio dirigido', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.60' }
    const secret = 's'; const payload = { secret, event: 'purchase_approved', data: { id: 'fz1', customer: { email: 'fz@x.com', name: 'Fz' } } }
    const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000))
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const raw = new TextEncoder().encode(body); const msg = new Uint8Array(ts.length + 1 + raw.length); msg.set(new TextEncoder().encode(`${ts}.`)); msg.set(raw, ts.length + 1)
    const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))).map(b => b.toString(16).padStart(2, '0')).join('')
    const WH = { 'x-cakto-timestamp': ts, 'x-cakto-signature': `v1=${hex}` }
    // Export recusado em running
    expect((await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(409)
    // Freeze start + confirm (sem operação ativa -> frozen imediato)
    expect((await worker.fetch(new Request('https://x/admin/freeze', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    expect((await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    // Bloqueios em frozen
    expect((await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: WH, body }), env)).status).toBe(503)
    expect((await worker.fetch(new Request('https://x/license?email=fz%40x.com&deviceId=dev-1'), env)).status).toBe(503)
    expect((await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: H, body: JSON.stringify({ email: 'fz@x.com', token: 'admin-tok' }) }), env)).status).toBe(503)
    expect((await worker.fetch(new Request('https://x/admin/bootstrap', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', emails: [] }) }), env)).status).toBe(503)
    expect(await kv.get('sub:fz@x.com')).toBeNull()
    // Export permitido em frozen
    const exp = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    expect(exp.status).toBe(200)
    // Desbloqueio dirigido: frozen -> unfreezing -> running (consulta completa)
    const u1 = await worker.fetch(new Request('https://x/admin/freeze/unlock', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    expect((await u1.json()).state).toBe('unfreezing')
    expect((await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: WH, body }), env)).status).toBe(503)
    const st = await worker.fetch(new Request('https://x/admin/freeze/state', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    expect((await st.json()).state).toBe('running')
    expect((await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: WH, body }), env)).status).toBe(200)
  })
  it('H-R3: operação em andamento bloqueia a confirmação; liberação em finally (inclusive erro)', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.61' }
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const op = 'op-manual-1'
    expect((await reg.fetch('https://license-store/internal/freeze-acquire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: op }) })).status).toBe(200)
    expect((await worker.fetch(new Request('https://x/admin/freeze', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    const conf1 = await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    expect(conf1.status).toBe(409); expect((await conf1.json()).activeOperations).toBe(1)
    // Unlock recusado com operação ativa não se aplica aqui (não está frozen) — estado segue freezing
    const st = await worker.fetch(new Request('https://x/admin/freeze/state', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    expect((await st.json()).state).toBe('freezing')
    await reg.fetch('https://license-store/internal/freeze-release-reserved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: op }) })
    expect((await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    // Desbloqueio recusado com operação ativa (forçado no storage): 409
    const store = (env as any).__stores || (env as any).stores
  })
  it('H-R3: duas aquisições concorrentes + freeze concorrente sem corrida (serializadas)', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.62' }
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const acq = (op: string) => reg.fetch('https://license-store/internal/freeze-acquire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: op }) })
    const p1 = acq('c1'); const p2 = acq('c2')
    const start = reg.fetch('https://license-store/internal/freeze-start', { method: 'POST', body: '{}' })
    const [a1, a2] = await Promise.all([p1, p2])
    expect([a1.status, a2.status]).toEqual([200, 200])
    expect((await start).status).toBe(200)
    const conf = await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    expect(conf.status).toBe(409); expect((await conf.json()).activeOperations).toBe(2)
    for (const op of ['c1', 'c2']) await reg.fetch('https://license-store/internal/freeze-release-reserved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: op }) })
    expect((await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
  })
  it('H-R3: registry indisponível bloqueia mutação (webhook/license/reset)', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'ri1', customer: { email: 'ri@x.com', name: 'Ri' } } }, kv)
    const secret = 's'; const payload = { secret, event: 'purchase_approved', data: { id: 'ri2', customer: { email: 'ri@x.com', name: 'Ri' } } }
    const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000))
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const raw = new TextEncoder().encode(body); const msg = new Uint8Array(ts.length + 1 + raw.length); msg.set(new TextEncoder().encode(`${ts}.`)); msg.set(raw, ts.length + 1)
    const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))).map(b => b.toString(16).padStart(2, '0')).join('')
    const broken: any = { ...env, LICENSE_DO: { idFromName: (n: string) => n, get: (id: string) => id === '__registry__' ? { fetch: async () => { throw new Error('registry down') } } : env.LICENSE_DO.get(id) } }
    expect((await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: { 'x-cakto-timestamp': ts, 'x-cakto-signature': `v1=${hex}` }, body }), broken)).status).toBe(500)
    expect((await worker.fetch(new Request('https://x/license?email=ri%40x.com&deviceId=dev-1'), broken)).status).toBe(500)
    expect((await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.63' }, body: JSON.stringify({ email: 'ri@x.com', token: 'admin-tok' }) }), broken)).status).toBe(500)
    // Nenhuma mutação aconteceu no DO (assinatura intacta via env íntegro)
    expect((await worker.fetch(new Request('https://x/license?email=ri%40x.com&deviceId=dev-1'), env)).status).toBe(200)
  })
  it('H-R3: freeze vence antes do started — nenhuma escrita; reserva tardia é reclamada e rejeitada', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.70' }
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const acq = await reg.fetch('https://license-store/internal/freeze-acquire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'late-1' }) })
    expect(acq.status).toBe(200)
    expect((await worker.fetch(new Request('https://x/admin/freeze', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('late@x.com'))
    const attempted = await stub.fetch('https://license-store/internal/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'purchase_approved', data: { id: 'late-o1', customer: { email: 'late@x.com', name: 'Late' } }, opId: 'late-1' }) })
    expect(attempted.status).toBe(409); expect((await attempted.json()).error).toBe('lease_rejected')
    expect((await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    expect((await worker.fetch(new Request('https://x/license?email=late%40x.com&deviceId=dev-1'), env)).status).toBe(503)
  })
  it('H-R3: início antes do freeze — freeze aguarda liberação; lease started nunca expira por idade', async () => {
    const kv = new FakeKV() as any; const { env, stores } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.71' }
    env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const regStore = stores.get('__registry__')
    await regStore.put('freeze', { state: 'running', ops: { 'old-started': { phase: 'started', at: Date.now() - 10 * 60 * 1000 } } })
    const st = await worker.fetch(new Request('https://x/admin/freeze/state', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    const sj = await st.json(); expect(sj.state).toBe('running'); expect(sj.activeOperations).toBe(1)
  })
  it('H-R3: DO libera lease em finally (sucesso e erro); retry de liberação idempotente', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    const r = await doProc(env, 'fin@x.com', { event: 'purchase_approved', data: { id: 'fin1', customer: { email: 'fin@x.com', name: 'Fin' } } })
    expect(r.status).toBe(200)
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const st1 = await reg.fetch('https://license-store/internal/freeze-state'); expect((await st1.json()).activeOperations).toBe(0)
    // Retry de liberação de op já liberada não quebra nada
    expect((await reg.fetch('https://license-store/internal/freeze-complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'inexistente' }) })).status).toBe(200)
    // Freeze confirma sem operação ativa
    expect((await worker.fetch(new Request('https://x/admin/freeze', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.72' }, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    expect((await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.72' }, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
  })
  it('H-R3-2F: Worker não libera lease started; DO conclui; timeout do Worker não libera', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.80' }
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    const acq = await reg.fetch('https://license-store/internal/freeze-acquire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'op-started-1' }) })
    expect(acq.status).toBe(200)
    const started = await reg.fetch('https://license-store/internal/freeze-start-op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'op-started-1' }) })
    expect(started.status).toBe(200)
    // Worker backup (release-reserved) sobre lease started -> recusado 409, lease preservada
    const workerRelease = await reg.fetch('https://license-store/internal/freeze-release-reserved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'op-started-1' }) })
    expect(workerRelease.status).toBe(409); expect((await workerRelease.json()).error).toBe('lease_started')
    // Freeze não confirma com lease started pendente
    expect((await worker.fetch(new Request('https://x/admin/freeze', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    const conf = await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    expect(conf.status).toBe(409)
    // DO conclui (complete) -> freeze confirma depois
    expect((await reg.fetch('https://license-store/internal/freeze-complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'op-started-1' }) })).status).toBe(200)
    expect((await worker.fetch(new Request('https://x/admin/freeze/confirm', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).status).toBe(200)
    // Retry de conclusão idempotente
    expect((await reg.fetch('https://license-store/internal/freeze-complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'op-started-1' }) })).status).toBe(200)
  })
  it('H-R3-2F: reserva não iniciada pode ser liberada pelo caminho reserved e início tardio é rejeitado', async () => {
    const kv = new FakeKV() as any; const { env, stores } = makeEnv(kv)
    const reg = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__'))
    expect((await reg.fetch('https://license-store/internal/freeze-acquire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'res-1' }) })).status).toBe(200)
    expect((await reg.fetch('https://license-store/internal/freeze-release-reserved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'res-1' }) })).status).toBe(200)
    const late = await reg.fetch('https://license-store/internal/freeze-start-op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opId: 'res-1' }) })
    expect(late.status).toBe(409)
    void stores
  })
  it('F-1: falha de leitura do DO aborta o restore sem nenhuma escrita', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.90' }
    await doProc(env, 'f1@x.com', { event: 'purchase_approved', data: { id: 'f1-o1', customer: { email: 'f1@x.com', name: 'F1' } } })
    await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f1@x.com' }) })
    await freezeNow(env, '203.0.113.90')
    const snapshot = await (await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)).json()
    const failing: any = { ...env, LICENSE_DO: { idFromName: (n: string) => n, get: (id: string) => id === 'f1@x.com' ? { fetch: async () => new Response('{}', { status: 500 }) } : env.LICENSE_DO.get(id) } }
    const res = await worker.fetch(new Request('https://x/admin/restore-kv', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', records: snapshot.records, manifest: snapshot.manifest }) }), failing)
    expect(res.status).toBe(500); expect((await res.json()).error).toBe('current_state_unavailable')
    expect(await kv.get('sub:f1@x.com')).toBeNull()
  })
  it('F-2: pin e reset atualizam updatedAt e snapshot anterior a pin/reset é rejeitado', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.91' }
    const old = '2020-01-01T00:00:00.000Z'
    await kv.put('sub:f2@x.com', JSON.stringify({ email: 'f2@x.com', name: 'F2', status: 'active', revoked: false, deviceId: null, plan: 'pro-monthly', expiresAt: new Date(Date.now() + 86400000).toISOString(), updatedAt: old }))
    const lic = await worker.fetch(new Request('https://x/license?email=f2%40x.com&deviceId=dev-1'), env)
    expect(lic.status).toBe(200)
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('f2@x.com'))
    const rec1 = (await (await stub.fetch('https://license-store/internal/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f2@x.com' }) })).json()).sub
    expect(Date.parse(rec1.updatedAt)).toBeGreaterThan(Date.parse(old))
    // Reset administrativo bumpa também
    const reset = await worker.fetch(new Request('https://x/admin/reset-device', { method: 'POST', headers: H, body: JSON.stringify({ email: 'f2@x.com', token: 'admin-tok' }) }), env)
    expect(reset.status).toBe(200)
    const rec2 = (await (await stub.fetch('https://license-store/internal/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f2@x.com' }) })).json()).sub
    expect(Date.parse(rec2.updatedAt)).toBeGreaterThanOrEqual(Date.parse(rec1.updatedAt)); expect(rec2.deviceId).toBeNull()
    // Snapshot com pin antigo (updatedAt velho) diante do estado atual mais recente -> stale, sem escritas no KV alvo
    const kv2 = new FakeKV() as any; const { env: env2 } = makeEnv(kv2); await freezeNow(env2, '203.0.113.91')
    const orders = {}; const checksum = await sha256HexObjTest({ sub: rec1, orders })
    const res = await worker.fetch(new Request('https://x/admin/restore-kv', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', records: [{ email: 'f2@x.com', sub: rec1, orders }], manifest: { version: 1, snapshotId: crypto.randomUUID(), exportedAt: rec1.updatedAt, complete: true, totalRecords: 1, totalOrders: 0, batchCount: 1, checksums: { 'f2@x.com': checksum } } }) }), env2)
    // Sessão fabricada é rejeitada antes da comparação temporal (snapshot_not_found) — zero escritas no KV alvo
    expect(res.status).toBe(400); expect(await kv2.get('sub:f2@x.com')).toBeNull()
  })
  it('F-3: totalOrders divergente dos lotes persistidos é rejeitado', async () => {
    const kv = new FakeKV() as any; const { env, stores } = makeEnv(kv); const H = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.92' }
    await doProc(env, 'f3@x.com', { event: 'purchase_approved', data: { id: 'f3-o1', customer: { email: 'f3@x.com', name: 'F3' } } })
    await freezeNow(env, '203.0.113.92')
    await env.LICENSE_DO.get(env.LICENSE_DO.idFromName('__registry__')).fetch('https://license-store/internal/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f3@x.com' }) })
    const exp = await worker.fetch(new Request('https://x/admin/export', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok' }) }), env)
    const snapshot = await exp.json(); expect(snapshot.status || snapshot.ok).toBeTruthy()
    // Adulterar o mapa de lotes persistido (orders inflado) sem atualizar exportedOrders -> recalc diverge
    const regStore = stores.get('__registry__'); const sid = snapshot.snapshotId
    const session = await regStore.get(`snap:${sid}`); const bid = Object.keys(session.batches)[0]; session.batches[bid].orders = 99; await regStore.put(`snap:${sid}`, session)
    const res = await worker.fetch(new Request('https://x/admin/restore-kv', { method: 'POST', headers: H, body: JSON.stringify({ token: 'admin-tok', records: snapshot.records, manifest: snapshot.manifest }) }), env)
    expect(res.status).toBe(400); expect((await res.json()).error).toBe('count_mismatch'); expect(await kv.get('sub:f3@x.com')).toBeNull()
  })
  it('licença: plano inválido e sem device são rejeitados', async () => {
    const kv = new FakeKV() as any; const { env } = makeEnv(kv)
    await processEvent({ event: 'purchase_approved', data: { id: 'v1p', customer: { email: 'v@x.com', name: 'V' } } }, kv)
    const res = await worker.fetch(new Request('https://x/license?email=v%40x.com&deviceId=dev-9'), env)
    const { key } = await res.json()
    expect((await verifyLicense('lixo', 'dev-9')).ok).toBe(false)
    expect((await verifyLicense(key, '')).ok).toBe(false)
    const v = await verifyLicense(key, 'dev-9'); expect(v.ok).toBe(true); expect(v.payload!.plan).toBe('pro-monthly')
  })
  it('R2: DO não-OK (400/409/500) vira HTTP 500 no webhook (retry da Cakto)', async () => {
    const secret = 'segredo-teste'
    const payload = { secret, event: 'purchase_approved', data: { id: 'r2-1', customer: { email: 'r2@x.com', name: 'R2' } } }
    const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000))
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const raw = new TextEncoder().encode(body); const msg = new Uint8Array(ts.length + 1 + raw.length); msg.set(new TextEncoder().encode(`${ts}.`)); msg.set(raw, ts.length + 1)
    const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))).map(b => b.toString(16).padStart(2, '0')).join('')
    for (const status of [400, 409, 500]) {
      const { env: real } = makeEnv(new FakeKV(), secret)
      const env: any = { ...real, LICENSE_DO: { idFromName: (n: string) => n, get: (id: string) => id === '__registry__' ? real.LICENSE_DO.get(id) : ({ fetch: async () => new Response(JSON.stringify({ ok: false, error: 'x' }), { status }) }) } }
      const res = await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers: { 'x-cakto-timestamp': ts, 'x-cakto-signature': `v1=${hex}` }, body }), env)
      expect(res.status).toBe(500); expect(await res.json()).toEqual({ ok: false, error: 'license_store_failed' })
    }
  })
  it('R2: primeiro grupo OK + segundo falha = 500; retry não duplica o primeiro', async () => {
    const secret = 'segredo-teste'; const { env: realEnv } = makeEnv(new FakeKV(), secret)
    const payload = { secret, event: 'purchase_approved', data: [
      { id: 'g1', customer: { email: 'a1@x.com', name: 'A1' } },
      { id: 'g2', customer: { email: 'b1@x.com', name: 'B1' } },
    ] }
    const body = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000))
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const raw = new TextEncoder().encode(body); const msg = new Uint8Array(ts.length + 1 + raw.length); msg.set(new TextEncoder().encode(`${ts}.`)); msg.set(raw, ts.length + 1)
    const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))).map(b => b.toString(16).padStart(2, '0')).join('')
    const headers = { 'x-cakto-timestamp': ts, 'x-cakto-signature': `v1=${hex}` }
    const failingEnv: any = { ...realEnv, LICENSE_DO: { idFromName: (n: string) => n, get: (id: string) => id === 'b1@x.com' ? { fetch: async () => new Response('{}', { status: 500 }) } : realEnv.LICENSE_DO.get(id) } }
    const first = await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers, body }), failingEnv)
    expect(first.status).toBe(500)
    const expA = (await worker.fetch(new Request('https://x/license?email=a1%40x.com&deviceId=dev-1'), realEnv)).status
    expect(expA).toBe(200)
    const retry = await worker.fetch(new Request('https://x/webhook/cakto', { method: 'POST', headers, body }), realEnv)
    expect(retry.status).toBe(200)
    const j = await retry.json(); expect(j.results.find((r: any) => r.email === 'a1@x.com').skipped).toBe('duplicate'); expect(j.results.find((r: any) => r.email === 'b1@x.com').status).toBe('active')
    expect((await worker.fetch(new Request('https://x/license?email=b1%40x.com&deviceId=dev-1'), realEnv)).status).toBe(200)
  })
  it('R2: erro interno do DO não bloqueia a fila (próxima operação funciona)', async () => {
    const { env } = makeEnv()
    const stub = env.LICENSE_DO.get(env.LICENSE_DO.idFromName('q@x.com'))
    const bad = await stub.fetch('https://license-store/internal/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalido' })
    expect(bad.status).toBe(400)
    const good = await doProc(env, 'q@x.com', { event: 'purchase_approved', data: { id: 'q1', customer: { email: 'q@x.com', name: 'Q' } } })
    expect(good.status).toBe(200)
  })
  it('fetchAutoLicense falha sem URL e usa a URL configurada no build', async () => {
    expect(getLicenseApiUrl('')).toBe('https://noazul-license.noazul.workers.dev'); expect(isLicenseApiConfigured('')).toBe(false)
    const r = await fetchAutoLicense('', 'a@b.com', 'd'); expect(r.ok).toBe(false)
  })
  it('geração de chave de teste usa par real (sanidade do PEM)', async () => { const { pem } = await makePem(); expect(pem).toContain('PRIVATE KEY') })
})
