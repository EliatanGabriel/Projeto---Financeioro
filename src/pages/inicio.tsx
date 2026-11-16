import { useEffect, useMemo, useState } from 'react'
import { Wallet, Home, ArrowLeftRight, Receipt, PiggyBank, BarChart3, Settings as SettingsIcon, CreditCard as CreditCardIcon, Plus, Trash2, Sun, Moon, ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Lightbulb, Download, Upload, Search, Pencil, Check, CalendarClock, FileText, AlertTriangle, ListChecks, Crown, Lock, X, CalendarDays, Sparkles, ExternalLink, UserRound, Mail, LogOut, KeyRound, ShieldCheck } from 'lucide-react'
import { listTransactions, addTransaction, deleteTransaction, listFixedBills, upsertFixedBill, deleteFixedBill, listGoals, upsertGoal, deleteGoal, listBudgets, setBudget, listBillPayments, setBillPaid, listRecurrences, upsertRecurrence, deleteRecurrence, listRecurrenceLaunches, markRecurrenceLaunched, listCategories, addCategory, deleteCategory, clearAllData, listGoalAutoLaunches, markGoalAutoLaunched, listInvestments, upsertInvestment, deleteInvestment, listInvestmentTransactions, listAllInvestmentTransactions, addInvestmentTransaction, deleteInvestmentTransaction, replaceInvestmentTransaction, getSetting, setSetting, exportBackup, importBackup, resolveSyncConflict, listCreditCards, upsertCreditCard, deleteCreditCard, listCreditCardPurchases, upsertCreditCardPurchase, deleteCreditCardPurchase, listCreditCardPayments, setCreditCardPaid } from './database/db'
import { INVESTMENT_CATEGORIES, INVESTMENT_TX_TYPES, TX_LABELS, validateInvestment, validateInvestmentTransaction, validateAgainstPosition, isDuplicateTransaction, applyTransactionDetailed, reverseTransaction, investmentGain, summarizeInvestments } from './calculations/investments'
import { cardSummary, cardColor } from './calculations/creditCards'
import { brl, newId, num } from './utils/format'
import { parseReminderSettings, dueBills, reminderMessage, reminderFingerprint, requestNotifications, showReminderNotification, notificationPermission } from './utils/reminders'
import type { ReminderSettings } from './utils/reminders'
import { parseOfx, looksLikeOfx } from './utils/ofx'
import { exportCSV, exportPDFReport, exportXLSX } from './utils/reports'
import { summarize, monthlyHistory, goalProgress, validateTransaction, monthKey, monthLabel, shiftMonth, overallBalance, budgetStatus, billsSummary, forecast, onboardingSteps, isRecurrenceLaunched, recurrenceDate, EXPENSE_CATEGORIES, INCOME_CATEGORIES, BILL_SUGGESTIONS, GOAL_SUGGESTIONS } from './calculations/personal'
import { annualSummary, compareAnnual, financialScore, spendingTrend, proInsights } from './calculations/annual'
import { PRO_PRICE_BRL, PRO_FEATURES, FREE_FEATURES, FREE_LIMITS, getCheckoutUrl, isCheckoutConfigured, getLicenseApiUrl, isLicenseApiConfigured } from './config/plans'
import { verifyLicense, getDeviceId, isProActive, proDaysLeft, fetchAutoLicense } from './licensing/licensing'
import { useAuth } from './auth/useAuth'
import type { Transaction, FixedBill, Goal, Budget, BillPayment, Recurrence, Category, Investment, InvestmentTransaction, CreditCard, CreditCardPurchase, CreditCardPayment } from './types'
import { BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend } from 'recharts'
import type { Tab } from './'

type Tab = 'inicio' | 'movimentos' | 'contas' | 'cartoes' | 'metas' | 'resumo' | 'investimentos' | 'pro' | 'perfil' | 'config'
const ACCENTS: Record<string, { label: string; brand: string; dark: string }> = {
  esmeralda: { label: 'Verde (grátis)', brand: '#0E9F6E', dark: '#0F766E' },
  violeta: { label: 'Roxo (Pro)', brand: '#8B5CF6', dark: '#7C3AED' },
  azul: { label: 'Azul (Pro)', brand: '#3B82F6', dark: '#2563EB' },
  ambar: { label: 'Âmbar (Pro)', brand: '#F59E0B', dark: '#D97706' },
}
const today = () => new Date().toISOString().slice(0, 10)
const GREEN = '#0E9F6E', ROSE = '#E11D63'
const PIE_COLORS = ['#0E9F6E','#0F766E','#14B8A6','#F59E0B','#F97316','#8B5CF6','#EC4899','#64748B','#06B6D4','#84CC16']

async function currentPro(): Promise<boolean> {
  const key = await getSetting('licenseKey'); if (!key) return false
  const r = await verifyLicense(key, getDeviceId()); return r.ok && isProActive(r.payload)
}
async function ensureMonthlyRecurrences(uid: string) {
  const recs = await listRecurrences(uid)
  const launches = await listRecurrenceLaunches(uid); const now = new Date(); const month = monthKey(now)
  for (const r of recs.filter((x: any) => x.active && x.day <= now.getDate())) {
    if (isRecurrenceLaunched(launches, r, month)) continue
    await addTransaction({ id: newId(), userId: uid, description: r.description, amount: r.amount, type: r.type, category: r.category, date: recurrenceDate(r, month), createdAt: new Date().toISOString() })
    await markRecurrenceLaunched(r.id, month, uid)
  }
  try {
    if (!(await currentPro())) return
    const goals = await listGoals(uid); const done = await listGoalAutoLaunches(uid)
    for (const g of goals.filter((x: any) => (x.autoMonthly || 0) > 0 && x.saved < x.target)) {
      if (done.some((d: any) => d.goalId === g.id && d.month === month)) continue
      await upsertGoal({ ...g, userId: uid, saved: Math.min(g.target, g.saved + (g.autoMonthly || 0)) })
      await markGoalAutoLaunched(g.id, month, uid)
    }
  } catch {}
}

