import type { Investment, InvestmentTransaction, InvestmentTxType } from '../types'

export const INVESTMENT_CATEGORIES = ['Renda fixa','Poupança','Ações','Fundos imobiliários','ETFs','Fundos de investimento','Criptomoedas','Outros'] as const
export const INVESTMENT_TX_TYPES = ['compra','aporte','venda','resgate','dividendo','rendimento'] as const
export const TX_LABELS: Record<InvestmentTxType, string> = { compra: 'Compra', aporte: 'Aporte', venda: 'Venda', resgate: 'Resgate', dividendo: 'Dividendo', rendimento: 'Rendimento' }
export const BUY_TYPES: InvestmentTxType[] = ['compra', 'aporte']
export const SELL_TYPES: InvestmentTxType[] = ['venda', 'resgate']
export const INCOME_TYPES: InvestmentTxType[] = ['dividendo', 'rendimento']

/**
 * REGRAS CONTÁBEIS (documentadas):
 * - investedAmount = CUSTO DE AQUISIÇÃO REMANESCENTE (nunca negativo), não caixa líquido.
 * - Compra/aporte: custo += amount; quantidade += qty; preço médio ponderado por quantidade.
 * - Venda/resgate com quantidade: custo removido = qty × preço médio; realizado = recebido − custo removido.
 * - Resgate sem quantidade (caixa, ex.: CDB): custo removido proporcional ao valor atual
 *   (fração retirada do patrimônio, limitada ao custo remanescente); realizado = recebido − custo removido.
 * - Dividendo/rendimento: não alteram custo nem valor atual; somados separados como rendimentos.
 * - Não realizado = currentValue − custo remanescente.
 * - Retorno total = realizado + não realizado + rendimentos; % sobre o capital líquido aportado
 *   (compras/aportes − proventos de venda, da série de movimentações; sem histórico, usa o custo cadastrado).
 */
const r2 = (v: number) => Math.round(v * 100) / 100
const r8 = (v: number) => Math.round(v * 1e8) / 1e8
const isNum = (v: any) => typeof v === 'number' && Number.isFinite(v)
export function validDate(d: any): boolean {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const [y, m, day] = d.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, day))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day
}

export function validateInvestment(inv: Partial<Investment>): string[] {
  const errs: string[] = []
  if (!inv.name?.trim()) errs.push('Dê um nome ao investimento')
  if (!INVESTMENT_CATEGORIES.includes(inv.category as any)) errs.push('Escolha uma categoria válida')
  if (inv.ticker && !/^[A-Z0-9.\-]{1,12}$/i.test(inv.ticker.trim())) errs.push('Ticker inválido (ex.: PETR4, BOVA11, BTC)')
  if (!isNum(inv.quantity) || (inv.quantity as number) < 0) errs.push('Quantidade inválida')
  if (!isNum(inv.averagePrice) || (inv.averagePrice as number) < 0) errs.push('Preço médio inválido')
  if (!isNum(inv.investedAmount) || (inv.investedAmount as number) < 0) errs.push('Total investido inválido')
  if (!isNum(inv.currentValue) || (inv.currentValue as number) < 0) errs.push('Valor atual inválido')
  if (inv.startedAt && !validDate(inv.startedAt)) errs.push('Data da aplicação inválida')
  return errs
}

export function validateInvestmentTransaction(tx: Partial<InvestmentTransaction>): string[] {
  const errs: string[] = []
  if (!tx.investmentId?.trim()) errs.push('Escolha o investimento')
  if (!INVESTMENT_TX_TYPES.includes(tx.type as any)) errs.push('Escolha um tipo de movimentação')
  if (!isNum(tx.amount) || (tx.amount as number) <= 0) errs.push('Valor deve ser maior que zero')
  const needsQty = BUY_TYPES.includes(tx.type as any) || SELL_TYPES.includes(tx.type as any)
  if (needsQty && tx.quantity != null && tx.quantity !== 0 && (!isNum(tx.quantity) || (tx.quantity as number) <= 0)) errs.push('Quantidade inválida')
  if (tx.unitPrice != null && tx.unitPrice !== 0 && (!isNum(tx.unitPrice) || (tx.unitPrice as number) < 0)) errs.push('Preço unitário inválido')
  if (!validDate(tx.date)) errs.push('Data inválida')
  // Consistência quantidade × preço × valor (com tolerância de centavo) quando os três estão informados
  if (isNum(tx.quantity) && isNum(tx.unitPrice) && isNum(tx.amount) && (tx.quantity as number) > 0 && (tx.unitPrice as number) > 0) {
    if (Math.abs((tx.quantity as number) * (tx.unitPrice as number) - (tx.amount as number)) > 0.011) errs.push('Valor inconsistente com quantidade × preço unitário')
  }
  return errs
}

