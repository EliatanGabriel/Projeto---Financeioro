export const brl=(v:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)||0)
export const pct=(v:number)=>new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(v)||0)+'%'
export const num=(s:string)=>{const n=parseFloat(String(s).replace(/\./g,'').replace(',','.'));return isNaN(n)?0:n}
export const newId=()=> (crypto as any)?.randomUUID?.() ?? Date.now().toString(36)+Math.random().toString(36).slice(2,9)
export const todayISO=()=>new Date().toISOString()
