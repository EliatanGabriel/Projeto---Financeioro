// @ts-nocheck
// ECDSA P-256 via WebCrypto. Public key embedded below; private key NEVER in app.
const PUBLIC_JWK_JSON='{"kty": "EC", "x": "oRR_sKL4ss5RvdsMsBQZP7yMs4BTQCpe1TX0IWiM-Dw", "y": "WN1LlHcEBIuHN4P7syPF51bIeWq3y13Nu-_HKfICOl8", "crv": "P-256"}'
function b64uToBuf(s:string){ const t=s.replace(/-/g,'+').replace(/_/g,'/'); const pad=Array.from({length:(4-t.length%4)%4}).map(()=>'=').join(''); const raw=atob(t+pad); const a=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i); return a }
function bufToB64u(b:ArrayBuffer){ const bytes=new Uint8Array(b); let s=''; bytes.forEach(x=>s+=String.fromCharCode(x)); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') }
export interface LicensePayload{holder:string;deviceId:string;issuedAt:string;expiresAt:string|null;plan:string}
export function getDeviceId(){
 let id=localStorage.getItem('precifica.deviceId'); if(!id){ const a=new Uint8Array(16); crypto.getRandomValues(a); id=Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join(''); localStorage.setItem('precifica.deviceId',id) } return id
}
export async function verifyLicense(key:string, deviceId:string):Promise<{ok:boolean;reason:string;payload?:LicensePayload;license?:any}>{
 try{
  const parts=key.trim().split('.'); if(parts.length!==3||parts[0]!=='PRP1') return {ok:false,reason:'Formato inválido. Esperado PRP1.payload.signature'}
  const data=b64uToBuf(parts[1]); const sig=b64uToBuf(parts[2])
  const payload: LicensePayload=JSON.parse(new TextDecoder().decode(data))
  if (!['pro-monthly','monthly','lifetime'].includes(payload.plan)) return {ok:false,reason:'Plano inválido.'}
  if (!payload.deviceId) return {ok:false,reason:'Licença sem vínculo de dispositivo.'}
  const pub=await crypto.subtle.importKey('jwk',JSON.parse(PUBLIC_JWK_JSON),{name:'ECDSA',namedCurve:'P-256'},false,['verify'])
  const ok=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,sig,data)
  if(!ok) return {ok:false,reason:'Assinatura inválida.'}
  const now=new Date(); if(payload.expiresAt&&new Date(payload.expiresAt)<now) return {ok:false,reason:'Licença expirada.'}
  if(payload.deviceId&&payload.deviceId!==deviceId) return {ok:false,reason:'Licença vinculada a outro dispositivo.'}
  return {ok:true,reason:'Válida',payload,license:{key,keyPayload:payload}}
 }catch(e:any){ return {ok:false,reason:'Erro: '+(e?.message||'chave inválida')} }
}
export const PUBLIC_JWK = PUBLIC_JWK_JSON
/** Pro mensal: válido enquanto expiresAt estiver no futuro. Vitalício (legado) sempre válido. */
export function isProActive(payload?: LicensePayload | null, now = new Date()): boolean {
  if (!payload) return false
  if (payload.plan === 'lifetime') return true
  if (!['pro-monthly','monthly'].includes(payload.plan)) return false
  if (!payload.expiresAt) return false
  return new Date(payload.expiresAt).getTime() > now.getTime()
}
export async function fetchAutoLicense(apiUrl: string, email: string, deviceId: string): Promise<{ ok: boolean; key?: string; expiresAt?: string | null; holder?: string; plan?: string; error?: string; message?: string }> {
  const base = String(apiUrl || '').replace(/\/$/, '')
  if (!base) return { ok: false, error: 'not_configured', message: 'Ativação automática ainda não foi configurada.' }
  let r: Response
  try { r = await fetch(`${base}/license?email=${encodeURIComponent(email.trim().toLowerCase())}&deviceId=${encodeURIComponent(deviceId)}`) }
  catch { return { ok: false, error: 'network', message: 'Sem internet. Confira a conexão e tente de novo.' } }
  const data = await r.json().catch(() => ({}))
  if (!r.ok || !data.ok) return { ok: false, error: data.error || 'failed', message: data.message || 'Não encontramos assinatura ativa para este e-mail.' }
  return data
}
export function proDaysLeft(payload?: LicensePayload | null, now = new Date()): number {
  if (!payload?.expiresAt) return payload?.plan === 'lifetime' ? 99999 : 0
  return Math.max(0, Math.ceil((new Date(payload.expiresAt).getTime() - now.getTime()) / 86400000))
}