export function validateAgainstPosition(inv: Investment, tx: Partial<InvestmentTransaction>): string[] {
  const errs: string[] = []
  if (SELL_TYPES.includes(tx.type as any) && isNum(tx.quantity) && (tx.quantity as number) > 0 && inv.quantity > 0 && (tx.quantity as number) > inv.quantity) {
    errs.push('Quantidade maior que a posição atual')
  }
  return errs
}

export function isDuplicateTransaction(txs: InvestmentTransaction[], candidate: Partial<InvestmentTransaction>): boolean {
  return txs.some(t => t.investmentId === candidate.investmentId && t.type === candidate.type && t.date === candidate.date && r2(t.amount) === r2(candidate.amount as number) && r8(t.quantity) === r8(candidate.quantity as number) && (t.description || '') === (candidate.description || ''))
}

export interface AppliedResult { investment: Investment; costRemoved: number; realizedGain: number }
export function applyTransactionDetailed(inv: Investment, tx: InvestmentTransaction): AppliedResult {
  const next = { ...inv }
  let costRemoved = 0; let realizedGain = 0
  if (BUY_TYPES.includes(tx.type)) {
    const totalQty = inv.quantity + tx.quantity
    next.averagePrice = totalQty > 0 && tx.quantity > 0 ? r2((inv.quantity * inv.averagePrice + tx.quantity * tx.unitPrice) / totalQty) : r2(tx.unitPrice || inv.averagePrice)
    next.quantity = r8(totalQty)
    next.investedAmount = r2(inv.investedAmount + tx.amount)
  } else if (SELL_TYPES.includes(tx.type)) {
    if (tx.quantity > 0 && inv.quantity > 0) {
      if (tx.quantity > inv.quantity) throw new Error('Quantidade maior que a posição atual')
      costRemoved = r2(Math.min(r2(tx.quantity * inv.averagePrice), inv.investedAmount))
      next.quantity = r8(inv.quantity - tx.quantity)
    } else {
      const frac = inv.currentValue > 0 ? Math.min(1, tx.amount / inv.currentValue) : 1
      costRemoved = r2(Math.min(inv.investedAmount, tx.amount * frac > inv.investedAmount ? inv.investedAmount : frac * inv.investedAmount))
      costRemoved = r2(Math.min(costRemoved, inv.investedAmount))
      next.quantity = r8(Math.max(0, inv.quantity - tx.quantity))
    }
    next.investedAmount = r2(Math.max(0, inv.investedAmount - costRemoved))
    realizedGain = r2(tx.amount - costRemoved)
  }
  next.updatedAt = new Date().toISOString()
  return { investment: next, costRemoved, realizedGain }
}
export function applyTransaction(inv: Investment, tx: InvestmentTransaction): Investment {
  return applyTransactionDetailed(inv, tx).investment
}
/** Inverso exato de uma venda (usa o custo removido gravado); compras revertem por delta (médio mantido — aproximação documentada). */
export function reverseTransaction(inv: Investment, tx: InvestmentTransaction): Investment {
  const next = { ...inv }
  if (BUY_TYPES.includes(tx.type)) {
    next.quantity = r8(Math.max(0, inv.quantity - tx.quantity))
    next.investedAmount = r2(Math.max(0, inv.investedAmount - tx.amount))
  } else if (SELL_TYPES.includes(tx.type)) {
    next.quantity = r8(inv.quantity + tx.quantity)
    next.investedAmount = r2(inv.investedAmount + (tx.costRemoved || 0))
  }
  next.updatedAt = new Date().toISOString()
  return next
}

export function investmentGain(inv: Investment) {
  const gain = r2(inv.currentValue - inv.investedAmount)
  const pct = inv.investedAmount > 0 ? r2((gain / inv.investedAmount) * 100) : 0
  return { gain, pct }
}

