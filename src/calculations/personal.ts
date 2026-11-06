import type {Transaction, FixedBill, Goal, Budget, BillPayment, Recurrence} from '../types'

export const EXPENSE_CATEGORIES = ['Moradia','Alimentação','Transporte','Contas da casa','Lazer','Saúde','Educação','Compras','Assinaturas','Outros'] as const
export const INCOME_CATEGORIES = ['Salário','Trabalho extra','Venda','Presente','Reembolso','Outros'] as const
export const BILL_SUGGESTIONS = ['Aluguel','Energia','Água','Internet','Celular','Cartão','Transporte','Escola','Plano de saúde'] as const
export const GOAL_SUGGESTIONS = ['Reserva de emergência','Viagem','Carro','Casa','Curso','Quitar dívidas'] as const

export const monthKey = (d: Date | string) => {
  const dt = typeof d === 'string' ? new Date(d + 'T12:00:00') : d
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
}
export const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  const names = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro']
  return `${names[m - 1]} de ${y}`
}
export function shiftMonth(key: string, delta: number) {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return monthKey(d)
}
export function daysLeftInMonth(key: string, ref = new Date()) {
  const [y, m] = key.split('-').map(Number)
  if (monthKey(ref) !== key) return m === new Date(y, m, 0).getMonth() + 1 ? new Date(y, m, 0).getDate() : 30
  const last = new Date(y, m, 0).getDate()
  return Math.max(1, last - ref.getDate() + 1)
}
export function validateTransaction(t: Partial<Transaction>): string[] {
  const errs: string[] = []
  if (!t.description?.trim()) errs.push('Dê um nome, por exemplo: Supermercado')
  if (!t.amount || t.amount <= 0) errs.push('Informe um valor maior que zero')
  if (!t.date) errs.push('Escolha a data')
  else if (isNaN(new Date(t.date + 'T12:00:00').getTime())) errs.push('Data inválida')
  if (t.type !== 'in' && t.type !== 'out') errs.push('Escolha se entrou ou saiu dinheiro')
  if (!t.category?.trim()) errs.push('Escolha uma categoria')
  return errs
}
export function goalProgress(g: Goal) {
  const pct = g.target > 0 ? Math.min(100, Math.max(0, (g.saved / g.target) * 100)) : 0
  const remaining = Math.max(0, g.target - g.saved)
  let perMonth = 0
  if (g.deadline) {
    const now = new Date(); const end = new Date(g.deadline + 'T12:00:00')
    const months = Math.max(1, Math.ceil(((end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth()))))
    perMonth = remaining > 0 ? Math.ceil((remaining / months) * 100) / 100 : 0
  }
  return { pct: Math.round(pct * 10) / 10, remaining, perMonth, done: remaining === 0 && g.target > 0 }
}
export function summarize(transactions: Transaction[], bills: FixedBill[], month: string, ref = new Date()) {
  const tx = transactions.filter(t => monthKey(t.date) === month)
  const income = tx.filter(t => t.type === 'in').reduce((a, t) => a + t.amount, 0)
  const expense = tx.filter(t => t.type === 'out').reduce((a, t) => a + t.amount, 0)
  const balance = income - expense
  const billsTotal = bills.reduce((a, b) => a + b.amount, 0)
  const afterBills = balance - billsTotal
  const daysLeft = daysLeftInMonth(month, ref)
  const dailyAllowance = Math.max(0, Math.floor((afterBills > 0 ? afterBills : 0) / daysLeft * 100) / 100)
  const byCategory = Object.entries(tx.filter(t => t.type === 'out').reduce<Record<string, number>>((acc, t) => {
    acc[t.category] = (acc[t.category] || 0) + t.amount; return acc
  }, {})).map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 })).sort((a, b) => b.value - a.value)
  const biggest = byCategory[0]
  const savingsRate = income > 0 ? Math.max(-100, Math.min(100, (balance / income) * 100)) : 0
  const insights: string[] = []
  if (!tx.length) insights.push('Comece adicionando o que entrou e o que saiu neste mês. Leva menos de um minuto por lançamento.')
  else if (balance < 0) insights.push('Neste mês saiu mais do que entrou. Veja a categoria com maior gasto abaixo e tente reduzir um item.')
  else if (balance > 0) insights.push(`Você terminou o mês com ${balance.toFixed(2).replace('.', ',')} sobrando. Que tal guardar uma parte para uma meta?`)
  if (biggest && expense > 0 && biggest.value / expense >= 0.4) insights.push(`A maior parte dos gastos foi com ${biggest.name}. Se puder, vale olhar esse item com calma.`)
  if (afterBills > 0) insights.push(`Descontando as contas fixas, ainda sobram ${afterBills.toFixed(2).replace('.', ',')} — cerca de ${dailyAllowance.toFixed(2).replace('.', ',')} por dia até o fim do mês.`)
  if (bills.length === 0) insights.push('Cadastre suas contas fixas (aluguel, luz, internet...) para saber quanto realmente sobra.')
  // upcoming bills in next 7 days relative to ref
  const upcoming = bills.filter(b => {
    const due = new Date(ref.getFullYear(), ref.getMonth(), b.dueDay)
    const diff = Math.ceil((due.getTime() - new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime()) / 86400000)
    return diff >= 0 && diff <= 7
  }).sort((a, b) => a.dueDay - b.dueDay)
  if (upcoming.length) insights.push(`Próximas contas fixas: ${upcoming.map(b => `${b.name} (dia ${b.dueDay})`).join(', ')}.`)
  return {
    income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100,
    balance: Math.round(balance * 100) / 100, billsTotal: Math.round(billsTotal * 100) / 100,
    afterBills: Math.round(afterBills * 100) / 100, dailyAllowance, daysLeft,
    byCategory, biggest, savingsRate: Math.round(savingsRate * 10) / 10, insights, monthTx: tx,
  }
}
export function overallBalance(transactions: Transaction[]) {
  return Math.round(transactions.reduce((a, t) => a + (t.type === 'in' ? t.amount : -t.amount), 0) * 100) / 100
}
export function budgetStatus(transactions: Transaction[], budgets: Budget[], month: string) {
  const spentByCat = transactions.filter(t => t.type === 'out' && monthKey(t.date) === month)
    .reduce<Record<string, number>>((acc, t) => { acc[t.category] = (acc[t.category] || 0) + t.amount; return acc }, {})
  return budgets.filter(b => b.limit > 0).map(b => {
    const spent = Math.round((spentByCat[b.category] || 0) * 100) / 100
    const pct = b.limit > 0 ? Math.min(999, Math.round((spent / b.limit) * 1000) / 10) : 0
    const remaining = Math.round((b.limit - spent) * 100) / 100
    const status: 'ok' | 'atencao' | 'estourou' = spent > b.limit ? 'estourou' : pct >= 80 ? 'atencao' : 'ok'
    return { category: b.category, limit: b.limit, spent, pct, remaining, status }
  }).sort((a, b) => b.pct - a.pct)
}
export function billsSummary(bills: FixedBill[], payments: BillPayment[], month: string, ref = new Date()) {
  const paidIds = new Set(payments.filter(p => p.month === month).map(p => p.billId))
  const items = bills.map(b => {
    const paid = paidIds.has(b.id)
    const due = new Date(ref.getFullYear(), ref.getMonth(), b.dueDay)
    const todayStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate())
    const daysToDue = Math.ceil((due.getTime() - todayStart.getTime()) / 86400000)
    const overdue = !paid && monthKey(ref) === month && daysToDue < 0
    const dueSoon = !paid && daysToDue >= 0 && daysToDue <= 7
    return { ...b, paid, daysToDue, overdue, dueSoon }
  }).sort((a, b) => a.dueDay - b.dueDay)
  const paidTotal = items.filter(i => i.paid).reduce((a, i) => a + i.amount, 0)
  const pendingTotal = items.filter(i => !i.paid).reduce((a, i) => a + i.amount, 0)
  return { items, paidTotal: Math.round(paidTotal * 100) / 100, pendingTotal: Math.round(pendingTotal * 100) / 100, overdue: items.filter(i => i.overdue), dueSoon: items.filter(i => i.dueSoon) }
}
export function dateForDay(month: string, day: number) {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  const d = Math.max(1, Math.min(day, last))
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
export function recurrenceDate(r: Recurrence, month: string) { return dateForDay(month, r.day) }
export function isRecurrenceLaunched(launches: { recurrenceId: string; month: string }[], r: Recurrence, month: string) {
  return launches.some(l => l.recurrenceId === r.id && l.month === month)
}
export function forecast(transactions: Transaction[], bills: FixedBill[], month: string, ref = new Date()) {
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const isCurrent = monthKey(ref) === month
  const day = isCurrent ? ref.getDate() : daysInMonth
  const tx = transactions.filter(t => monthKey(t.date) === month)
  const income = tx.filter(t => t.type === 'in').reduce((a, t) => a + t.amount, 0)
  const expense = tx.filter(t => t.type === 'out').reduce((a, t) => a + t.amount, 0)
  const perDay = day > 0 ? expense / day : 0
  const projectedExpense = Math.round(perDay * daysInMonth * 100) / 100
  const projectedBalance = Math.round((income - projectedExpense) * 100) / 100
  const billsTotal = bills.reduce((a, b) => a + b.amount, 0)
  return { daysInMonth, day, projectedExpense, projectedBalance, projectedAfterBills: Math.round((projectedBalance - billsTotal) * 100) / 100, perDayExpense: Math.round(perDay * 100) / 100 }
}
export function onboardingSteps(tx: Transaction[], bills: FixedBill[], goals: Goal[], budgets: Budget[]) {
  return [
    { label: 'Adicionar uma entrada (ex.: salário)', done: tx.some(t => t.type === 'in'), tab: 'movimentos' },
    { label: 'Adicionar uma saída (ex.: supermercado)', done: tx.some(t => t.type === 'out'), tab: 'movimentos' },
    { label: 'Cadastrar uma conta fixa (luz, aluguel...)', done: bills.length > 0, tab: 'contas' },
    { label: 'Definir um limite para uma categoria', done: budgets.some(b => b.limit > 0), tab: 'resumo' },
    { label: 'Criar uma meta (viagem, reserva...)', done: goals.length > 0, tab: 'metas' },
  ]
}
export function monthlyHistory(transactions: Transaction[], months = 6, ref = new Date()) {
  const out: { month: string; label: string; income: number; expense: number; balance: number }[] = []
  for (let i = months - 1; i >= 0; i--) {
    const key = shiftMonth(monthKey(ref), -i)
    const tx = transactions.filter(t => monthKey(t.date) === key)
    const income = tx.filter(t => t.type === 'in').reduce((a, t) => a + t.amount, 0)
    const expense = tx.filter(t => t.type === 'out').reduce((a, t) => a + t.amount, 0)
    out.push({ month: key, label: monthLabel(key).split(' ')[0].slice(0, 3), income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100, balance: Math.round((income - expense) * 100) / 100 })
  }
  return out
}
