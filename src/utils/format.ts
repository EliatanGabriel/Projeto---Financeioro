export const brl=(v:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)||0)
export const pct=(v:number)=>new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(v)||0)+'%'
export const num=(s:string)=>{let t=String(s??'').trim().replace(/[^\d.,-]/g,'');if(!t||t==='-'||t==='.'||t===',')return 0;if(t.includes('.')&&t.includes(','))t=t.replace(/\./g,'').replace(',','.');else t=t.replace(',','.');const n=parseFloat(t);return isNaN(n)?0:n}
export const newId=()=> (crypto as any)?.randomUUID?.() ?? Date.now().toString(36)+Math.random().toString(36).slice(2,9)
export const todayISO=()=>new Date().toISOString()
export const showConfirm=(msg:string)=>confirm(msg)
export const confirm=(msg:string)=>new Promise<boolean>(res => res(showConfirm(msg)))

/** Paleta fixa usada em gráficos e marcadores. */
export const CATEGORY_PALETTE = ['#0E9F6E','#0F766E','#14B8A6','#F59E0B','#F97316','#8B5CF6','#EC4899','#64748B','#06B6D4','#84CC16']
/** Cor estável por nome de categoria: a mesma categoria sempre pega a mesma cor, em qualquer mês ou gráfico. */
export const categoryColor = (name: string) => {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return CATEGORY_PALETTE[h % CATEGORY_PALETTE.length]
}