export default function Inicio() {
  const auth = useAuth()
  const authConfigured = auth.configured; const authUser = auth.user
  const isRecovery = window.location.pathname.includes('redefinir') || (window.location.hash.includes('type=recovery'))
  const [tab, setTab] = useState<Tab>('inicio')
  const [dark, setDark] = useState(false)
  const [name, setName] = useState('')
  const [month, setMonth] = useState(monthKey(new Date()))
  const [tx, setTx] = useState<Transaction[]>([])
  const [bills, setBills] = useState<FixedBill[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [payments, setPayments] = useState<BillPayment[]>([])
  const [recurrences, setRecurrences] = useState<Recurrence[]>([])
  const [launches, setLaunches] = useState<any[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [toast, setToast] = useState('')
  const [pro, setPro] = useState<any>({ activated: false, holder: '', expiresAt: null, plan: '', key: '' })
  const [accent, setAccent] = useState('esmeralda')
  const [checkoutUrl, setCheckoutUrl] = useState('')
  const [licenseApiUrl, setLicenseApiUrl] = useState('')
  const [showUpsell, setShowUpsell] = useState(false)
  const [userId, setUserId] = useState('')
  const [investments, setInvestments] = useState<Investment[]>([])
  const [invTx, setInvTx] = useState<InvestmentTransaction[]>([])
  const [cards, setCards] = useState<CreditCard[]>([])
  const [cardPurchases, setCardPurchases] = useState<CreditCardPurchase[]>([])
  const [cardPayments, setCardPayments] = useState<CreditCardPayment[]>([])

  const reload = async () => {
    let uid = authUser?.id || (await getSetting('userId'))
    if (!uid) { uid = getDeviceId(); await setSetting('userId', uid) }
    setUserId(uid)
    setInvestments(await listInvestments(uid)); setInvTx(await listAllInvestmentTransactions(uid))
    setCards(await listCreditCards(uid)); setCardPurchases(await listCreditCardPurchases(uid)); setCardPayments(await listCreditCardPayments(uid))
    setTx(await listTransactions(uid)); setBills(await listFixedBills(uid)); setGoals(await listGoals(uid))
    setBudgets(await listBudgets(uid)); setPayments(await listBillPayments(uid))
    setRecurrences(await listRecurrences(uid)); setLaunches(await listRecurrenceLaunches(uid))
    setCategories(await listCategories(uid))
    setName(await getSetting('userName') || authUser?.user_metadata?.display_name || '')
    const t = await getSetting('theme'); if (t) setDark(t === 'dark')
    setAccent(await getSetting('accent') || 'esmeralda')
    setCheckoutUrl(await getSetting('caktoCheckoutUrl') || '')
    setLicenseApiUrl(await getSetting('licenseApiUrl') || '')
    const key = await getSetting('licenseKey')
    if (key) {
      const r = await verifyLicense(key, getDeviceId())
      if (r.ok && isProActive(r.payload)) setPro({ activated: true, holder: r.payload!.holder, expiresAt: r.payload!.expiresAt, plan: r.payload!.plan, key })
      else setPro({ activated: false, holder: r.payload?.holder || (await getSetting('licenseHolder') || ''), expiresAt: r.payload?.expiresAt || (await getSetting('licenseExpires') || null), plan: r.payload?.plan || '', key, expired: r.ok, reason: r.reason })
    }
  }
  const uid = auth?.user?.id || userId
  const enqueueDelete = async (entity: any, row: any) => { try { const { makeDeleteOp } = await import('./sync/engine'); const { enqueueSyncOp } = await import('./database/db'); await enqueueSyncOp({ ...makeDeleteOp(entity, { ...row, userId: uid }), userId: uid }) } catch {} }
  const [syncState, setSyncState] = useState<any>({ status: 'idle', lastSyncAt: null, pending: 0, conflicts: [], message: null })
  const runSync = async () => {
    if (!authConfigured || !authUser) return
    try {
      const { supabaseSyncClient } = await import('./sync/supabaseSync')
      const { syncAll } = await import('./sync/syncService')
      const { makeSyncStore } = await import('./sync/store')
      const client = supabaseSyncClient(authUser.id)
      const state = await syncAll(makeSyncStore(authUser.id), client, ['transactions','fixed_bills','goals','budgets','bill_payments','recurrences','recurrence_launches','categories','goal_auto_launches','investments','investment_transactions','credit_cards','credit_card_purchases','credit_card_payments'], setSyncState)
      if (state.status === 'idle') await reload()
    } catch (e: any) { setSyncState({ status: 'offline', lastSyncAt: null, pending: 0, conflicts: [], message: e?.message || 'Sem conexão.' }) }
  }
  useEffect(() => { if (authConfigured && authUser) { runSync(); const iv = setInterval(runSync, 60000); const onl = () => runSync(); window.addEventListener('online', onl); return () => { clearInterval(iv); window.removeEventListener('online', onl) } } }, [authUser?.id])
  const [migration, setMigration] = useState<any>(null)
  useEffect(() => {
    if (!authConfigured || !authUser) return
    ;(async () => {
      const legacy = getDeviceId()
      if (legacy === authUser.id) return
      const counts = await (await import('./database/db')).legacyCounts(legacy)
      const legacyTotal = Object.entries(counts).filter(([k]) => k.endsWith(':' + legacy)).reduce((a: number, [, v]: any) => a + Number(v), 0)
      const ambiguous = Object.entries(counts).filter(([k]) => { const u = k.split(':').pop(); return u !== legacy && u !== authUser.id && u !== '' }).reduce((a: number, [, v]: any) => a + Number(v), 0)
      if (legacyTotal > 0 || ambiguous > 0) setMigration({ counts, legacyTotal, ambiguous })
    })()
  }, [authUser?.id])
  useEffect(() => { if (authUser?.id) reload() }, [authUser?.id])
  useEffect(() => { (async () => {
    const uidNow = auth?.user?.id || (await getSetting('userId')) || getDeviceId()
    try { await ensureMonthlyRecurrences(uidNow) } catch {}
    await reload()
    try {
      const savedKey = await getSetting('licenseKey'); if (!savedKey) return
      const v = await verifyLicense(savedKey, getDeviceId())
      const days = v.payload ? proDaysLeft(v.payload) : 0
      if (v.ok && isProActive(v.payload) && days > 7) return
      const savedEmail = await getSetting('caktoEmail'); const api = getLicenseApiUrl(await getSetting('licenseApiUrl'))
      if (!savedEmail || !isLicenseApiConfigured(api)) return
      const r = await (await import('./licensing/licensing')).fetchAutoLicense(api, savedEmail, getDeviceId())
      if (r.ok && r.key) { const nv = await verifyLicense(r.key, getDeviceId()); if (nv.ok && isProActive(nv.payload)) { await setSetting('licenseKey', r.key); await setSetting('licenseHolder', nv.payload!.holder); await setSetting('licenseExpires', nv.payload!.expiresAt || ''); await setSetting('plan', nv.payload!.plan); await reload() } }
    } catch {}
  })() }, [])
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      try {
        const settings = parseReminderSettings(await getSetting('reminderSettings'))
        if (!settings.enabled) return
        const now = new Date()
        if (now.getHours() < settings.hour) return
        const items = dueBills(bills, payments, now, settings.daysBefore)
        if (!items.length) return
        const fingerprint = reminderFingerprint(items, now)
        if (await getSetting('reminderLast') === fingerprint) return
        const ok = await showReminderNotification('NoAzul: contas chegando', reminderMessage(items))
        if (ok) await setSetting('reminderLast', fingerprint)
      } catch { /* lembrete nunca quebra o app */ }
    }
    run()
    const timer = setInterval(run, 30 * 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [bills, payments])
  useEffect(() => { const a = ACCENTS[accent] || ACCENTS.esmeralda; document.documentElement.style.setProperty('--brand', a.brand); document.documentElement.style.setProperty('--brand-dark', a.dark) }, [accent])
  const isPro = !!pro.activated
  const requirePro = () => { if (isPro) return true; setShowUpsell(true); return false }
  const checkout = getCheckoutUrl(checkoutUrl)
  const licenseApi = getLicenseApiUrl(licenseApiUrl)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
const show = (m: string) => { 
  if (toastTimer) clearTimeout(toastTimer) 
  setToast(m) 
  toastTimer = setTimeout(() => setToast(''), 2600) 
}
  const s = useMemo(() => summarize(tx, bills, month), [tx, bills, month])
  const history = useMemo(() => monthlyHistory(tx, 6), [tx])
  const history12 = useMemo(() => monthlyHistory(tx, 12), [tx])
  const overall = useMemo(() => overallBalance(tx), [tx])
  const bstatus = useMemo(() => budgetStatus(tx, budgets, month), [tx, budgets, month])
  const bsum = useMemo(() => billsSummary(bills, payments, month), [bills, payments, month])
  const fc = useMemo(() => forecast(tx, bills, month), [tx, bills, month])
  const invSummary = useMemo(() => summarizeInvestments(investments, invTx), [investments, invTx])
  const goalsTotals = useMemo(() => {
    const target = goals.reduce((a, g) => a + g.target, 0)
    const saved = goals.reduce((a, g) => a + Math.min(g.saved, g.target), 0)
    const done = goals.filter(g => g.saved >= g.target).length
    return { target, saved, done, count: goals.length, remaining: Math.max(0, target - saved), pct: target > 0 ? Math.round((saved / target) * 100) : 0 }
  }, [goals])
  const billsTotals = useMemo(() => {
    const total = bsum.paidTotal + bsum.pendingTotal
    const paidCount = bsum.items.filter((b: any) => b.paid).length
    return { total, paidCount, count: bsum.items.length, pct: total > 0 ? Math.round((bsum.paidTotal / total) * 100) : 0 }
  }, [bsum])
  const steps = useMemo(() => onboardingSteps(tx, bills, goals, budgets), [tx, bills, goals, budgets])
  const expenseCats = categories.filter(c => c.type === 'out').map(c => c.name).length ? categories.filter(c => c.type === 'out').map(c => c.name) : [...EXPENSE_CATEGORIES]
  const incomeCats = categories.filter(c => c.type === 'in').map(c => c.name).length ? categories.filter(c => c.type === 'in').map(c => c.name) : [...INCOME_CATEGORIES]
  const alerts = [...bstatus.filter(b => b.status === 'estourou').map(b => `Você passou do limite em ${b.category}: gastou ${brl(b.spent)} de ${brl(b.limit)}.`), ...bsum.overdue.map(b => `${b.name} venceu no dia ${b.dueDay} e ainda não foi marcada como paga.`)]
  const NAV: [Tab, string, any][] = [
    ['inicio', 'Início', Home], ['movimentos', 'Movimentos', ArrowLeftRight],
    ['contas', 'Contas fixas', Receipt], ['cartoes', 'Cartões', CreditCardIcon], ['metas', 'Metas', PiggyBank],
    ['resumo', 'Resumo', BarChart3], ['investimentos', 'Investimentos', TrendingUp], ['pro', 'NoAzul Pro', Crown], ['perfil', 'Meu perfil', UserRound], ['config', 'Ajustes', SettingsIcon],
  ]

  if (authConfigured && !auth.loading && isRecovery) return <ResetPasswordScreen auth={auth} />
  if (authConfigured && !auth.loading && !authUser) return <AuthScreen auth={auth} />
  return (
    <div className="min-h-screen">
      {migration && authUser && <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"><div className="card p-6 max-w-md w-full space-y-4"><div className="font-extrabold text-lg">Importar dados deste aparelho?</div><p className="muted text-sm leading-relaxed">Encontramos <b>{migration.legacyTotal} registro(s)</b> antigos neste aparelho. Importar associa tudo à sua conta e envia para a nuvem. Nada é apagado antes da confirmação.{migration.ambiguous > 0 && <><br /><br />Atenção: há <b>{migration.ambiguous} registro(s) com identidade ambígua</b> — a importação será interrompida para revisão manual.</>}</p><div className="flex gap-2"><button className="btn" disabled={migration.ambiguous > 0} onClick={async () => { try { const moved = await (await import('./database/db')).reassignLegacyUser(getDeviceId(), authUser.id); if (moved > 0) { await runSync(); show('Dados importados') } setMigration(null); await reload() } catch (e: any) { show(e.message) } }}>Importar e sincronizar</button><button className="btn-ghost" onClick={() => setMigration(null)}>Agora não</button></div></div></div>}
      <aside className="hidden md:flex inset-y-0 left-0 w-64 flex-col p-5 gap-1 z-20 sidebar">
        <Logo />
        <nav className="mt-4 space-y-1">
          {NAV.map(([k, l, Icon]: any) => <button key={k} onClick={() => setTab(k)} className="navlink" data-active={tab === k}><Icon size={19} />{l}{k === 'contas' && bsum.overdue.length > 0 && <span className="ml-auto badge bg-rose-100 text-rose-700">{bsum.overdue.length}</span>}{k === 'pro' && <span className="ml-auto badge" style={{ background: isPro ? '#D1FAE5' : '#FEF3C7', color: isPro ? '#065F46' : '#92400E' }}>{isPro ? 'ATIVO' : 'R$ 10'}</span>}</button>)}
        </nav>
        <div className="mt-auto card p-4">
          <div className="font-bold text-sm">Seus dados são seus</div>
          <p className="muted text-xs mt-1 leading-relaxed">Tudo fica salvo só neste aparelho. Nada é enviado para a internet.</p>
        </div>
      </aside>

      <div className="md:pl-64">
        <header className="sticky top-0 z-10 topbar">
          <div className="max-w-5xl mx-auto px-4 md:px-7 py-4 flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl md:text-2xl font-extrabold tracking-tight">Olá{name ? `, ${name.split(' ')[0]}` : ''}!</h1>
              <p className="muted text-sm">Vamos organizar seu dinheiro, sem complicação.</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="monthnav">
                <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Mês anterior"><ChevronLeft size={18} /></button>
                <span className="capitalize">{monthLabel(month)}</span>
                <button onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Próximo mês"><ChevronRight size={18} /></button>
              </div>
              {authConfigured && <button className="btn-ghost !py-2" onClick={syncState.status === 'conflict' ? () => setTab('perfil') : runSync}>{syncState.status === 'syncing' ? 'Sincronizando...' : syncState.status === 'conflict' ? `${syncState.conflicts?.length || 0} conflito(s)` : syncState.status === 'offline' ? 'Offline' : syncState.lastSyncAt ? 'Sincronizado' : 'Sincronizar'}</button>}
              <button className="btn-ghost !py-2" onClick={() => setTab('pro')}><Crown size={16} /> {isPro ? 'Pro ativo' : 'Pro'}</button>
              <button className="iconbtn" onClick={() => { setDark(!dark); setSetting('theme', !dark ? 'dark' : 'light') }} aria-label="Alternar tema">{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
            </div>
          </div>
        </header>

        <main className="md:pl-64">
          {tab === 'inicio' && (
            <div className="space-y-5">
              <section className="hero">
                <div className="muted text-sm font-semibold">Sobrou neste mês</div>
                <div className="hero-value">{brl(s.balance)}</div>
                <p className="text-sm opacity-90 mt-1">Entrou {brl(s.income)} • Saiu {brl(s.expense)} • Saldo total desde o começo: <b>{brl(overall)}</b></p>
                {s.afterBills > 0 ? <div className="hero-chip">Você pode gastar cerca de <b>{brl(s.dailyAllowance)} por dia</b> até o fim do mês, sem estourar.</div>
                  : s.balance > 0 ? <div className="hero-chip">Descontando as contas fixas, fica apertado — vale segurar um pouco.</div>
                  : <div className="hero-chip">Adicione o que entrou este mês para ver quanto sobra.</div>}
                <button className="btn-white mt-5" onClick={() => setTab('movimentos')}><Plus size={18} /> Adicionar entrada ou saída</button>
              </section>

              {!isPro ? (
                <section className="pro-banner">
                  <div><div className="font-extrabold flex items-center gap-2"><Crown size={18} /> Desbloqueie o Pro por {brl(PRO_PRICE_BRL)}/mês</div><p className="text-sm opacity-90 mt-1">Resumo anual avançado, nota de organização, metas que guardam sozinhas, Excel e temas premium.</p></div>
                  <button className="btn-white shrink-0" onClick={() => setTab('pro')}>Ver o Pro</button>
                </section>
              ) : (
                <section className="card p-4 flex items-center gap-3"><Crown size={20} className="text-amber-500" /><div className="text-sm"><b>Pro ativo</b> até {pro.expiresAt ? new Date(pro.expiresAt).toLocaleDateString('pt-BR') : '—'} • {proDaysLeft(pro)} dia(s) restantes. Obrigado!</div><button className="link ml-auto shrink-0" onClick={() => setTab('pro')}>Ver</button></section>
              )}

              {steps.some(x => !x.done) && (
                <section className="card p-5">
                  <h2 className="font-bold flex items-center gap-2"><ListChecks size={18} className="text-emerald-600" /> Primeiros passos</h2>
                  <div className="mt-3 space-y-2">
                    {steps.map(st => {
                      const isDone = st.done
                      return (<button key={st.label} onClick={() => setTab(st.tab as Tab)} className="flex items-center gap-3 w-full text-left text-sm py-1">
                        <span className={isDone ? 'check done' : 'check'}>{isDone && <Check size={13} />}</span>
                        <span className={isDone ? 'muted line-through' : 'font-medium'>{st.label}</span>
                      </button>)
                    })}
                  </div>
                </section>
              )}

              {alerts.length > 0 && <section className="card p-5" style={{ borderColor: '#FECDD3' }}><h2 className="font-bold flex items-center gap-2 text-rose-600"><AlertTriangle size={18} /> Atenção</h2><ul className="mt-2 space-y-1 text-sm">{alerts.map((a, i) => <li key={i}>• {a}</li>)}</ul></section>}

              <div>
                <div className="flex items-center justify-between mb-3"><h2 className="font-extrabold text-lg">Visão geral</h2><span className="muted text-xs">Tudo em um só lugar</span></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                  <div className="card p-5">
                    <div className="flex items-center justify-between">
                      <div className="stat-icon up"><Wallet size={20} /></div>
                      <span className="badge" style={{ background: s.balance >= 0 ? '#D1FAE5' : '#FFE4E6', color: s.balance >= 0 ? '#065F46' : '#9F1239' }}>Mês {s.balance >= 0 ? '+' : ''}{brl(s.balance)}</span>
                    </div>
                    <div className="muted text-xs font-bold uppercase mt-3">Saldo em contas</div>
                    <div className={`text-2xl font-extrabold mt-1 ${overall < 0 ? 'text-rose-600' : ''}`}>{brl(overall)}</div>
                    <div className="muted text-xs mt-1">Entrou {brl(s.income)} • Saiu {brl(s.expense)} no mês</div>
                  </div>
                  <div className="card p-5">
                    <div className="flex items-center justify-between">
                      <div className="stat-icon up"><TrendingUp size={20} /></div>
                      {invSummary.count > 0 && <span className="badge" style={{ background: invSummary.totalReturn >= 0 ? '#D1FAE5' : '#FFE4E6', color: invSummary.totalReturn >= 0 ? '#065F46' : '#9F1239' }}>{invSummary.totalReturn >= 0 ? '+' : ''}{invSummary.totalReturnPct}%</span>}
                    </div>
                    <div className="muted text-xs font-bold uppercase mt-3">Investimentos</div>
                    <div className="text-2xl font-extrabold mt-1">{brl(invSummary.totalCurrent)}</div>
                    <div className="muted text-xs mt-1">{invSummary.count ? `Aplicado ${brl(invSummary.totalInvested)} • retorno ${invSummary.totalReturn >= 0 ? '+' : ''}${brl(invSummary.totalReturn)}` : 'Nenhum investimento cadastrado ainda'}</div>
                    <button className="link text-xs mt-2" onClick={() => setTab('investimentos')}>{invSummary.count ? 'Ver carteira' : 'Cadastrar investimento'}</button>
                  </div>
                  <div className="card p-5">
                    <div className="flex items-center justify-between">
                      <div className="stat-icon neutral"><PiggyBank size={20} /></div>
                      {goalsTotals.count > 0 && <span className="badge" style={{ background: '#D1FAE5', color: '#065F46' }}>{goalsTotals.pct}%</span>}
                    </div>
                    <div className="muted text-xs font-bold uppercase mt-3">Metas</div>
                    <div className="text-2xl font-extrabold mt-1">{brl(goalsTotals.saved)}</div>
                    <div className="progress mt-2"><div style={{ width: Math.min(100, goalsTotals.pct) + '%' }} /></div>
                    <div className="muted text-xs mt-1">{goalsTotals.count ? `de ${brl(goalsTotals.target)} • faltam ${brl(goalsTotals.remaining)}` : 'Defina sua primeira meta'}</div>
                    <button className="link text-xs mt-2" onClick={() => setTab('metas')}>{goalsTotals.done > 0 ? `${goalsTotals.done} de ${goalsTotals.count} concluídas` : 'Ver metas'}</button>
                  </div>
                  <div className="card p-5">
                    <div className="flex items-center justify-between">
                      <div className="stat-icon neutral"><Receipt size={20} /></div>
                      {billsTotals.count > 0 && <span className="badge" style={{ background: '#FEF3C7', color: '#92400E' }}>{billsTotals.pct}% pagas</span>}
                    </div>
                    <div className="muted text-xs font-bold uppercase mt-3">Contas fixas do mês</div>
                    <div className="text-2xl font-extrabold mt-1">{brl(bsum.paidTotal)}</div>
                    <div className="progress mt-2"><div style={{ width: Math.min(100, billsTotals.pct) + '%' }} /></div>
                    <div className="muted text-xs mt-1">{billsTotals.count ? `${billsTotals.paidCount} de ${billsTotals.count} pagas • ${brl(bsum.pendingTotal)} pendente` : 'Nenhuma conta fixa cadastrada'}</div>
                    <button className="link text-xs mt-2" onClick={() => setTab('contas')}>Ver contas</button>
                  </div>
                </div>
              </div>

              <section className="card p-5">
                <h2 className="font-bold flex items-center gap-2"><Lightbulb size={18} className="text-amber-500" /> Dicas para você</h2>
                <ul className="mt-3 space-y-2 text-sm leading-relaxed">{s.insights.map((t, i) => <li key={i} className="flex gap-2"><span className="dot" />{t}</li>)}
                <li className="flex gap-2"><span className="dot" />Se continuar assim, você deve terminar o mês com cerca de <b>{brl(fc.projectedBalance)}</b> (descontando contas fixas: {brl(fc.projectedAfterBills)}).</li></ul>
              </section>

              {bstatus.length > 0 && <section className="card p-5"><div className="flex justify-between items-center"><h2 className="font-bold">Seus limites</h2><button className="link" onClick={() => setTab('resumo')}>Ajustar</button></div><div className="mt-3 space-y-3">{bstatus.slice(0, 3).map(b => <div key={b.category} className="flex items-center gap-2 text-sm"><span className="swatch" style={{ background: b.status === 'estourou' ? '#E11D63' : b.status === 'atencao' ? '#F59E0B' : GREEN }} /></span><span className="font-bold">{b.category}</span><span className="muted">{brl(b.spent)} de {brl(b.limit)}</span></div>}</div></section>}

              <div className="grid md:grid-cols-2 gap-4">
                <section className="card p-5">
                  <h2 className="font-bold mb-3">Para onde foi seu dinheiro?</h2>
                  {s.byCategory.length ? (
                    <div className="flex items-center gap-4">
                      <div style={{ height: 200, flex: 1 }}><ResponsiveContainer><PieChart><Pie data={s.byCategory} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={3}>{s.byCategory.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}</Pie><Tooltip formatter={(v: any) => brl(v)} /></PieChart></ResponsiveContainer></div>
                      <ul className="text-sm space-y-2 min-w-[130px]">{s.byCategory.slice(0, 5).map((c, i) => <li key={c.name} className="flex justify-between gap-3"><span className="flex items-center gap-2"><span className="swatch" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />{c.name}</span><b>{brl(c.value)}</b></li>)}</ul>
                    </div>
                  ) : <Empty text="Nenhuma saída neste mês ainda." action={() => setTab('movimentos')} />}
                </section>
                <section className="card p-5">
                  <h2 className="font-bold mb-3">Últimos meses</h2>
                  <div style={{ height: 220 }}><ResponsiveContainer><BarChart data={history}><XAxis dataKey="label" /><YAxis width={50} /><Tooltip formatter={(v: any) => brl(v)} /><Legend /><Bar dataKey="income" name="Entrou" fill={GREEN} radius={[6, 6, 0, 0]} /><Bar dataKey="expense" name="Saiu" fill={ROSE} radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div>
                </section>
              </div>

              {investments.length > 0 && <section className="card p-5">
                <div className="flex justify-between items-center"><h2 className="font-bold">Investimentos</h2><button className="link" onClick={() => setTab('investimentos')}>Ver carteira</button></div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
                  <div><div className="muted text-xs font-bold uppercase">Valor atual</div><div className="text-xl font-extrabold mt-1">{brl(invSummary.totalCurrent)}</div></div>
                  <div><div className="muted text-xs font-bold uppercase">Aplicado</div><div className="text-xl font-extrabold mt-1">{brl(invSummary.totalInvested)}</div></div>
                  <div><div className="muted text-xs font-bold uppercase">Retorno total</div><div className={`text-xl font-extrabold mt-1 ${invSummary.totalReturn >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{invSummary.totalReturn >= 0 ? '+' : ''}{brl(invSummary.totalReturn)} <span className="text-xs font-bold">({invSummary.totalReturnPct}%)</span></div></div>
                  <div><div className="muted text-xs font-bold uppercase">Rendimentos</div><div className="text-xl font-extrabold mt-1">{brl(invSummary.income)}</div></div>
                </div>
              </section>}

              {goals.length > 0 && <section className="card p-5">
                <div className="flex justify-between items-center"><h2 className="font-bold">Suas metas <span className="muted text-xs font-normal">{brl(goalsTotals.saved)} de {brl(goalsTotals.target)}</span></h2><button className="link" onClick={() => setTab('metas')}>Ver todas</button></div>
                <div className="progress mt-3"><div style={{ width: Math.min(100, goalsTotals.pct) + '%' }} /></div>
                <div className="muted text-xs mt-1">{goalsTotals.done} de {goalsTotals.count} concluídas • faltam {brl(goalsTotals.remaining)}</div>
                <div className="mt-4 space-y-4">{goals.slice(0, 3).map(g => <div key={g.id} className="flex items-center justify-between gap-2 text-sm"><b>{g.name}</b><span className="muted">{brl(g.saved)} de {brl(g.target)}${g.autoMonthly > 0 ? ` • guardando ${brl(g.autoMonthly)} por mês você chega lá` : ''}</span></div>)}</div>
              </section>}
            </div>
          )}

          {tab === 'movimentos' && <Movimentos userId={uid} tx={tx} month={month} reload={reload} show={show} expenseCats={expenseCats} incomeCats={incomeCats} recurrences={recurrences} launches={launches} isPro={isPro} requirePro={requirePro} enqueueDelete={enqueueDelete} />}
          {tab === 'contas' && <Contas userId={uid} bills={bills} bsum={bsum} month={month} reload={reload} show={show} enqueueDelete={enqueueDelete} />}
          {tab === 'cartoes' && <Cartoes userId={uid} cards={cards} purchases={cardPurchases} payments={cardPayments} month={month} expenseCats={expenseCats} reload={reload} show={show} enqueueDelete={enqueueDelete} />}
          {tab === 'metas' && <Metas userId={uid} goals={goals} reload={reload} show={show} isPro={isPro} requirePro={requirePro} enqueueDelete={enqueueDelete} />}
          {tab === 'resumo' && <Resumo userId={uid} s={s} history={history12} tx={tx} month={month} budgets={budgets} bstatus={bstatus} fc={fc} expenseCats={expenseCats} reload={reload} show={show} goals={goals} isPro={isPro} requirePro={requirePro} />}
          {tab === 'investimentos' && <Investimentos userId={uid} investments={investments} allTx={invTx} reload={reload} show={show} />}
          {tab === 'pro' && <ProView pro={pro} checkout={checkout} checkoutConfigured={isCheckoutConfigured(checkout)} licenseApi={licenseApi} licenseApiConfigured={isLicenseApiConfigured(licenseApi)} reload={reload} show={show} goTab={setTab} />}
          {tab === 'perfil' && <Perfil auth={auth} name={name} setName={setName} show={show} isPro={isPro} pro={pro} goPro={() => setTab('pro')} syncState={syncState} runSync={runSync} checkout={checkout} />}
          {tab === 'config' && <Config userId={uid} dark={dark} setDark={setDark} categories={categories} bills={bills} payments={payments} reload={reload} show={show} tx={tx} isPro={isPro} accent={accent} setAccent={setAccent} requirePro={requirePro} checkoutUrl={checkoutUrl} setCheckoutUrl={setCheckoutUrl} licenseApiUrl={licenseApiUrl} setLicenseApiUrl={setLicenseApiUrl} goPro={() => setTab('pro')} goPerfil={() => setTab('perfil')} pro={pro} enqueueDelete={enqueueDelete} />}
        </main>
      </div>

      <nav className="bottomnav md:hidden">
        {NAV.filter(([k]: any) => k !== 'config').map(([k, l, Icon]: any) => <button key={k} onClick={() => setTab(k)} data-active={tab === k}><Icon size={20} /><span>{k === 'pro' ? 'Pro' : k === 'investimentos' ? 'Investir' : l.split(' ')[0]}</span></button>)}
      </nav>
      {showUpsell && (
        <div className="modal-backdrop" onClick={() => setShowUpsell(false)}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <button className="iconbtn absolute top-3 right-3" aria-label="Fechar" onClick={() => setShowUpsell(false)}><X size={16} /></button>
            <div className="pro-hero !p-5 text-center">
              <Crown size={28} className="mx-auto" />
              <div className="font-extrabold text-xl mt-2">Recurso do Pro</div>
              <p className="text-sm opacity-90 mt-1">Por {brl(PRO_PRICE_BRL)}/mês: resumo anual avançado, nota de organização, metas automáticas, Excel, temas premium.</p>
              <a className="btn-white w-full mt-4" href={checkout} target="_blank" rel="noreferrer">Assinar pela Cakto <ExternalLink size={15} /></a>
              <button className="btn-ghost w-full mt-2" onClick={() => { setShowUpsell(false); setTab('pro') }}>Já paguei — ativar com minha chave</button>
              {!isCheckoutConfigured(checkout) && <p className="text-xs opacity-80 mt-2">Dono do app: configure o link da Cakto em Ajustes.</p>}
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function Logo() { return <div className="flex items-center gap-3 px-1 py-2"><div className="logo-mark"><Wallet size={20} /></div><div><div className="font-extrabold text-lg leading-none">NoAzul</div><div className="muted text-xs mt-1">suas finanças no azul</div></div></div> }
function Stat({ icon, label, value, tone }: any) { return <div className="card p-5"><div className={`stat-icon ${tone}`}>{icon}</div><div className="muted text-xs font-bold uppercase mt-3">{label}</div><div className="text-2xl font-extrabold mt-1">{value}</div></div> }
function Empty({ text, action }: any) { return <div className="empty"><p className="muted text-sm">{text}</p>{action && <button className="btn mt-3" onClick={action}><Plus size={16} /> Adicionar</button>}</div> }
function Field({ label, value, onChange, placeholder, type = 'text' }: any) { return <label className="block"><div className="label">{label}</div><input className="input" type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></label> }
function GoalBar({ g }: any) { const p = goalProgress(g); return <div><div className="flex justify-between text-sm"><b>{g.name}</b><span className="muted">{brl(g.saved)} de {brl(g.target)}</span></div><div className="progress"><div style={{ width: p.pct + '%' }} /></div><div className="muted text-xs mt-1">{p.done ? 'Meta alcançada! Parabéns.' : `${p.pct}% • faltam ${brl(p.remaining)}${g.perMonth ? ` • guardando ${brl(g.perMonth)} por mês você chega lá` : ''}`}</div></div> }
function BudgetBar({ b }: any) { const col = b.status === 'estourou' ? '#E11D63' : b.status === 'atencao' ? '#F59E0B' : GREEN; return <div><div className="flex justify-between text-sm"><b>{b.category}</b><span className="muted">{brl(b.spent)} de {brl(b.limit)}</span></div><div className="progress"><div style={{ width: Math.min(100, b.pct) + '%', background: col }} /></div><div className="text-xs mt-1" style={{ color: col }}>{b.status === 'estourou' ? `Passou ${brl(-b.remaining)} do limite` : b.status === 'atencao' ? `Faltam ${brl(b.remaining)} do limite` : `Ainda pode gastar ${brl(b.remaining)}`}</div></div> }

function Movimentos({ userId, tx, month, reload, show, expenseCats, incomeCats, recurrences, launches, isPro, requirePro, enqueueDelete }: any) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<any>({ description: '', amount: '', type: 'out', category: expenseCats[1] || 'Alimentação', date: today() })
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all')
  const cats = form.type === 'in' ? incomeCats : expenseCats
  const list = tx.filter((t: any) => monthKey(t.date) === month)
    .filter((t: any) => filter === 'all' || t.type === filter)
    .filter((t: any) => t.description.toLowerCase().includes(search.toLowerCase()) || t.category.toLowerCase().includes(search.toLowerCase()))
  useEffect(() => { if (!cats.includes(form.category)) setForm((f: any) => ({ ...f, category: cats[0] })) }, [form.type])
  const save = async () => {
    const t: Transaction = { id: editingId || newId(), description: form.description.trim(), amount: num(form.amount), type: form.type, category: form.category, date: form.date, createdAt: new Date().toISOString() }
    const errs = validateTransaction(t); if (errs.length) return show(errs[0])
    try { await addTransaction({ ...t, userId }); await reload(); setEditingId(null); setForm({ description: '', amount: '', type: 'out', category: expenseCats[1] || 'Alimentação', date: today() }); show(editingId ? 'Alteração salva' : (t.type === 'in' ? 'Entrada adicionada' : 'Saída adicionada')) } catch (e: any) { show(e?.message || 'Não foi possível salvar. Tente de novo.') }
  }
  const edit = (t: any) => { setEditingId(t.id); setForm({ description: t.description, amount: String(t.amount).replace('.', ','), type: t.type, category: t.category, date: t.date }); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  return <div className="space-y-5">
    <section className="card p-5 md:p-6">
      <h2 className="font-bold text-lg">{editingId ? 'Editar lançamento' : 'Adicionar'}</h2>
      <p className="muted text-sm">Exemplo: Salário, Supermercado, Ônibus, Aluguel.</p>
      <div className="segment mt-4">
        <button data-active={form.type === 'in'} onClick={() => setForm({ ...form, type: 'in' })}>Entrou</button>
        <button data-active={form.type === 'out'} onClick={() => setForm({ ...form, type: 'out' })}>Saiu</button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mt-4">
        <Field label="O que foi?" value={form.description} onChange={(v: any) => setForm({ ...form, description: v })} placeholder="Ex.: Supermercado" />
        <Field label="Quanto (R$)?" value={form.amount} onChange={(v: any) => setForm({ ...form, amount: v })} placeholder="0,00" />
        <Field label="Data" value={form.date} onChange={(v: any) => setForm({ ...form, date: v })} type="date" />
      </div>
      <div className="label mt-4">Categoria</div>
      <div className="chips">{cats.map((c: string) => <button key={c} className="chip" data-active={form.category === c} onClick={() => setForm({ ...form, category: c })}>{c}</button>)}</div>
      <div className="flex gap-2 mt-5 flex-wrap"><button className="btn w-full sm:w-auto" onClick={save}><Plus size={17} /> {editingId ? 'Salvar alterações' : 'Salvar'}</button>{editingId && <button className="btn-ghost" onClick={() => { setEditingId(null); setForm({ description: '', amount: '', type: 'out', category: expenseCats[1] || 'Alimentação', date: today() }) }}>Cancelar</button>}</div>
    </section>

    <Recorrencias userId={userId} recurrences={recurrences} launches={launches} month={month} reload={reload} show={show} expenseCats={expenseCats} incomeCats={incomeCats} isPro={isPro} requirePro={requirePro} enqueueDelete={enqueueDelete} />
</div>
}

function Recorrencias({ userId, recurrences, launches, month, reload, show, expenseCats, incomeCats, isPro, requirePro, enqueueDelete }: any) {
  const [form, setForm] = useState<any>({ description: '', amount: '', type: 'in', category: 'Salário', day: '5' })
  const cats = form.type === 'in' ? incomeCats : expenseCats
  const save = async () => {
    if (!isPro && recurrences.filter((r: any) => r.active).length >= FREE_LIMITS.recurrences) return requirePro()
    if (!form.description.trim() || !num(form.amount)) return show('Informe o nome e o valor')
    try { await upsertRecurrence({ id: newId(), userId, description: form.description.trim(), amount: num(form.amount), type: form.type, category: form.category, day: Number(form.day) || 1, active: true, createdAt: new Date().toISOString() }); await reload(); setForm({ description: '', amount: '', type: 'in', category: 'Salário', day: '5' }); show('Todo mês entra automaticamente') } catch (e: any) { show(e?.message || 'Não foi possível salvar. Tente de novo.') }
  }
  const launch = async (r: any) => {
    if (isRecurrenceLaunched(launches, r, month)) return show('Já lançado neste mês')
    try { await addTransaction({ id: newId(), userId, description: r.description, amount: r.amount, type: r.type, category: r.category, date: recurrenceDate(r, month), createdAt: new Date().toISOString() }); await markRecurrenceLaunched(r.id, month, userId); await reload(); show('Lançado em ' + monthLabel(month)) } catch (e: any) { show(e?.message || 'Não foi possível lançar. Tente de novo.') }
  }
  return <section className="card p-5 md:p-6">
    <h2 className="font-bold text-lg flex items-center gap-2"><CalendarClock size={19} /> Todo mês entra ou sai</h2>
    <p className="muted text-sm">Ex.: salário todo dia 5, Netflix todo dia 10. Ele entra sozinho no mês.</p>
    <div className="grid sm:grid-cols-2 gap-3 mt-4">
      <Field label="Nome" value={form.description} onChange={(v: any) => setForm({ ...form, description: v })} placeholder="Ex.: Salário" />
      <Field label="Valor (R$)" value={form.amount} onChange={(v: any) => setForm({ ...form, amount: v })} placeholder="0,00" />
      <Field label="Dia do mês" value={form.day} onChange={(v: any) => setForm({ ...form, day: v })} type="number" />
      <label className="block"><div className="label">Tipo</div><select className="input" value={form.type} onChange={e => setForm({ ...form, type: e.target.value, category: e.target.value === 'in' ? 'Salário' : 'Assinaturas' })}><option value="in">Entra todo mês</option><option value="out">Sai todo mês</option></select></label>
    </div>
    <div className="chips mt-3">{cats.map((c: string) => <button key={c} className="chip" data-active={form.category === c} onClick={() => setForm({ ...form, category: c })}>{c}</button>)}</div>
    <button className="btn mt-4" onClick={save}><Plus size={17} /> Criar recorrência</button>
    {recurrences.length > 0 && <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--border)' }}>{recurrences.map((r: any) => {
      const launched = isRecurrenceLaunched(launches, r, month)
      return <div key={r.id} className="txrow"><div className={`tx-icon ${r.type}`}><CalendarClock size={16} /></div><div className="flex-1"><div className="font-bold">{r.description}</div><div className="muted text-xs">Dia {r.day} • {r.category} • {launched ? 'já entrou em ' + monthLabel(month) : 'pendente em ' + monthLabel(month)}</div></div><b>{brl(r.amount)}</b><button className="btn-ghost" disabled={launched} onClick={() => launch(r)}>Lançar</button><button className="iconbtn" aria-label="Apagar recorrência" onClick={async () => { if (!await confirm('Apagar esta recorrência?')) return; try { await deleteRecurrence(r.id, userId); enqueueDelete('recurrences', r); await reload() } catch (e:any) { show(e?.message || 'Não foi possível excluir.') } }}><Trash2 size={15} /></button></div>
    })}</div>
  </section>
}

function Contas({ userId, bills, bsum, month, reload, show, enqueueDelete }: any) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<any>({ name: '', amount: '', dueDay: '10' })
  const save = async (name = form.name) => {
    if (!name.trim() || !num(form.amount)) return show('Informe o nome e o valor da conta')
    try { await upsertFixedBill({ id: editingId || newId(), userId, name: name.trim(), amount: num(form.amount), dueDay: Number(form.dueDay) || 1, category: 'Contas da casa', createdAt: new Date().toISOString() }); await reload(); setEditingId(null); setForm({ name: '', amount: '', dueDay: '10' }); show('Conta fixa salva') } catch (e: any) { show(e?.message || 'Não foi possível salvar. Tente de novo.') }
  }
  const edit = (b: any) => { setEditingId(b.id); setForm({ name: b.name, amount: String(b.amount).replace('.', ','), dueDay: String(b.dueDay) }) }
  return <div className="space-y-5">
    <section className="card p-5 md:p-6">
      <h2 className="font-bold text-lg">{editingId ? 'Editar conta fixa' : 'Contas que todo mês chegam'}</h2>
      <p className="muted text-sm">Aluguel, luz, internet, celular... Assim você sabe quanto realmente sobra.</p>
      <div className="grid sm:grid-cols-3 gap-3 mt-4">
        <Field label="Nome da conta" value={form.name} onChange={(v: any) => setForm({ ...form, name: v })} placeholder="Ex.: Energia" />
        <Field label="Valor (R$)" value={form.amount} onChange={(v: any) => setForm({ ...form, amount: v })} placeholder="0,00" />
        <Field label="Vence dia" value={form.dueDay} onChange={(v: any) => setForm({ ...form, dueDay: v })} type="number" />
      </div>
      <div className="chips mt-3">{BILL_SUGGESTIONS.map(b => <button key={b} className="chip" onClick={() => setForm({ ...form, name: b })}>{b}</button>)}</div>