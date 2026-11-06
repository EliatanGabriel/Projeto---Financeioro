import type { Transaction } from '../types'
import { monthKey, monthLabel } from './personal'

const r2 = (v: number) => Math.round(v * 100) / 100

export function annualSummary(transactions: Transaction[], year: number) {
  const tx = transactions.filter(t => Number(t.date.slice(0, 4)) === year)
  const income = r2(tx.filter(t => t.type === 'in').reduce((a, t) => a + t.amount, 0))
  const expense = r2(tx.filter(t => t.type === 'out').reduce((a, t) => a + t.amount, 0))
  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`
    const mtx = tx.filter(t => monthKey(t.date) === key)
    const inc = r2(mtx.filter(t => t.type === 'in').reduce((a, t) => a + t.amount, 0))
    const exp = r2(mtx.filter(t => t.type === 'out').reduce((a, t) => a + t.amount, 0))
    return { month: key, label: monthLabel(key).split(' ')[0].slice(0, 3), income: inc, expense: exp, balance: r2(inc - exp) }
  })
  const activeMonths = months.filter(m => m.income + m.expense > 0)
  const byCategory = Object.entries(tx.filter(t => t.type === 'out').reduce<Record<string, number>>((acc, t) => { acc[t.category] = (acc[t.category] || 0) + t.amount; return acc }, {}))
    .map(([name, value]) => ({ name, value: r2(value) })).sort((a, b) => b.value - a.value)
  const sorted = [...months].sort((a, b) => b.balance - a.balance)
  const bestMonth = activeMonths.length ? sorted.find(m => m.income + m.expense > 0) : undefined
  const worstMonth = activeMonths.length ? sorted[sorted.length - 1] : undefined
  const divisor = activeMonths.length || 1
  return {
    year, income, expense, balance: r2(income - expense), months, byCategory,
    biggestCategory: byCategory[0], activeMonths: activeMonths.length, count: tx.length,
    avgIncome: r2(income / divisor), avgExpense: r2(expense / divisor),
    savingsRate: income > 0 ? r2(Math.max(-100, Math.min(100, ((income - expense) / income) * 100))) : 0,
    bestMonth, worstMonth,
    positiveMonths: months.filter(m => m.balance > 0).length,
  }
}

export function compareAnnual(transactions: Transaction[], year: number) {
  const cur = annualSummary(transactions, year)
  const prev = annualSummary(transactions, year - 1)
  const pct = (a: number, b: number) => b === 0 ? (a === 0 ? 0 : 100) : r2(((a - b) / Math.abs(b)) * 100)
  const hasPrev = prev.count > 0
  return {
    cur, prev, hasPrev,
    incomeDiff: r2(cur.income - prev.income), expenseDiff: r2(cur.expense - prev.expense), balanceDiff: r2(cur.balance - prev.balance),
    incomePct: pct(cur.income, prev.income), expensePct: pct(cur.expense, prev.expense), balancePct: pct(cur.balance, prev.balance),
  }
}

/** Nota 0-100 de organização financeira no ano. */
export function financialScore(transactions: Transaction[], year: number) {
  const a = annualSummary(transactions, year)
  if (!a.count) return { score: 0, label: 'Sem dados', detail: 'Adicione movimentos para calcular sua nota.' }
  let score = 0
  // 40 pts: taxa de poupança
  score += a.savingsRate >= 30 ? 40 : a.savingsRate >= 20 ? 32 : a.savingsRate >= 10 ? 24 : a.savingsRate > 0 ? 12 : 0
  // 30 pts: meses positivos
  score += a.activeMonths ? (a.positiveMonths / a.activeMonths) * 30 : 0
  // 30 pts: controle de gastos (gasto/receita)
  const ratio = a.income > 0 ? a.expense / a.income : 1
  score += ratio <= 0.7 ? 30 : ratio <= 0.85 ? 22 : ratio <= 1 ? 12 : 0
  score = Math.round(Math.min(100, score))
  const label = score >= 75 ? 'Muito organizado' : score >= 55 ? 'No caminho certo' : score >= 35 ? 'Precisa de atenção' : 'Desorganizado'
  const detail = score >= 75 ? 'Você está guardando bem e gastando com controle. Continue assim!' : score >= 55 ? 'Bom começo. Guardar um pouco mais todo mês já melhora muito.' : 'Tente reduzir a categoria que mais pesa e guardar um valor fixo todo mês.'
  return { score, label, detail }
}

export function spendingTrend(transactions: Transaction[], ref = new Date()) {
  const avg = (from: number, to: number) => {
    const months: number[] = []
    for (let i = from; i <= to; i++) {
      const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1)
      const key = monthKey(d)
      months.push(transactions.filter(t => t.type === 'out' && monthKey(t.date) === key).reduce((a, t) => a + t.amount, 0))
    }
    return months.length ? months.reduce((a, b) => a + b, 0) / months.length : 0
  }
  const recent = avg(0, 2), previous = avg(3, 5)
  const pctChange = previous > 0 ? r2(((recent - previous) / previous) * 100) : 0
  const direction: 'subiu' | 'caiu' | 'igual' = Math.abs(pctChange) < 5 ? 'igual' : pctChange > 0 ? 'subiu' : 'caiu'
  return { recent: r2(recent), previous: r2(previous), pctChange, direction }
}

export function proInsights(transactions: Transaction[], year: number, ref = new Date()): string[] {
  const a = annualSummary(transactions, year)
  const out: string[] = []
  if (!a.count) return ['Adicione movimentos em '+year+' para ver a análise completa.']
  if (a.biggestCategory) out.push(`No ano todo, a categoria que mais pesou foi ${a.biggestCategory.name} (${a.biggestCategory.value.toFixed(2).replace('.', ',')}). É o melhor lugar para cortar primeiro.`)
  if (a.bestMonth) out.push(`Seu melhor mês foi ${monthLabel(a.bestMonth.month)}: sobraram ${a.bestMonth.balance.toFixed(2).replace('.', ',')}. Tente repetir o que fez nele.`)
  if (a.worstMonth && a.worstMonth.balance < 0) out.push(`O mês mais apertado foi ${monthLabel(a.worstMonth.month)} (${a.worstMonth.balance.toFixed(2).replace('.', ',')}). Observe o que pesou nele.`)
  const t = spendingTrend(transactions, ref)
  if (t.direction === 'subiu') out.push(`Seus gastos dos últimos 3 meses subiram ${Math.abs(t.pctChange)}% em relação aos 3 meses anteriores. Vale rever.`)
  if (t.direction === 'caiu') out.push(`Boa notícia: seus gastos dos últimos 3 meses caíram ${Math.abs(t.pctChange)}% em relação aos anteriores.`)
  if (a.savingsRate > 0) out.push(`Você guardou ${a.savingsRate}% do que entrou em ${year}. Guardar 20% ou mais é um ótimo hábito.`)
  else if (a.income > 0) out.push(`Em ${year} você gastou tudo o que entrou (ou mais). Uma meta de guardar 10% por mês já muda o jogo.`)
  return out
}
