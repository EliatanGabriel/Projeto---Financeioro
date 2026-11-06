import { describe, it, expect } from 'vitest'
import { isProActive, proDaysLeft, fetchAutoLicense, verifyLicense } from '../licensing/licensing'
import { PRO_PRICE_BRL, FREE_LIMITS, getCheckoutUrl, isCheckoutConfigured, getLicenseApiUrl, PRO_FEATURES } from '../config/plans'

const now = new Date('2026-11-05T12:00:00')
describe('plano Pro mensal', () => {
  it('preço é R$ 10 por mês', () => { expect(PRO_PRICE_BRL).toBe(10) })
  it('Pro ativo dentro do prazo, inativo depois', () => {
    expect(isProActive({ holder: 'A', deviceId: 'd', issuedAt: '', expiresAt: '2026-12-05', plan: 'pro-monthly' } as any, now)).toBe(true)
    expect(isProActive({ holder: 'A', deviceId: 'd', issuedAt: '', expiresAt: '2026-10-05', plan: 'pro-monthly' } as any, now)).toBe(false)
  })
  it('sem expiração não é Pro mensal; vitalício legado continua válido', () => {
    expect(isProActive({ holder: 'A', deviceId: 'd', issuedAt: '', expiresAt: null, plan: 'pro-monthly' } as any, now)).toBe(false)
    expect(isProActive({ holder: 'A', deviceId: 'd', issuedAt: '', expiresAt: null, plan: 'lifetime' } as any, now)).toBe(true)
    expect(proDaysLeft({ holder: 'A', deviceId: 'd', issuedAt: '', expiresAt: '2026-11-15', plan: 'pro-monthly' } as any, now)).toBe(10)
  })
  it('limites do grátis e recursos do Pro', () => { expect(FREE_LIMITS.goals).toBe(3); expect(PRO_FEATURES.length).toBeGreaterThanOrEqual(6) })
  it('checkout Cakto: configurado ou placeholder', () => { expect(isCheckoutConfigured('https://pay.cakto.com.br/x')).toBe(true); expect(isCheckoutConfigured('https://pay.cakto.com.br/SEU-PRODUTO-AQUI')).toBe(false); expect(getCheckoutUrl('https://pay.cakto.com.br/x')).toContain('cakto'); expect(getCheckoutUrl('')).toContain('pay.cakto.com.br') })
  it('URL do Worker vem configurada no build (produção)', () => { expect(getLicenseApiUrl('')).toBe('https://noazul-license.noazul.workers.dev') })
  it('plano fora da whitelist e licença sem device são rejeitados', () => {
    expect(isProActive({ holder: 'A', deviceId: 'd', issuedAt: '', expiresAt: '2026-12-05', plan: 'free' } as any, now)).toBe(false)
    expect(isProActive({ holder: 'A', deviceId: 'd', issuedAt: '', expiresAt: '2026-12-05', plan: 'monthly' } as any, now)).toBe(true)
  })
  it('verifyLicense rejeita formato inválido e placeholder adulterado', async () => {
    expect((await verifyLicense('lixo', 'd')).ok).toBe(false)
    expect((await verifyLicense('PRP1.e30.e30', 'd')).ok).toBe(false)
  })
  it('fetchAutoLicense: sucesso, 404, 403, 500 e offline (mock)', async () => {
    const orig = globalThis.fetch
    const set = (impl: any) => { globalThis.fetch = impl }
    try {
      set(async () => new Response(JSON.stringify({ ok: true, key: 'K' }), { status: 200 })); expect((await fetchAutoLicense('https://x', 'a@b.com', 'd')).key).toBe('K')
      set(async () => new Response(JSON.stringify({ ok: false, error: 'not_active', message: 'genérica' }), { status: 404 })); expect((await fetchAutoLicense('https://x', 'a@b.com', 'd')).error).toBe('not_active')
      set(async () => new Response(JSON.stringify({ ok: false, error: 'device_mismatch', message: 'outro aparelho' }), { status: 409 })); expect((await fetchAutoLicense('https://x', 'a@b.com', 'd')).error).toBe('device_mismatch')
      set(async () => new Response('erro', { status: 500 })); expect((await fetchAutoLicense('https://x', 'a@b.com', 'd')).ok).toBe(false)
      set(async () => { throw new Error('offline') }); const off = await fetchAutoLicense('https://x', 'a@b.com', 'd'); expect(off.error).toBe('network')
    } finally { globalThis.fetch = orig }
  })
})
