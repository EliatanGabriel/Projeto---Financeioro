// Uso Pro mensal (Cakto): node tools/generate-license.mjs --holder "Cliente" --device <idDoAparelho> --plan monthly --months 1
// Legado vitalício: ... --plan lifetime
// Gera chave ECDSA P-256 se não existir em tools/private.key.pem (NÃO distribua!) e emite licença PRP1.payload.signature
import {generateKeyPairSync,createPrivateKey,sign} from 'node:crypto'
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,c,i,arr)=>c.startsWith('--')?[...a,[c.slice(2),arr[i+1]]]:a,[]))
const holder=args.holder||'Cliente'; const deviceId=args.device||''
const plan=args.plan||'monthly'; const months=Number(args.months||1)
let privPem=args.private
if(!privPem){ if(existsSync('tools/private.key.pem')) privPem='tools/private.key.pem'; else{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
 writeFileSync('tools/private.key.pem',privateKey.export({type:'pkcs8',format:'pem'}))
 const jwk=publicKey.export({format:'jwk'})
 console.log('PUBLIC_JWK=' + JSON.stringify(jwk))
 console.log('PRIVATE_KEY gerada em tools/private.key.pem — NÃO distribua, guarde offline!')
 privPem='tools/private.key.pem'
}}
const priv=createPrivateKey(readFileSync(privPem,'utf8'))
const issuedAt=new Date()
let expiresAt=null
if(plan==='monthly'){ const d=new Date(issuedAt); d.setMonth(d.getMonth()+months); expiresAt=d.toISOString() }
else if(args.expires){ expiresAt=new Date(args.expires).toISOString() }
const payload={holder,deviceId,issuedAt:issuedAt.toISOString(),expiresAt,plan:plan==='lifetime'?'lifetime':'pro-monthly'}
const data=Buffer.from(JSON.stringify(payload))
const b64u=b=>b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const der=sign('SHA256',data,priv)
// WebCrypto espera assinatura crua R||S (64 bytes), não DER. Converte DER -> cru.
function derToRaw(der){ let off=2; const readInt=()=>{ let len=der[off+1]; let v=der.subarray(off+2,off+2+len); off+=2+len; if(v[0]===0) v=v.subarray(1); return Buffer.concat([Buffer.alloc(32-v.length),v]) }; const r=readInt(); const s=readInt(); return Buffer.concat([r,s]) }
const sig=derToRaw(der)
console.log('Plano:',payload.plan,'| Expira:',expiresAt||'nunca (vitalício)','| Titular:',holder,'| Aparelho:',deviceId||'(qualquer)')
console.log('PRP1.'+b64u(data)+'.'+b64u(sig))
