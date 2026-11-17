export const brl=(v:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)||0)
export const pct=(v:number)=>new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(v)||0)+'%'
export function num(s: string): number {
  let t = String(s ?? '').trim().replace(/[^\d.,-]/g, '')
  if (!t || t === '-' || t === '.' || t === ',') return 0
  const negative = t.startsWith('-')
  t = t.replace(/-/g, '')
  const dots = (t.match(/\./g) || []).length
  const commas = (t.match(/,/g) || []).length
  if (dots > 1 && commas > 0) return 0
  if (commas > 1 && dots > 0) return 0
  if (dots > 0 && commas > 0) {
    const decimal = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ','
    const thousands = decimal === '.' ? ',' : '.'
    t = t.split(thousands).join('').replace(decimal, '.')
  } else if (dots > 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
    else if (dots !== 1) return 0
  } else if (commas > 0) {
    if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '')
    else if (commas !== 1) return 0
    else t = t.replace(',', '.')
  }
  const n = Number(t)
  return Number.isFinite(n) ? (negative ? -n : n) : 0
}
export const newId=()=> (crypto as any)?.randomUUID?.() ?? Date.now().toString(36)+Math.random().toString(36).slice(2,9)
export const todayISO=()=>new Date().toISOString()
export const localDateISO=(d = new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
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