export function filterByUser<T extends { userId: string }>(rows: T[], userId: string): T[] {
  return rows.filter(r => r.userId === userId)
}

export function summarizeInvestments(investments: Investment[], transactions: InvestmentTransaction[]) {
  const mine = investments
  const totalCurrent = r2(mine.reduce((a, i) => a + i.currentValue, 0))
  const totalCostRemaining = r2(mine.reduce((a, i) => a + i.investedAmount, 0))
  const realized = r2(transactions.filter(t => SELL_TYPES.includes(t.type)).reduce((a, t) => a + (t.realizedGain || 0), 0))
  const unrealized = r2(totalCurrent - totalCostRemaining)
  const income = r2(transactions.filter(t => INCOME_TYPES.includes(t.type)).reduce((a, t) => a + t.amount, 0))
  const totalReturn = r2(realized + unrealized + income)
  // Capital líquido aportado: compras/aportes − proventos de venda (histórico); sem histórico, usa o custo cadastrado.
  const txByInv = new Map<string, InvestmentTransaction[]>()
  for (const t of transactions) { if (!txByInv.has(t.investmentId)) txByInv.set(t.investmentId, []); txByInv.get(t.investmentId)!.push(t) }
  let netCash = 0
  for (const inv of mine) {
    const txs = txByInv.get(inv.id) || []
    const flows = txs.filter(t => BUY_TYPES.includes(t.type) || SELL_TYPES.includes(t.type))
    netCash += flows.length ? flows.reduce((a, t) => a + (BUY_TYPES.includes(t.type) ? t.amount : -t.amount), 0) : inv.investedAmount
  }
  const netCashInvested = r2(netCash)
  const byCategory = Object.entries(mine.reduce<Record<string, number>>((acc, i) => { acc[i.category] = (acc[i.category] || 0) + i.currentValue; return acc }, {}))
    .map(([name, value]) => ({ name, value: r2(value) })).sort((a, b) => b.value - a.value)
  const byInstitution = Object.entries(mine.reduce<Record<string, number>>((acc, i) => { const k = i.institution.trim() || 'Sem instituição'; acc[k] = (acc[k] || 0) + i.currentValue; return acc }, {}))
    .map(([name, value]) => ({ name, value: r2(value) })).sort((a, b) => b.value - a.value)
  const perInvestment = mine.map(i => ({ ...i, ...investmentGain(i) })).sort((a, b) => b.currentValue - a.currentValue)
  const months: { month: string; invested: number }[] = []
  const sortedTx = [...transactions].sort((a, b) => a.date.localeCompare(b.date))
  let running = 0
  for (const inv of mine) {
    const flows = txByInv.get(inv.id) || []
    if (!flows.some(t => BUY_TYPES.includes(t.type) || SELL_TYPES.includes(t.type)) && inv.investedAmount > 0 && inv.startedAt) {
      running += inv.investedAmount
    }
  }
  const byMonth = new Map<string, number>()
  for (const t of sortedTx) {
    if (BUY_TYPES.includes(t.type)) running += t.amount
    else if (SELL_TYPES.includes(t.type)) running -= t.amount
    byMonth.set(t.date.slice(0, 7), running)
  }
  // Incorpora o capital inicial de quem não tem histórico no mês de início (evita divergência dashboard↔evolução)
  for (const inv of mine) {
    const flows = txByInv.get(inv.id) || []
    if (!flows.some(t => BUY_TYPES.includes(t.type) || SELL_TYPES.includes(t.type)) && inv.investedAmount > 0 && inv.startedAt) {
      const k = inv.startedAt.slice(0, 7)
      if (!byMonth.has(k)) byMonth.set(k, inv.investedAmount)
    }
  }
  const monthsSorted = [...byMonth.entries()].sort()
  for (const [month, invested] of monthsSorted.slice(-12)) months.push({ month, invested: r2(invested) })
  return {
    count: mine.length, totalCurrent, totalCostRemaining, totalInvested: totalCostRemaining,
    realized, unrealized, income, totalReturn,
    totalReturnPct: netCashInvested > 0 ? r2((totalReturn / netCashInvested) * 100) : 0,
    netCashInvested, byCategory, byInstitution, perInvestment, evolution: months,
  }
}
