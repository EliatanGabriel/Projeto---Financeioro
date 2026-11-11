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
import { SYNC_ENTITIES, canonicalHash, resolveConflict } from './sync/engine'
import { legacyCounts, reassignLegacyUser } from './database/db'
import { BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend } from 'recharts'
import type { Transaction, FixedBill, Goal, Budget, BillPayment, Recurrence, Category, Investment, InvestmentTransaction, CreditCard, CreditCardPurchase, CreditCardPayment } from './types'

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
  // Pro: aporte automático das metas
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
function parseCsvImport(text: string): Transaction[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim())
  const out: Transaction[] = []
  for (const line of lines) {
    const parts = (line.includes(';') ? line.split(';') : line.split(',')).map(p => p.trim().replace(/^"|"$/g, ''))
    if (parts.length < 5 || !/^\d{4}-\d{2}-\d{2}/.test(parts[0])) continue
    const val = num(parts[4]); if (!val) continue
    out.push({ id: newId(), description: parts[1] || 'Importado', amount: val, type: /entr|in/i.test(parts[2]) ? 'in' : 'out', category: parts[3] || 'Outros', date: parts[0].slice(0, 10), createdAt: new Date().toISOString() })
  }
  return out
}

export default function App() {
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
    } else setPro({ activated: false, holder: '', expiresAt: null, plan: '', key: '' })
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
      const state = await syncAll(makeSyncStore(authUser.id), client, SYNC_ENTITIES, setSyncState)
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
      const counts = await legacyCounts(legacy)
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
    // Renovação automática: se a licença guardada expirou ou vence em ≤7 dias, busca a nova no servidor.
    try {
      const savedKey = await getSetting('licenseKey'); if (!savedKey) return
      const v = await verifyLicense(savedKey, getDeviceId())
      const days = v.payload ? proDaysLeft(v.payload) : 0
      if (v.ok && isProActive(v.payload) && days > 7) return
      const savedEmail = await getSetting('caktoEmail'); const api = getLicenseApiUrl(await getSetting('licenseApiUrl'))
      if (!savedEmail || !isLicenseApiConfigured(api)) return
      const r = await fetchAutoLicense(api, savedEmail, getDeviceId())
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
  const show = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2600) }

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
      {migration && authUser && <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"><div className="card p-6 max-w-md w-full space-y-4"><div className="font-extrabold text-lg">Importar dados deste aparelho?</div><p className="muted text-sm leading-relaxed">Encontramos <b>{migration.legacyTotal} registro(s)</b> antigos neste aparelho. Importar associa tudo à sua conta e envia para a nuvem. Nada é apagado antes da confirmação.{migration.ambiguous > 0 && <><br /><br />Atenção: há <b>{migration.ambiguous} registro(s) com identidade ambígua</b> — a importação será interrompida para revisão manual.</>}</p><div className="flex gap-2"><button className="btn" disabled={migration.ambiguous > 0} onClick={async () => { try { const moved = await reassignLegacyUser(getDeviceId(), authUser.id); if (moved > 0) { await runSync(); show('Dados importados') } setMigration(null); await reload() } catch (e: any) { show(e.message) } }}>Importar e sincronizar</button><button className="btn-ghost" onClick={() => setMigration(null)}>Agora não</button></div></div></div>}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 flex-col p-5 gap-1 z-20 sidebar">
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

        <main className="max-w-5xl mx-auto px-4 md:px-7 pb-28 md:pb-10 pt-2">
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
                  <div className="mt-3 space-y-2">{steps.map(st => <button key={st.label} onClick={() => setTab(st.tab as Tab)} className="flex items-center gap-3 w-full text-left text-sm py-1"><span className={`check ${st.done ? 'done' : ''}`}>{st.done && <Check size={13} />}</span><span className={st.done ? 'muted line-through' : 'font-medium'}>{st.label}</span></button>)}</div>
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
                      <div className="stat-icon up"><PiggyBank size={20} /></div>
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

              {bstatus.length > 0 && <section className="card p-5"><div className="flex justify-between items-center"><h2 className="font-bold">Seus limites</h2><button className="link" onClick={() => setTab('resumo')}>Ajustar</button></div><div className="mt-3 space-y-3">{bstatus.slice(0, 3).map(b => <BudgetBar key={b.category} b={b} />)}</div></section>}

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
                <div className="mt-4 border-t pt-3 space-y-3" style={{ borderColor: 'var(--border)' }}>{invSummary.perInvestment.slice(0, 3).map((inv: any) => <div key={inv.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0"><div className="font-bold text-sm truncate">{inv.name}{inv.ticker ? ` (${inv.ticker})` : ''}</div><div className="muted text-xs truncate">{inv.category}{inv.institution ? ` • ${inv.institution}` : ''}</div></div>
                  <div className="text-right shrink-0"><div className="font-bold text-sm">{brl(inv.currentValue)}</div><div className={`text-xs font-bold ${inv.gain >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{inv.gain >= 0 ? '+' : ''}{brl(inv.gain)} ({inv.pct}%)</div></div>
                </div>)}</div>
              </section>}

              {goals.length > 0 && <section className="card p-5">
                <div className="flex justify-between items-center"><h2 className="font-bold">Suas metas <span className="muted text-xs font-normal">{brl(goalsTotals.saved)} de {brl(goalsTotals.target)}</span></h2><button className="link" onClick={() => setTab('metas')}>Ver todas</button></div>
                <div className="progress mt-3"><div style={{ width: Math.min(100, goalsTotals.pct) + '%' }} /></div>
                <div className="muted text-xs mt-1">{goalsTotals.done} de {goalsTotals.count} concluídas • faltam {brl(goalsTotals.remaining)}</div>
                <div className="mt-4 space-y-4">{goals.slice(0, 3).map(g => <GoalBar key={g.id} g={g} />)}</div>
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
              <p className="text-sm opacity-90 mt-1">Por {brl(PRO_PRICE_BRL)}/mês: resumo anual avançado, nota de organização, metas automáticas, Excel, PDF anual e temas premium.</p>
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
function GoalBar({ g }: any) { const p = goalProgress(g); return <div><div className="flex justify-between text-sm"><b>{g.name}</b><span className="muted">{brl(g.saved)} de {brl(g.target)}</span></div><div className="progress"><div style={{ width: p.pct + '%' }} /></div><div className="muted text-xs mt-1">{p.done ? 'Meta alcançada! Parabéns.' : `${p.pct}% • faltam ${brl(p.remaining)}${p.perMonth ? ` • guardando ${brl(p.perMonth)} por mês você chega lá` : ''}`}</div></div> }
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

    <section className="card p-5">
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="search"><Search size={16} /><input placeholder="Buscar..." value={search} onChange={e => setSearch(e.target.value)} /></div>
        <select className="input sm:!w-auto" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Tudo</option><option value="in">Só entradas</option><option value="out">Só saídas</option></select>
      </div>
      {!list.length ? <Empty text="Nada por aqui neste mês. Adicione acima quando gastar ou receber." /> : list.map((t: any) => (
        <div key={t.id} className="txrow">
          <div className={`tx-icon ${t.type}`}><TrendingUp size={16} /></div>
          <div className="flex-1 min-w-0"><div className="font-bold truncate">{t.description}</div><div className="muted text-xs">{t.category} • {new Date(t.date + 'T12:00:00').toLocaleDateString('pt-BR')}</div></div>
          <b className={t.type === 'in' ? 'text-emerald-600' : ''}>{t.type === 'in' ? '+' : '−'} {brl(t.amount)}</b>
          <button className="iconbtn" onClick={() => edit(t)} aria-label="Editar"><Pencil size={15} /></button>
          <button className="iconbtn" onClick={async () => { if (!confirm('Apagar este lançamento?')) return; try { await deleteTransaction(t.id, userId); enqueueDelete('transactions', t); await reload() } catch (e:any) { show(e?.message || 'Não foi possível excluir.') } }} aria-label="Apagar"><Trash2 size={15} /></button>
        </div>
      ))}
    </section>
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
      return <div key={r.id} className="txrow"><div className={`tx-icon ${r.type}`}><CalendarClock size={16} /></div><div className="flex-1"><div className="font-bold">{r.description}</div><div className="muted text-xs">Dia {r.day} • {r.category} • {launched ? 'já entrou em ' + monthLabel(month) : 'pendente em ' + monthLabel(month)}</div></div><b>{brl(r.amount)}</b><button className="btn-ghost" disabled={launched} onClick={() => launch(r)}>Lançar</button><button className="iconbtn" aria-label="Apagar recorrência" onClick={async () => { if (!confirm('Apagar esta recorrência?')) return; try { await deleteRecurrence(r.id, userId); enqueueDelete('recurrences', r); await reload() } catch (e:any) { show(e?.message || 'Não foi possível excluir.') } }}><Trash2 size={15} /></button></div>
    })}</div>}
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
      <div className="flex gap-2 mt-4 flex-wrap"><button className="btn" onClick={() => save()}><Plus size={17} /> {editingId ? 'Salvar alterações' : 'Salvar conta'}</button>{editingId && <button className="btn-ghost" onClick={() => { setEditingId(null); setForm({ name: '', amount: '', dueDay: '10' }) }}>Cancelar</button>}</div>
    </section>
    <section className="card p-5">
      <div className="flex flex-wrap justify-between gap-2"><h2 className="font-bold">Suas contas em {monthLabel(month)}</h2><span className="text-sm"><b className="text-emerald-600">Pagou {brl(bsum.paidTotal)}</b> • <b className="text-rose-600">Falta {brl(bsum.pendingTotal)}</b></span></div>
      {!bills.length ? <Empty text="Você ainda não cadastrou nenhuma conta fixa." /> : bsum.items.map((b: any) => (
        <div key={b.id} className={`txrow ${b.paid ? 'opacity-60' : ''}`}>
          <label className="flex items-center gap-2 shrink-0"><input type="checkbox" checked={b.paid} onChange={async e => { try { await setBillPaid(b.id, month, e.target.checked, userId); await reload(); show(e.target.checked ? 'Marcada como paga' : 'Marcada como pendente') } catch (err:any) { show(err?.message || 'Não foi possível salvar.'); await reload() } }} /><span className="text-xs font-bold">Paga</span></label>
          <div className={`tx-icon ${b.paid ? 'in' : 'out'}`}>{b.paid ? <Check size={16} /> : <Receipt size={16} />}</div>
          <div className="flex-1"><div className={`font-bold ${b.paid ? 'line-through' : ''}`}>{b.name}</div><div className="muted text-xs">Vence dia {b.dueDay}{b.overdue ? ' • venceu!' : b.dueSoon ? ` • vence em ${b.daysToDue} dia(s)` : ''}</div></div>
          <b>{brl(b.amount)}</b>
          <button className="iconbtn" aria-label="Editar conta fixa" onClick={() => edit(b)}><Pencil size={15} /></button>
          <button className="iconbtn" aria-label="Apagar conta fixa" onClick={async () => { if (!confirm('Apagar esta conta?')) return; try { await deleteFixedBill(b.id, userId); enqueueDelete('fixed_bills', b); await reload() } catch (e:any) { show(e?.message || 'Não foi possível excluir.') } }}><Trash2 size={15} /></button>
        </div>
      ))}
    </section>
  </div>
}

function Cartoes({ userId, cards, purchases, payments, month, expenseCats, reload, show, enqueueDelete }: any) {
  const [selectedId, setSelectedId] = useState('')
  const [cardForm, setCardForm] = useState<any>({ name: '', brand: '', limit: '', closingDay: '5', dueDay: '12', color: '#0E9F6E' })
  const [editingCard, setEditingCard] = useState<string | null>(null)
  const [purchaseForm, setPurchaseForm] = useState<any>({ description: '', category: 'Outros', total: '', installments: '1', firstDate: new Date().toISOString().slice(0, 10), notes: '' })
  const selected = cards.find((c: any) => c.id === selectedId) || cards[0]
  const sum = selected ? cardSummary(selected, purchases, payments, month) : null
  const resetCard = () => { setEditingCard(null); setCardForm({ name: '', brand: '', limit: '', closingDay: '5', dueDay: '12', color: '#0E9F6E' }) }
  const saveCard = async () => {
    if (!cardForm.name.trim() || !num(cardForm.limit)) return show('Informe o nome e o limite do cartão')
    const id = editingCard || newId()
    try {
      await upsertCreditCard({ id, userId, name: cardForm.name.trim(), brand: cardForm.brand.trim(), limitAmount: num(cardForm.limit), closingDay: Number(cardForm.closingDay) || 5, dueDay: Number(cardForm.dueDay) || 12, color: cardForm.color, createdAt: new Date().toISOString() })
      await reload(); setSelectedId(id); resetCard(); show('Cartão salvo')
    } catch (e: any) { show(e?.message || 'Não foi possível salvar o cartão.') }
  }
  const editCard = (c: any) => { setEditingCard(c.id); setCardForm({ name: c.name, brand: c.brand || '', limit: String(c.limitAmount).replace('.', ','), closingDay: String(c.closingDay), dueDay: String(c.dueDay), color: cardColor(c) }) }
  const removeCard = async (c: any) => {
    if (!confirm(`Apagar o cartão ${c.name} e suas compras?`)) return
    try {
      for (const p of purchases.filter((x: any) => x.cardId === c.id)) enqueueDelete('credit_card_purchases', p)
      enqueueDelete('credit_cards', c)
      await deleteCreditCard(c.id, userId); setSelectedId(''); await reload(); show('Cartão apagado')
    } catch (e: any) { show(e?.message || 'Não foi possível excluir.') }
  }
  const addPurchase = async () => {
    if (!selected) return show('Cadastre um cartão primeiro')
    if (!purchaseForm.description.trim() || !num(purchaseForm.total)) return show('Informe a descrição e o valor da compra')
    try {
      await upsertCreditCardPurchase({ id: newId(), userId, cardId: selected.id, description: purchaseForm.description.trim(), category: purchaseForm.category || 'Outros', totalAmount: num(purchaseForm.total), installments: Math.max(1, Number(purchaseForm.installments) || 1), firstDate: purchaseForm.firstDate, notes: purchaseForm.notes || '', createdAt: new Date().toISOString() })
      await reload(); setPurchaseForm({ description: '', category: 'Outros', total: '', installments: '1', firstDate: new Date().toISOString().slice(0, 10), notes: '' }); show('Compra adicionada')
    } catch (e: any) { show(e?.message || 'Não foi possível salvar a compra.') }
  }
  return <div className="space-y-5">
    <section className="card p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-bold text-lg">{editingCard ? 'Editar cartão' : 'Cartões de crédito'}</h2><p className="muted text-sm">Acompanhe limite, fatura e compras parceladas.</p></div>{editingCard && <button className="btn-ghost" onClick={resetCard}>Cancelar edição</button>}</div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
        <Field label="Nome do cartão" value={cardForm.name} onChange={(v: any) => setCardForm({ ...cardForm, name: v })} placeholder="Ex.: Nubank" />
        <Field label="Bandeira" value={cardForm.brand} onChange={(v: any) => setCardForm({ ...cardForm, brand: v })} placeholder="Visa, Master..." />
        <Field label="Limite (R$)" value={cardForm.limit} onChange={(v: any) => setCardForm({ ...cardForm, limit: v })} placeholder="0,00" />
        <Field label="Fecha dia" value={cardForm.closingDay} onChange={(v: any) => setCardForm({ ...cardForm, closingDay: v })} type="number" />
        <Field label="Vence dia" value={cardForm.dueDay} onChange={(v: any) => setCardForm({ ...cardForm, dueDay: v })} type="number" />
        <div><div className="label">Cor</div><div className="chips">{['#0E9F6E', '#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#0F172A'].map(c => <button key={c} className="chip" data-active={cardForm.color === c} onClick={() => setCardForm({ ...cardForm, color: c })} aria-label={'Cor ' + c}><span className="swatch" style={{ background: c }} /></button>)}</div></div>
      </div>
      <div className="flex gap-2 mt-4 flex-wrap"><button className="btn" onClick={saveCard}><Plus size={17} /> {editingCard ? 'Salvar alterações' : 'Salvar cartão'}</button></div>
    </section>

    {!cards.length ? <section className="card p-5"><Empty text="Nenhum cartão cadastrado. Adicione um para controlar as faturas." /></section> : <>
      <div className="grid sm:grid-cols-2 gap-4">
        {cards.map((c: any) => { const sm = cardSummary(c, purchases, payments, month); return <button key={c.id} onClick={() => setSelectedId(c.id)} className="card p-5 text-left relative overflow-hidden" style={{ background: 'linear-gradient(135deg, ' + cardColor(c) + ', #0f172a)', color: '#fff', border: selected?.id === c.id ? '2px solid #fff' : '1px solid transparent' }}>
          <div className="flex items-start justify-between gap-2"><div><div className="font-extrabold text-lg">{c.name}</div><div className="text-xs opacity-80">{c.brand || 'Cartão de crédito'} • fecha dia {c.closingDay}</div></div><CreditCardIcon size={22} /></div>
          <div className="mt-5 text-xs opacity-80 uppercase font-bold">Fatura de {monthLabel(month)}</div>
          <div className="text-2xl font-extrabold">{brl(sm.invoice.total)}</div>
          <div className="text-xs opacity-80 mt-1">Vence {new Date(sm.invoice.dueDate + 'T12:00:00').toLocaleDateString('pt-BR')}{sm.invoice.paid ? ' • paga' : ''}</div>
          <div className="mt-3 text-xs opacity-90">Disponível {brl(sm.available)} de {brl(sm.limit)}</div>
          <div className="progress mt-1" style={{ background: 'rgba(255,255,255,.25)' }}><div style={{ width: sm.usedPct + '%', background: '#fff' }} /></div>
        </button> })}
      </div>

      {selected && sum && <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><h2 className="font-bold">Fatura de {monthLabel(month)} — {selected.name}</h2><p className="muted text-sm">Vence em {new Date(sum.invoice.dueDate + 'T12:00:00').toLocaleDateString('pt-BR')} • {sum.invoice.items.length} compra(s)</p></div>
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={sum.invoice.paid} onChange={async e => { try { await setCreditCardPaid(selected.id, month, e.target.checked, userId); if (!e.target.checked) enqueueDelete('credit_card_payments', { id: selected.id + ':' + month, cardId: selected.id, month, userId }); await reload(); show(e.target.checked ? 'Fatura marcada como paga' : 'Fatura reaberta') } catch (err: any) { show(err?.message || 'Não foi possível salvar.') } }} /> Paga</label>
            <button className="iconbtn" aria-label="Editar cartão" onClick={() => editCard(selected)}><Pencil size={15} /></button>
            <button className="iconbtn" aria-label="Apagar cartão" onClick={() => removeCard(selected)}><Trash2 size={15} /></button>
          </div>
        </div>
        <div className="mt-3 flex items-end justify-between gap-3"><div><div className="muted text-xs font-bold uppercase">Total da fatura</div><div className="text-2xl font-extrabold">{brl(sum.invoice.total)}</div></div><div className="text-right text-sm"><div className="muted">Em aberto (limite)</div><b>{brl(sum.outstanding)}</b></div></div>
        <div className="mt-4 border-t pt-3 space-y-2" style={{ borderColor: 'var(--border)' }}>
          {sum.invoice.items.length ? sum.invoice.items.map((it: any) => <div key={it.purchase.id + ':' + it.installment.number} className="flex items-center gap-3 text-sm">
            <div className="tx-icon out"><CreditCardIcon size={15} /></div>
            <div className="flex-1 min-w-0"><div className="font-bold truncate">{it.purchase.description}</div><div className="muted text-xs">{it.purchase.category} • parcela {it.installment.number}/{it.purchase.installments} • compra em {new Date(it.purchase.firstDate + 'T12:00:00').toLocaleDateString('pt-BR')}</div></div>
            <b className="shrink-0">{brl(it.installment.amount)}</b>
            <button className="iconbtn" aria-label="Apagar compra" onClick={async () => { if (!confirm('Apagar esta compra e todas as parcelas?')) return; try { await deleteCreditCardPurchase(it.purchase.id, userId); enqueueDelete('credit_card_purchases', it.purchase); await reload() } catch (e: any) { show(e?.message || 'Não foi possível excluir.') } }}><Trash2 size={14} /></button>
          </div>) : <p className="muted text-sm">Nenhuma compra nesta fatura.</p>}
        </div>
        <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          <h3 className="font-bold">Adicionar compra</h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            <Field label="Descrição" value={purchaseForm.description} onChange={(v: any) => setPurchaseForm({ ...purchaseForm, description: v })} placeholder="Ex.: Mercado" />
            <div><div className="label">Categoria</div><select className="input" value={purchaseForm.category} onChange={e => setPurchaseForm({ ...purchaseForm, category: e.target.value })}>{expenseCats.map((c: string) => <option key={c} value={c}>{c}</option>)}</select></div>
            <Field label="Valor total (R$)" value={purchaseForm.total} onChange={(v: any) => setPurchaseForm({ ...purchaseForm, total: v })} placeholder="0,00" />
            <Field label="Parcelas" value={purchaseForm.installments} onChange={(v: any) => setPurchaseForm({ ...purchaseForm, installments: v })} type="number" />
            <Field label="Data da compra" value={purchaseForm.firstDate} onChange={(v: any) => setPurchaseForm({ ...purchaseForm, firstDate: v })} type="date" />
            <Field label="Observação" value={purchaseForm.notes} onChange={(v: any) => setPurchaseForm({ ...purchaseForm, notes: v })} placeholder="Opcional" />
          </div>
          {num(purchaseForm.total) > 0 && Number(purchaseForm.installments) > 1 && <p className="muted text-xs mt-2">Aproximadamente {brl(num(purchaseForm.total) / Math.max(1, Number(purchaseForm.installments)))} por mês.</p>}
          <button className="btn mt-3" onClick={addPurchase}><Plus size={16} /> Adicionar compra</button>
        </div>
      </section>}
    </>}
  </div>
}

function Metas({ userId, goals, reload, show, isPro, requirePro, enqueueDelete }: any) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<any>({ name: '', target: '', saved: '', deadline: '', autoMonthly: '' })
  const [add, setAdd] = useState<Record<string, string>>({})
  const save = async () => {
    if (!editingId && !isPro && goals.length >= FREE_LIMITS.goals) return requirePro()
    if (!form.name.trim() || !num(form.target)) return show('Informe o nome e quanto você quer juntar')
    if (num(form.autoMonthly) > 0 && !isPro) return requirePro()
    try { await upsertGoal({ id: editingId || newId(), userId, name: form.name.trim(), target: num(form.target), saved: num(form.saved || '0'), deadline: form.deadline, autoMonthly: isPro ? num(form.autoMonthly || '0') : 0, createdAt: new Date().toISOString() }); await reload(); setEditingId(null); setForm({ name: '', target: '', saved: '', deadline: '', autoMonthly: '' }); show('Meta salva. Hora de guardar!') } catch (e: any) { show(e?.message || 'Não foi possível salvar. Tente de novo.') }
  }
  const edit = (g: any) => { setEditingId(g.id); setForm({ name: g.name, target: String(g.target).replace('.', ','), saved: String(g.saved).replace('.', ','), deadline: g.deadline || '', autoMonthly: g.autoMonthly ? String(g.autoMonthly).replace('.', ',') : '' }) }
  return <div className="space-y-5">
    <section className="card p-5 md:p-6">
      <h2 className="font-bold text-lg">{editingId ? 'Editar meta' : 'Juntar dinheiro para algo bom'}</h2>
      <p className="muted text-sm">Viagem, reserva para imprevistos, quitar uma dívida... Defina um valor e acompanhe.</p>
      <div className="grid sm:grid-cols-2 gap-3 mt-4">
        <Field label="O que você quer juntar para?" value={form.name} onChange={(v: any) => setForm({ ...form, name: v })} placeholder="Ex.: Viagem" />
        <Field label="Quanto precisa (R$)?" value={form.target} onChange={(v: any) => setForm({ ...form, target: v })} placeholder="0,00" />
        <Field label="Quanto já juntou (R$)?" value={form.saved} onChange={(v: any) => setForm({ ...form, saved: v })} placeholder="0,00" />
        <Field label="Até quando (opcional)" value={form.deadline} onChange={(v: any) => setForm({ ...form, deadline: v })} type="date" />
        <Field label={isPro ? 'Guardar sozinho todo mês (Pro, R$)' : 'Guardar sozinho todo mês (Pro, R$)'} value={form.autoMonthly} onChange={(v: any) => { if (!isPro && num(v) > 0) { requirePro(); return } setForm({ ...form, autoMonthly: v }) }} placeholder={isPro ? 'Ex.: 200,00' : 'Recurso Pro'} />
      </div>
      {!isPro && <p className="muted text-xs mt-2 flex items-center gap-1"><Lock size={12} /> No Pro, a meta guarda esse valor sozinha todo mês.</p>}
      <div className="chips mt-3">{GOAL_SUGGESTIONS.map(g => <button key={g} className="chip" onClick={() => setForm({ ...form, name: g })}>{g}</button>)}</div>
      <div className="flex gap-2 mt-4 flex-wrap"><button className="btn" onClick={save}><Plus size={17} /> {editingId ? 'Salvar alterações' : 'Criar meta'}</button>{editingId && <button className="btn-ghost" onClick={() => { setEditingId(null); setForm({ name: '', target: '', saved: '', deadline: '' }) }}>Cancelar</button>}</div>
    </section>
    <section className="card p-5 space-y-5">
      <h2 className="font-bold">Minhas metas</h2>
      {!goals.length ? <Empty text="Nenhuma meta ainda. Crie a primeira acima." /> : goals.map((g: any) => (
        <div key={g.id}>
          <GoalBar g={g} />
          {g.autoMonthly > 0 && <div className="text-xs mt-1 flex items-center gap-1 text-emerald-600"><Sparkles size={12} /> Guardando sozinha {brl(g.autoMonthly)} todo mês (Pro)</div>}
          <div className="flex gap-2 mt-2">
            <input className="input" placeholder="Adicionar R$" value={add[g.id] || ''} onChange={e => setAdd({ ...add, [g.id]: e.target.value })} inputMode="decimal" />
            <button className="btn" onClick={async () => { const v = num(add[g.id] || ''); if (!v) return show('Informe um valor'); try { await upsertGoal({ ...g, userId, saved: g.saved + v }); await reload(); setAdd({ ...add, [g.id]: '' }); show('Valor adicionado. Continue assim!') } catch (e: any) { show(e?.message || 'Não foi possível salvar. Tente de novo.') } }}>Guardar</button>
            <button className="iconbtn" aria-label="Editar meta" onClick={() => edit(g)}><Pencil size={15} /></button>
            <button className="iconbtn" aria-label="Apagar meta" onClick={async () => { if (!confirm('Apagar esta meta?')) return; try { await deleteGoal(g.id, userId); enqueueDelete('goals', g); await reload() } catch (e:any) { show(e?.message || 'Não foi possível excluir.') } }}><Trash2 size={15} /></button>
          </div>
        </div>
      ))}
    </section>
  </div>
}

function BudgetRow({ cat, budget, reload, show, userId }: any) {
  const [val, setVal] = useState(budget ? String(budget.limit).replace('.', ',') : '')
  useEffect(() => { setVal(budget ? String(budget.limit).replace('.', ',') : '') }, [budget?.limit, cat])
  return <div className="flex items-center gap-2 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
    <span className="w-32 shrink-0 text-sm font-medium">{cat}</span>
    <input className="input" placeholder="Sem limite" value={val} onChange={e => setVal(e.target.value)} inputMode="decimal" />
    <button className="btn-ghost shrink-0" onClick={async () => { try { await setBudget(cat, num(val), userId); await reload(); show(num(val) ? 'Limite salvo' : 'Limite removido') } catch (e: any) { show(e?.message || 'Não foi possível salvar. Tente de novo.') } }}>Salvar</button>
  </div>
}

function Resumo({ userId, s, history, tx, month, budgets, bstatus, fc, expenseCats, reload, show, goals, isPro, requirePro }: any) {
  const [view, setView] = useState<'mes' | 'ano'>('mes')
  const bmap = Object.fromEntries(budgets.map((b: any) => [b.category, b]))
  if (view === 'ano') return <div className="space-y-5"><div className="segment"><button data-active={false} onClick={() => setView('mes')}>Do mês</button><button data-active="true" onClick={() => setView('ano')}>Ano todo</button></div><AnnualView tx={tx} isPro={isPro} requirePro={requirePro} show={show} /></div>
  const pdf = async () => exportPDFReport(`NoAzul — ${monthLabel(month)}`, [
    `Entrou: ${brl(s.income)}`, `Saiu: ${brl(s.expense)}`, `Sobrou: ${brl(s.balance)}`, `Contas fixas: ${brl(s.billsTotal)}`, `Previsão fim do mês: ${brl(fc.projectedBalance)}`, '',
    ...s.byCategory.map((c: any) => `${c.name}: ${brl(c.value)}`), '',
    ...bstatus.map((b: any) => `Limite ${b.category}: ${brl(b.spent)} de ${brl(b.limit)} (${b.pct}%)`), '',
    ...goals.map((g: any) => `Meta ${g.name}: ${brl(g.saved)} de ${brl(g.target)}`),
    ...tx.filter((t: any) => monthKey(t.date) === month).map((t: any) => `${t.date} ${t.description} ${t.type === 'in' ? '+' : '-'}${brl(t.amount)}`),
  ], `noazul-${month}.pdf`)
  const xlsx = async () => { if (!requirePro()) return; await exportXLSX(tx.filter((t: any) => monthKey(t.date) === month).map((t: any) => ({ Data: t.date, Descrição: t.description, Tipo: t.type === 'in' ? 'Entrou' : 'Saiu', Categoria: t.category, Valor: t.amount })), `noazul-${month}.xlsx`); show('Excel baixado') }
  return <div className="space-y-5">
    <div className="segment"><button data-active="true" onClick={() => setView('mes')}>Do mês</button><button data-active={false} onClick={() => setView('ano')}>Ano todo</button></div>
    <div className="grid sm:grid-cols-3 gap-4">
      <Stat icon={<TrendingUp size={20} />} label="Entrou no mês" value={brl(s.income)} tone="up" />
      <Stat icon={<TrendingDown size={20} />} label="Saiu no mês" value={brl(s.expense)} tone="down" />
      <Stat icon={<PiggyBank size={20} />} label="Sobrou" value={brl(s.balance)} tone="neutral" />
    </div>
    <section className="card p-5">
      <h2 className="font-bold">Se continuar assim...</h2>
      <p className="text-sm mt-2 leading-relaxed">Você está gastando cerca de <b>{brl(fc.perDayExpense)} por dia</b>. Até o fim de {monthLabel(month)}, a previsão é sair <b>{brl(fc.projectedExpense)}</b> e sobrar <b>{brl(fc.projectedBalance)}</b> — descontando as contas fixas, <b>{brl(fc.projectedAfterBills)}</b>.</p>
    </section>
    <section className="card p-5">
      <h2 className="font-bold">Limites por categoria</h2>
      <p className="muted text-sm">Defina quanto quer gastar no máximo em cada categoria. Ex.: Alimentação até R$ 800.</p>
      <div className="mt-3">{expenseCats.map((c: string) => <BudgetRow key={c} cat={c} budget={bmap[c]} reload={reload} show={show} userId={userId} />)}</div>
      {bstatus.length > 0 && <div className="mt-5 space-y-3"><h3 className="font-bold text-sm">Como está</h3>{bstatus.map((b: any) => <BudgetBar key={b.category} b={b} />)}</div>}
    </section>
    <section className="card p-5">
      <h2 className="font-bold mb-3">Últimos 12 meses</h2>
      <div style={{ height: 260 }}><ResponsiveContainer><BarChart data={history}><XAxis dataKey="label" /><YAxis width={55} /><Tooltip formatter={(v: any) => brl(v)} /><Legend /><Bar dataKey="income" name="Entrou" fill={GREEN} radius={[6, 6, 0, 0]} /><Bar dataKey="expense" name="Saiu" fill={ROSE} radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div>
    </section>
    <section className="card p-5">
      <h2 className="font-bold mb-3">Onde você mais gastou</h2>
      {!s.byCategory.length ? <p className="muted text-sm">Sem gastos neste mês.</p> : s.byCategory.map((c: any, i: number) => (
        <div key={c.name} className="catrow"><span className="w-36 shrink-0">{c.name}</span><div className="progress flex-1"><div style={{ width: Math.max(4, (c.value / s.expense) * 100) + '%', background: PIE_COLORS[i % PIE_COLORS.length] }} /></div><b className="w-24 text-right">{brl(c.value)}</b></div>
      ))}
      <div className="flex gap-2 flex-wrap mt-5">
        <button className="btn-ghost" onClick={() => exportCSV(tx.filter((t: any) => monthKey(t.date) === month).map((t: any) => ({ Data: t.date, Descrição: t.description, Tipo: t.type === 'in' ? 'Entrou' : 'Saiu', Categoria: t.category, Valor: t.amount })), `noazul-${month}.csv`)}><Download size={15} /> Planilha do mês (CSV)</button>
        <button className="btn-ghost" onClick={() => exportCSV(tx.map((t: any) => ({ Data: t.date, Descrição: t.description, Tipo: t.type === 'in' ? 'Entrou' : 'Saiu', Categoria: t.category, Valor: t.amount })), 'noazul-completo.csv')}><Download size={15} /> Planilha completa</button>
        <button className="btn-ghost" onClick={pdf}><FileText size={15} /> Relatório PDF do mês</button>
        <button className="btn-ghost" onClick={xlsx}><Download size={15} /> Excel do mês {!isPro && <Lock size={12} />}</button>
      </div>
    </section>
  </div>
}

function AnnualView({ tx, isPro, requirePro, show }: any) {
  const [year, setYear] = useState(new Date().getFullYear())
  const a = useMemo(() => annualSummary(tx, year), [tx, year])
  const cmp = useMemo(() => compareAnnual(tx, year), [tx, year])
  const score = useMemo(() => financialScore(tx, year), [tx, year])
  const trend = useMemo(() => spendingTrend(tx), [tx])
  const insights = useMemo(() => proInsights(tx, year), [tx, year])
  const fmt = (v: number) => (v > 0 ? '+' : '') + brl(v)
  const pdfAnnual = async () => { if (!requirePro()) return; await exportPDFReport(`NoAzul — Resumo anual ${year}`, [`Entrou: ${brl(a.income)}`, `Saiu: ${brl(a.expense)}`, `Sobrou: ${brl(a.balance)}`, `Média mensal de gastos: ${brl(a.avgExpense)}`, `Nota: ${score.score}/100 — ${score.label}`, '', ...a.months.map((m: any) => `${m.label}: entrou ${brl(m.income)} • saiu ${brl(m.expense)} • sobrou ${brl(m.balance)}`), '', ...a.byCategory.map((c: any) => `${c.name}: ${brl(c.value)}`), '', ...insights], `noazul-anual-${year}.pdf`); show('PDF anual baixado') }
  const xlsxAnnual = async () => { if (!requirePro()) return; await exportXLSX(tx.filter((t: any) => Number(t.date.slice(0, 4)) === year).map((t: any) => ({ Data: t.date, Descrição: t.description, Tipo: t.type === 'in' ? 'Entrou' : 'Saiu', Categoria: t.category, Valor: t.amount })), `noazul-anual-${year}.xlsx`); show('Excel anual baixado') }
  return <div className="space-y-5">
    <div className="flex items-center justify-between">
      <h2 className="font-extrabold text-lg flex items-center gap-2"><CalendarDays size={20} /> Resumo de {year}</h2>
      <div className="monthnav"><button onClick={() => setYear(year - 1)}><ChevronLeft size={18} /></button><span>{year}</span><button onClick={() => setYear(year + 1)}><ChevronRight size={18} /></button></div>
    </div>
    <div className="grid sm:grid-cols-3 gap-4">
      <Stat icon={<TrendingUp size={20} />} label="Entrou no ano" value={brl(a.income)} tone="up" />
      <Stat icon={<TrendingDown size={20} />} label="Saiu no ano" value={brl(a.expense)} tone="down" />
      <Stat icon={<PiggyBank size={20} />} label="Sobrou no ano" value={brl(a.balance)} tone="neutral" />
    </div>
    <div className="grid sm:grid-cols-3 gap-4 text-sm">
      <div className="card p-4"><div className="muted text-xs font-bold uppercase">Média por mês</div><div className="font-extrabold mt-1">Gasta {brl(a.avgExpense)}</div><div className="muted text-xs">de {brl(a.avgIncome)} que entra</div></div>
      <div className="card p-4"><div className="muted text-xs font-bold uppercase">Meses com movimento</div><div className="font-extrabold mt-1">{a.activeMonths} de 12</div><div className="muted text-xs">{a.positiveMonths} meses sobraram</div></div>
      <div className="card p-4"><div className="muted text-xs font-bold uppercase">Guardou do que entrou</div><div className="font-extrabold mt-1">{a.savingsRate}%</div><div className="muted text-xs">taxa de poupança do ano</div></div>
    </div>
    <section className="card p-5">
      <h2 className="font-bold mb-3">Mês a mês</h2>
      {a.count ? <div style={{ height: 260 }}><ResponsiveContainer><BarChart data={a.months}><XAxis dataKey="label" /><YAxis width={55} /><Tooltip formatter={(v: any) => brl(v)} /><Legend /><Bar dataKey="income" name="Entrou" fill={GREEN} radius={[6, 6, 0, 0]} /><Bar dataKey="expense" name="Saiu" fill={ROSE} radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div> : <Empty text={`Nenhum movimento em ${year} ainda.`} />}
    </section>
    <div className="grid md:grid-cols-2 gap-4">
      <section className="card p-5"><h2 className="font-bold mb-3">Onde mais gastou no ano</h2>{a.byCategory.length ? a.byCategory.slice(0, 6).map((c: any, i: number) => <div key={c.name} className="catrow"><span className="w-36 shrink-0">{c.name}</span><div className="progress flex-1"><div style={{ width: Math.max(4, a.expense ? (c.value / a.expense) * 100 : 0) + '%', background: PIE_COLORS[i % PIE_COLORS.length] }} /></div><b className="w-24 text-right">{brl(c.value)}</b></div>) : <p className="muted text-sm">Sem gastos no ano.</p>}</section>
      <section className="card p-5"><h2 className="font-bold mb-3">Melhor e pior mês</h2>{a.bestMonth ? <div className="space-y-2 text-sm"><div>Melhor: <b className="capitalize">{monthLabel(a.bestMonth.month)}</b> — sobraram {brl(a.bestMonth.balance)}</div><div>Pior: <b className="capitalize">{monthLabel(a.worstMonth!.month)}</b> — {a.worstMonth!.balance >= 0 ? 'sobraram' : 'faltaram'} {brl(Math.abs(a.worstMonth!.balance))}</div><div className="muted">Média de gastos por mês: {brl(a.avgExpense)}</div></div> : <p className="muted text-sm">Sem dados.</p>}</section>
    </div>
    {isPro ? (
      <div className="space-y-5">
        <section className="card p-5">
          <h2 className="font-bold flex items-center gap-2"><Sparkles size={18} className="text-violet-500" /> Análise Pro</h2>
          <div className="flex items-center gap-5 mt-3"><div className="text-center"><div className="text-4xl font-black" style={{ color: score.score >= 55 ? GREEN : '#F59E0B' }}>{score.score}</div><div className="muted text-xs">nota de 0 a 100</div></div><div className="text-sm"><b>{score.label}</b><p className="muted mt-1">{score.detail}</p><p className="mt-2">Tendência: seus gastos {trend.direction === 'igual' ? 'estão estáveis' : `${trend.direction} ${Math.abs(trend.pctChange)}%`} nos últimos 3 meses.</p></div></div>
          <ul className="mt-4 space-y-2 text-sm">{insights.map((t, i) => <li key={i} className="flex gap-2"><span className="dot" />{t}</li>)}</ul>
        </section>
        <section className="card p-5">
          <h2 className="font-bold mb-3">Comparativo com {year - 1}</h2>
          {cmp.hasPrev ? <div className="space-y-2 text-sm">
            <div className="flex justify-between border-b py-2"><span>Entrou</span><b>{fmt(cmp.incomeDiff)} ({cmp.incomePct}%)</b></div>
            <div className="flex justify-between border-b py-2"><span>Saiu</span><b>{fmt(cmp.expenseDiff)} ({cmp.expensePct}%)</b></div>
            <div className="flex justify-between py-2"><span>Sobrou</span><b>{fmt(cmp.balanceDiff)} ({cmp.balancePct}%)</b></div>
            <p className="muted text-xs">Comparando {year} com {year - 1}. Positivo é melhor para entrou/sobrou; para saiu, negativo é melhor.</p>
          </div> : <p className="muted text-sm">Sem dados de {year - 1} para comparar. Quando tiver, o comparativo aparece aqui.</p>}
        </section>
        <div className="flex gap-2 flex-wrap"><button className="btn-ghost" onClick={pdfAnnual}><FileText size={15} /> PDF anual (Pro)</button><button className="btn-ghost" onClick={xlsxAnnual}><Download size={15} /> Excel anual (Pro)</button></div>
      </div>
    ) : (
      <LockedPro onUnlock={requirePro} />
    )}
  </div>
}

function LockedPro({ onUnlock }: any) {
  return <section className="card p-5 relative overflow-hidden">
    <div className="locked-blur pointer-events-none select-none" aria-hidden>
      <div className="font-bold">Análise Pro — nota, comparativo e dicas</div>
      <div className="text-4xl font-black mt-2">87</div><p className="text-sm mt-2">Seus gastos subiram 12%... categoria que mais pesou...</p>
    </div>
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-[color-mix(in_srgb,var(--card)_55%,transparent)]">
      <Lock size={26} className="text-amber-500" />
      <div className="font-extrabold mt-2">Análise completa é do Pro</div>
      <p className="muted text-sm mt-1 max-w-sm">Nota de organização, comparativo com o ano passado, tendência de gastos e exportação em PDF/Excel anual.</p>
      <button className="btn mt-4" onClick={onUnlock}><Crown size={16} /> Desbloquear com o Pro — {brl(PRO_PRICE_BRL)}/mês</button>
    </div>
  </section>
}

function AuthScreen({ auth }: any) {
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login')
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false)
  const [consent, setConsent] = useState(false)
  const submit = async () => {
    if (busy) return
    if (mode === 'signup' && !consent) return setMsg('Marque a caixa de Termos e Privacidade para continuar.')
    setBusy(true); setMsg('')
    try {
      if (mode === 'login') { const r = await auth.signIn(email, password); setMsg(r.error || ''); if (!r.error) setMsg('') }
      else if (mode === 'signup') { const r = await auth.signUp(name, email, password); if (r.error) setMsg(r.error); else if (r.needsConfirmation) setMsg('Conta criada! Confirmamos por e-mail — confirme para entrar.'); else setMsg('') }
      else { const r = await auth.resetPassword(email); setMsg(r.error || 'Enviamos um link para redefinir a senha.'); }
    } finally { setBusy(false) }
  }
  return <div className="min-h-screen flex items-center justify-center p-4"><div className="card p-6 w-full max-w-md space-y-4">
    <Logo />
    <h1 className="text-2xl font-extrabold">{mode === 'login' ? 'Entrar no NoAzul' : mode === 'signup' ? 'Criar conta' : 'Recuperar senha'}</h1>
    <p className="muted text-sm">Seus dados sincronizam entre seus dispositivos com segurança.</p>
    {mode === 'signup' && <Field label="Nome" value={name} onChange={(v: any) => setName(v)} placeholder="Seu nome" />}
    <Field label="E-mail" value={email} onChange={(v: any) => setEmail(v)} placeholder="voce@email.com" />
    {mode !== 'forgot' && <Field label="Senha" value={password} onChange={(v: any) => setPassword(v)} placeholder="••••••••" type="password" />}
    {mode === 'signup' && <label className="flex items-start gap-2 text-xs muted"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-0.5" /><span>Li e concordo com os <a className="link" href="/termos.html" target="_blank" rel="noreferrer">Termos de Uso</a> e a <a className="link" href="/privacidade.html" target="_blank" rel="noreferrer">Política de Privacidade</a> (LGPD), incluindo o uso do Supabase para sincronização.</span></label>}
    {msg && <p className="text-sm text-emerald-600">{msg}</p>}
    <button className="btn w-full" onClick={submit} disabled={busy}>{busy ? 'Aguarde...' : mode === 'forgot' ? 'Enviar link de recuperação' : mode === 'login' ? 'Entrar' : 'Criar conta'}</button>
    <div className="flex justify-between text-sm">
      {mode !== 'login' && <button className="link" onClick={() => setMode('login')}>Já tenho conta</button>}
      {mode === 'login' && <><button className="link" onClick={() => setMode('forgot')}>Esqueci minha senha</button><button className="link" onClick={() => setMode('signup')}>Criar conta</button></>}
    </div>
    <div className="text-xs muted text-center"><a href="/termos.html" target="_blank" rel="noreferrer">Termos</a> · <a href="/privacidade.html" target="_blank" rel="noreferrer">Privacidade</a> · <a href="mailto:suporte@noazul.app.br">Suporte</a></div>
  </div></div>
}
function ResetPasswordScreen({ auth }: any) {
  const [password, setPassword] = useState(''); const [msg, setMsg] = useState('')
  return <div className="min-h-screen flex items-center justify-center p-4"><div className="card p-6 w-full max-w-md space-y-4">
    <h1 className="text-2xl font-extrabold">Redefinir senha</h1>
    <Field label="Nova senha" value={password} onChange={(v: any) => setPassword(v)} type="password" />
    {msg && <p className="text-sm">{msg}</p>}
    <button className="btn w-full" onClick={async () => { const r = await auth.updatePassword(password); setMsg(r.error || 'Senha atualizada!'); if (!r.error) window.location.hash = '' }}>Salvar nova senha</button>
  </div></div>
}
function Investimentos({ userId, investments, allTx, reload, show }: any) {
  const [form, setForm] = useState<any>({ name: '', category: 'Renda fixa', ticker: '', institution: '', quantity: '', averagePrice: '', investedAmount: '', currentValue: '', startedAt: today(), notes: '' })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState(''); const [filterCat, setFilterCat] = useState('Todas'); const [filterInst, setFilterInst] = useState('Todas')
  const [txForm, setTxForm] = useState<any>({ type: 'compra', date: today(), amount: '', quantity: '', unitPrice: '', description: '' })
  const [txs, setTxs] = useState<InvestmentTransaction[]>([])
  const s = useMemo(() => summarizeInvestments(investments, allTx), [investments, allTx])
  const selected = investments.find((i: any) => i.id === selectedId)
  useEffect(() => { if (selectedId && userId) listInvestmentTransactions(selectedId, userId).then(setTxs).catch(() => setTxs([])) }, [selectedId, userId, investments])
  const resetForm = () => { setEditingId(null); setForm({ name: '', category: 'Renda fixa', ticker: '', institution: '', quantity: '', averagePrice: '', investedAmount: '', currentValue: '', startedAt: today(), notes: '' }) }
  const save = async () => {
    if (!userId) return show('Aguarde carregar seus dados e tente de novo.')
    const inv: Investment = { id: editingId || newId(), userId, name: form.name.trim(), category: form.category, ticker: form.ticker.trim().toUpperCase(), institution: form.institution.trim(), quantity: num(form.quantity || '0'), averagePrice: num(form.averagePrice || '0'), investedAmount: num(form.investedAmount || '0'), currentValue: num(form.currentValue || '0'), startedAt: form.startedAt, notes: form.notes.trim(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const errs = validateInvestment(inv); if (errs.length) return show(errs[0])
    try { await upsertInvestment(inv); await reload(); resetForm(); show('Investimento salvo') } catch (e: any) { show(e?.message || 'Não foi possível salvar. Tente de novo.') }
  }
  const edit = (inv: any) => { setEditingId(inv.id); setSelectedId(null); setForm({ name: inv.name, category: inv.category, ticker: inv.ticker, institution: inv.institution, quantity: String(inv.quantity).replace('.', ','), averagePrice: String(inv.averagePrice).replace('.', ','), investedAmount: String(inv.investedAmount).replace('.', ','), currentValue: String(inv.currentValue).replace('.', ','), startedAt: inv.startedAt || today(), notes: inv.notes }) }
  const [saving, setSaving] = useState(false); const [editingTxId, setEditingTxId] = useState<string | null>(null)
  const saveTx = async () => {
    if (!selected || saving) return
    const t: InvestmentTransaction = { id: editingTxId || newId(), investmentId: selected.id, userId, type: txForm.type, quantity: num(txForm.quantity || '0'), unitPrice: num(txForm.unitPrice || '0'), amount: num(txForm.amount || '0'), date: txForm.date, description: txForm.description.trim(), createdAt: new Date().toISOString() }
    const errs = validateInvestmentTransaction(t); if (errs.length) return show(errs[0])
    if (!editingTxId && isDuplicateTransaction(txs, t)) return show('Movimentação idêntica já registrada')
    setSaving(true)
    try {
      if (editingTxId) {
        const old = txs.find((x: any) => x.id === editingTxId); if (!old) return show('Movimentação não encontrada')
        const reverted = reverseTransaction(selected, old)
        const posErrs = validateAgainstPosition(reverted, t); if (posErrs.length) return show(posErrs[0])
        const { investment: updated, costRemoved, realizedGain } = applyTransactionDetailed(reverted, t)
        await replaceInvestmentTransaction(old.id, { ...t, costRemoved, realizedGain }, updated)
        setEditingTxId(null); show('Movimentação atualizada')
      } else {
        const posErrs = validateAgainstPosition(selected, t); if (posErrs.length) return show(posErrs[0])
        const { investment: updated, costRemoved, realizedGain } = applyTransactionDetailed(selected, t)
        await addInvestmentTransaction({ ...t, costRemoved, realizedGain }, updated); show('Movimentação registrada')
      }
      await reload(); setTxForm({ type: 'compra', date: today(), amount: '', quantity: '', unitPrice: '', description: '' })
    } catch (e: any) { show(e?.message || 'Não foi possível registrar') } finally { setSaving(false) }
  }
  const editTx = (t: any) => { setEditingTxId(t.id); setTxForm({ type: t.type, date: t.date, amount: String(t.amount).replace('.', ','), quantity: String(t.quantity).replace('.', ','), unitPrice: String(t.unitPrice).replace('.', ','), description: t.description }) }
  const removeTx = async (t: any) => {
    if (!selected || !confirm('Excluir esta movimentação? O investimento será recalculado.')) return
    const updated = reverseTransaction(selected, t)
    try { await deleteInvestmentTransaction(t.id, userId, updated); if (editingTxId === t.id) setEditingTxId(null); await reload(); show('Movimentação excluída') } catch (e: any) { show(e?.message || 'Não foi possível excluir') }
  }
  const list = investments.filter((i: any) => (i.name.toLowerCase().includes(search.toLowerCase()) || i.ticker.toLowerCase().includes(search.toLowerCase())) && (filterCat === 'Todas' || i.category === filterCat) && (filterInst === 'Todas' || i.institution === filterInst))
  const instList: string[] = [...new Set(investments.map((i: any) => i.institution).filter(Boolean))] as string[]
  return <div className="space-y-5">
    <section className="hero">
      <div className="muted text-sm font-semibold">Patrimônio atual em investimentos</div>
      <div className="hero-value">{brl(s.totalCurrent)}</div>
      <p className="text-sm opacity-90 mt-1">Custo remanescente {brl(s.totalCostRemaining)} • Retorno total {brl(s.totalReturn)} ({s.totalReturnPct}%) • Realizado {brl(s.realized)} • Não realizado {brl(s.unrealized)}{s.income ? ` • Rendimentos recebidos: ${brl(s.income)}` : ''}</p>
      <div className="hero-chip">{s.count} investimento(s) cadastrado(s)</div>
    </section>
    <div className="grid sm:grid-cols-3 gap-4">
      <Stat icon={<TrendingUp size={20} />} label="Patrimônio atual" value={brl(s.totalCurrent)} tone="up" />
      <Stat icon={<TrendingDown size={20} />} label="Custo remanescente" value={brl(s.totalCostRemaining)} tone="down" />
      <Stat icon={<PiggyBank size={20} />} label="Retorno total" value={`${brl(s.totalReturn)} (${s.totalReturnPct}%)`} tone="neutral" />
    </div>
    <div className="grid md:grid-cols-2 gap-4">
      <section className="card p-5"><h2 className="font-bold mb-3">Distribuição por categoria</h2>{s.byCategory.length ? s.byCategory.map((c: any, i: number) => <div key={c.name} className="catrow"><span className="w-36 shrink-0">{c.name}</span><div className="progress flex-1"><div style={{ width: Math.max(4, s.totalCurrent ? (c.value / s.totalCurrent) * 100 : 0) + '%', background: PIE_COLORS[i % PIE_COLORS.length] }} /></div><b className="w-24 text-right">{brl(c.value)}</b></div>) : <p className="muted text-sm">Cadastre seu primeiro investimento abaixo.</p>}</section>
      <section className="card p-5"><h2 className="font-bold mb-3">Evolução do capital líquido aportado</h2>{s.evolution.length ? <div style={{ height: 220 }}><ResponsiveContainer><BarChart data={s.evolution}><XAxis dataKey="month" /><YAxis width={55} /><Tooltip formatter={(v: any) => brl(v)} /><Bar dataKey="invested" name="Capital líquido" fill={GREEN} radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div> : <p className="muted text-sm">Registre movimentações de compra/venda para ver a evolução.</p>}</section>
    </div>
    <section className="card p-5 md:p-6">
      <h2 className="font-bold text-lg">{editingId ? 'Editar investimento' : 'Novo investimento'}</h2>
      <div className="grid sm:grid-cols-2 gap-3 mt-4">
        <Field label="Nome" value={form.name} onChange={(v: any) => setForm({ ...form, name: v })} placeholder="Ex.: Tesouro IPCA+ 2029" />
        <Field label="Ticker / código (opcional)" value={form.ticker} onChange={(v: any) => setForm({ ...form, ticker: v })} placeholder="Ex.: PETR4" />
        <label className="block"><div className="label">Categoria</div><select className="input" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{INVESTMENT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></label>
        <Field label="Instituição / corretora" value={form.institution} onChange={(v: any) => setForm({ ...form, institution: v })} placeholder="Ex.: Tesouro Direto" />
        <Field label="Data da aplicação" value={form.startedAt} onChange={(v: any) => setForm({ ...form, startedAt: v })} type="date" />
        <Field label="Quantidade (opcional)" value={form.quantity} onChange={(v: any) => setForm({ ...form, quantity: v })} placeholder="0,00" />
        <Field label="Preço médio (opcional)" value={form.averagePrice} onChange={(v: any) => setForm({ ...form, averagePrice: v })} placeholder="0,00" />
        <Field label="Total investido (R$)" value={form.investedAmount} onChange={(v: any) => setForm({ ...form, investedAmount: v })} placeholder="0,00" />
        <Field label="Valor atual (R$)" value={form.currentValue} onChange={(v: any) => setForm({ ...form, currentValue: v })} placeholder="0,00" />
        <Field label="Observações" value={form.notes} onChange={(v: any) => setForm({ ...form, notes: v })} placeholder="Opcional" />
      </div>
      <div className="flex gap-2 mt-5 flex-wrap"><button className="btn" onClick={save}><Plus size={17} /> {editingId ? 'Salvar alterações' : 'Cadastrar'}</button>{editingId && <button className="btn-ghost" onClick={resetForm}>Cancelar</button>}</div>
    </section>
    <section className="card p-5">
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="search"><Search size={16} /><input placeholder="Buscar nome ou ticker..." value={search} onChange={e => setSearch(e.target.value)} /></div>
        <select className="input sm:!w-auto" value={filterCat} onChange={e => setFilterCat(e.target.value)}><option>Todas</option>{INVESTMENT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
        <select className="input sm:!w-auto" value={filterInst} onChange={e => setFilterInst(e.target.value)}><option>Todas</option>{instList.map(c => <option key={c}>{c}</option>)}</select>
      </div>
      {!list.length ? <Empty text="Nenhum investimento encontrado. Cadastre o primeiro acima." /> : list.map((inv: any) => { const g = investmentGain(inv); return (
        <div key={inv.id} className="txrow">
          <div className="tx-icon in"><TrendingUp size={16} /></div>
          <div className="flex-1 min-w-0"><div className="font-bold truncate">{inv.name}{inv.ticker ? ` (${inv.ticker})` : ''}</div><div className="muted text-xs">{inv.category}{inv.institution ? ` • ${inv.institution}` : ''} • investido {brl(inv.investedAmount)}</div></div>
          <div className="text-right"><b>{brl(inv.currentValue)}</b><div className={`text-xs font-bold ${g.gain >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{g.gain >= 0 ? '+' : ''}{brl(g.gain)} ({g.pct}%)</div></div>
          <button className="btn-ghost" onClick={() => setSelectedId(inv.id)}>Detalhes</button>
          <button className="iconbtn" aria-label="Editar investimento" onClick={() => edit(inv)}><Pencil size={15} /></button>
          <button className="iconbtn" aria-label="Excluir investimento" onClick={async () => { if (!confirm(`Excluir ${inv.name} e todo o histórico de movimentações?`)) return; try { await deleteInvestment(inv.id, userId); if (selectedId === inv.id) setSelectedId(null); await reload(); show('Investimento excluído') } catch (e:any) { show(e?.message || 'Não foi possível excluir.') } }}><Trash2 size={15} /></button>
        </div>) })}
    </section>
    {selected && <section className="card p-5 md:p-6 space-y-4">
      <div className="flex justify-between items-start gap-3"><div><h2 className="font-bold text-lg">{selected.name}</h2><p className="muted text-sm">{selected.category}{selected.ticker ? ` • ${selected.ticker}` : ''}{selected.institution ? ` • ${selected.institution}` : ''}</p></div><button className="btn-ghost" onClick={() => setSelectedId(null)}>Fechar</button></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div><div className="muted text-xs">Quantidade</div><b>{selected.quantity}</b></div>
        <div><div className="muted text-xs">Preço médio</div><b>{brl(selected.averagePrice)}</b></div>
        <div><div className="muted text-xs">Custo remanescente</div><b>{brl(selected.investedAmount)}</b></div>
        <div><div className="muted text-xs">Atual</div><b>{brl(selected.currentValue)}</b></div>
      </div>
      <div className="border-t pt-4" style={{ borderColor: 'var(--border)' }}>
        <h3 className="font-bold mb-3">Registrar movimentação</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block"><div className="label">Tipo</div><select className="input" value={txForm.type} onChange={e => setTxForm({ ...txForm, type: e.target.value })}>{INVESTMENT_TX_TYPES.map(t => <option key={t} value={t}>{TX_LABELS[t]}</option>)}</select></label>
          <Field label="Data" value={txForm.date} onChange={(v: any) => setTxForm({ ...txForm, date: v })} type="date" />
          <Field label="Valor (R$)" value={txForm.amount} onChange={(v: any) => setTxForm({ ...txForm, amount: v })} placeholder="0,00" />
          <Field label="Quantidade" value={txForm.quantity} onChange={(v: any) => setTxForm({ ...txForm, quantity: v })} placeholder="0,00" />
          <Field label="Preço unitário" value={txForm.unitPrice} onChange={(v: any) => setTxForm({ ...txForm, unitPrice: v })} placeholder="0,00" />
          <Field label="Descrição (opcional)" value={txForm.description} onChange={(v: any) => setTxForm({ ...txForm, description: v })} placeholder="Ex.: aporte mensal" />
        </div>
        <button className="btn mt-4" onClick={saveTx} disabled={saving}><Plus size={17} /> {saving ? 'Salvando...' : editingTxId ? 'Salvar alterações' : 'Registrar'}</button>{editingTxId && <button className="btn-ghost mt-4 ml-2" onClick={() => { setEditingTxId(null); setTxForm({ type: 'compra', date: today(), amount: '', quantity: '', unitPrice: '', description: '' }) }}>Cancelar</button>}
      </div>
      <div className="border-t pt-4" style={{ borderColor: 'var(--border)' }}>
        <h3 className="font-bold mb-3">Histórico</h3>
        {!txs.length ? <p className="muted text-sm">Sem movimentações ainda.</p> : txs.map((t: any) => <div key={t.id} className="txrow"><div className="tx-icon in"><ArrowLeftRight size={16} /></div><div className="flex-1 min-w-0"><div className="font-bold">{(TX_LABELS as any)[t.type]} {t.description ? `— ${t.description}` : ''}</div><div className="muted text-xs">{new Date(t.date + 'T12:00:00').toLocaleDateString('pt-BR')}{t.quantity ? ` • ${t.quantity} un` : ''}{t.realizedGain ? ` • realizado ${brl(t.realizedGain)}` : ''}</div></div><b>{brl(t.amount)}</b><button className="iconbtn" aria-label="Editar movimentação" onClick={() => editTx(t)}><Pencil size={15} /></button><button className="iconbtn" aria-label="Excluir movimentação" onClick={() => removeTx(t)}><Trash2 size={15} /></button></div>)}
      </div>
    </section>}
  </div>
}

function ProView({ pro, checkout, checkoutConfigured, licenseApi, licenseApiConfigured, reload, show }: any) {
  const [key, setKey] = useState(''); const [msg, setMsg] = useState('')
  const [email, setEmail] = useState(''); const [checking, setChecking] = useState(false)
  useEffect(() => { getSetting('caktoEmail').then(v => { if (v) setEmail(v) }) }, [])
  const dev = getDeviceId()
  const saveLicense = async (k: string, holder: string, expiresAt: any, plan: string) => {
    await setSetting('activated', '1'); await setSetting('licenseKey', k); await setSetting('licenseHolder', holder); await setSetting('licenseExpires', expiresAt || ''); await setSetting('plan', plan)
    setMsg('Pro ativado!'); show('Pro ativado'); await reload()
  }
  const activate = async () => {
    try {
      const r = await verifyLicense(key, dev)
      if (!r.ok) { setMsg(r.reason); return show(r.reason) }
      if (!isProActive(r.payload)) { setMsg('Esta chave já expirou. Renove a assinatura na Cakto e use a nova chave.'); return show('Chave expirada') }
      await saveLicense(key.trim(), r.payload!.holder, r.payload!.expiresAt, r.payload!.plan)
    } catch (e: any) { setMsg(e?.message || 'Não foi possível ativar. Tente de novo.'); show(e?.message || 'Não foi possível ativar.') }
  }
  const activateAuto = async () => {
    if (!licenseApiConfigured) { setMsg('Ativação automática ainda não foi configurada. Use a chave manual abaixo.'); return }
    if (!email.trim() || !email.includes('@')) { setMsg('Informe o e-mail usado na Cakto.'); return }
    setChecking(true); setMsg('Verificando sua assinatura...')
    try {
      const r = await fetchAutoLicense(licenseApi, email, dev)
      if (!r.ok || !r.key) {
        const msgs: Record<string, string> = { device_mismatch: 'Esta assinatura já está ativa em outro aparelho. Para trocar, fale com o suporte.', not_active: 'Não encontramos assinatura ativa para este e-mail. Confira o e-mail ou renove na Cakto.', network: 'Sem internet. Confira a conexão e tente de novo.', rate_limited: 'Muitas tentativas. Aguarde alguns instantes e tente de novo.' }
        setMsg(msgs[r.error || ''] || r.message || 'Não encontramos assinatura ativa para este e-mail.'); return
      }
      const v = await verifyLicense(r.key, dev)
      if (!v.ok || !isProActive(v.payload)) { setMsg('Resposta inválida do servidor. Tente de novo.'); return }
      await setSetting('caktoEmail', email.trim().toLowerCase())
      await saveLicense(r.key, v.payload!.holder, v.payload!.expiresAt, v.payload!.plan)
    } catch { setMsg('Não foi possível verificar agora. Confira sua internet e tente de novo.') } finally { setChecking(false) }
  }
  return <div className="space-y-5 max-w-2xl">
    {pro.activated ? (
      <section className="pro-hero">
        <Crown size={30} /><div className="font-extrabold text-2xl mt-2">Você é Pro!</div>
        <p className="opacity-90 text-sm mt-1">Titular: {pro.holder || '—'} • Plano: {pro.plan === 'lifetime' ? 'Vitalício' : 'Mensal'} • Válido até {pro.expiresAt ? new Date(pro.expiresAt).toLocaleDateString('pt-BR') : '—'} {pro.expiresAt && <>(faltam {proDaysLeft(pro)} dias)</>}</p>
        <div className="flex gap-2 flex-wrap mt-4"><a className="btn-white" href={checkout} target="_blank" rel="noreferrer">Renovar na Cakto <ExternalLink size={15} /></a><button className="btn-ghost" onClick={async () => { try { await setSetting('activated', '0'); await setSetting('licenseKey', ''); await reload(); show('Pro desativado neste aparelho') } catch (e:any) { show(e?.message || 'Não foi possível desativar.') } }}>Desativar neste aparelho</button></div>
      </section>
    ) : (
      <section className="pro-hero">
        <div className="text-sm font-bold opacity-90">NOAZUL PRO</div>
        <div className="font-extrabold text-4xl mt-1">{brl(PRO_PRICE_BRL)}<span className="text-lg font-semibold">/mês</span></div>
        <p className="opacity-90 text-sm mt-2">Assinatura mensal pela Cakto. Cancele quando quiser. Sem taxa escondida. Seus dados continuam seus — se cancelar, volta para o grátis sem perder nada.</p>
        <a className="btn-white w-full mt-4" href={checkout} target="_blank" rel="noreferrer">Assinar agora pela Cakto <ExternalLink size={16} /></a>
        {!checkoutConfigured && <p className="text-xs opacity-80 mt-2">Dono do app: o link de pagamento ainda não foi configurado. Defina em Ajustes → Link da Cakto.</p>}
        {pro.expired && <p className="text-sm mt-3 bg-white/20 rounded-xl p-3">Seu Pro expirou. Assine de novo na Cakto e ative com o e-mail abaixo.</p>}
      </section>
    )}
    <section className="card p-5">
      <h2 className="font-bold">O que o Pro desbloqueia</h2>
      <div className="mt-3 space-y-3">{PRO_FEATURES.map(f => <div key={f.title} className="flex gap-3 text-sm"><Sparkles size={17} className="text-violet-500 shrink-0" /><div><b>{f.title}</b><div className="muted">{f.desc}</div></div></div>)}</div>
      <div className="border-t mt-4 pt-3 text-sm"><div className="font-bold mb-2">O grátis já inclui</div>{FREE_FEATURES.map(f => <div key={f} className="flex gap-2 py-0.5"><Check size={15} className="text-emerald-600 shrink-0" />{f}</div>)}</div>
    </section>
    <section className="card p-5 space-y-4">
      <h2 className="font-bold flex items-center gap-2"><Sparkles size={18} className="text-violet-500" /> Ativar automaticamente</h2>
      <p className="muted text-sm">Pagou na Cakto? Digite o <b>mesmo e-mail</b> da compra e toque em verificar — o Pro libera sozinho, sem chave.</p>
      <input className="input" type="email" placeholder="seu@email.com" value={email} onChange={e => setEmail(e.target.value)} />
      <button className="btn w-full" onClick={activateAuto} disabled={checking}><Check size={16} /> {checking ? 'Verificando...' : 'Verificar minha assinatura'}</button>
      {!licenseApiConfigured && <p className="muted text-xs">Ativação automática ainda não configurada pelo dono — use a chave manual abaixo.</p>}
      {msg && <p className="text-sm">{msg}</p>}
    </section>
    <section className="card p-5 space-y-4">
      <h2 className="font-bold">Ou ativar com chave (manual)</h2>
      <ol className="text-sm space-y-2 list-decimal ml-5">
        <li>Assine na Cakto (botão acima) — pagamento seguro em cartão ou Pix.</li>
        <li>Após a confirmação, você recebe a <b>chave de ativação</b> (começa com PRP1).</li>
        <li>Cole a chave abaixo e toque em Ativar. A chave vale para este aparelho.</li>
      </ol>
      <div className="muted text-xs">Se pedir a chave, informe este ID do aparelho: <code className="break-all">{dev}</code></div>
      <textarea className="input" rows={3} placeholder="PRP1.sua-chave-aqui" value={key} onChange={e => setKey(e.target.value)} />
      <button className="btn w-full" onClick={activate}><Crown size={16} /> Ativar Pro</button>
    </section>
  </div>
}

function initialsOf(s: string) {
  const parts = s.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'NA'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

const ENTITY_LABELS: Record<string, string> = {
  transactions: 'Lançamento', fixed_bills: 'Conta fixa', goals: 'Meta', budgets: 'Limite',
  bill_payments: 'Conta paga', recurrences: 'Recorrência', recurrence_launches: 'Recorrência lançada',
  categories: 'Categoria', goal_auto_launches: 'Aporte de meta', investments: 'Investimento',
  investment_transactions: 'Movimentação de investimento',
}
function describeRow(r: any) {
  if (!r) return '—'
  return r.description || r.name || r.category || r.month || r.id || '—'
}

function Perfil({ auth, name, setName, show, isPro, pro, goPro, syncState, runSync, checkout }: any) {
  const user = auth.user
  const [draft, setDraft] = useState(name || '')
  useEffect(() => { setDraft(name || '') }, [name])
  const [pwd, setPwd] = useState(''); const [pwd2, setPwd2] = useState(''); const [busy, setBusy] = useState(false)
  const displayName = (draft || name || user?.user_metadata?.display_name || '').trim()
  const email = user?.email || ''
  const saveName = async () => {
    const v = draft.trim()
    try {
      await setSetting('userName', v)
      setName(v)
      if (auth.configured && user) { try { await auth.updateProfile(v) } catch {} }
      show('Perfil atualizado')
    } catch (e: any) { show(e?.message || 'Não foi possível salvar. Tente de novo.') }
  }
  const changePassword = async () => {
    if (busy) return
    if (pwd.length < 6) return show('A senha precisa ter pelo menos 6 caracteres')
    if (pwd !== pwd2) return show('As senhas não conferem')
    setBusy(true)
    try { const r = await auth.updatePassword(pwd); if (r.error) show(r.error); else { setPwd(''); setPwd2(''); show('Senha atualizada') } } finally { setBusy(false) }
  }
  const resolve = async (c: any, choice: 'local' | 'remote') => {
    if (!user) return
    try {
      const { makeSyncStore } = await import('./sync/store')
      const store = makeSyncStore(user.id)
      const row = resolveConflict(c, choice) as any
      if (choice === 'local') {
        await store.resolveConflictLocal(c.entity, c.recordId, { ...row, userId: user.id })
        const meta = await store.getMeta(c.entity)
        meta.set(c.recordId, { hash: canonicalHash(c.remote), version: c.remoteVersion || 0 })
        await store.setMeta(c.entity, meta)
      } else {
        await store.replaceLocal(c.entity, [{ ...row, userId: user.id }])
        const meta = await store.getMeta(c.entity)
        meta.set(c.recordId, { hash: canonicalHash(row), version: row.version || c.remoteVersion || 1 })
        await store.setMeta(c.entity, meta)
      }
      await resolveSyncConflict(c.id)
      show('Conflito resolvido')
      await runSync()
    } catch (e: any) { show(e?.message || 'Não foi possível resolver o conflito.') }
  }
  const syncText = syncState.status === 'syncing' ? 'Sincronizando...' : syncState.status === 'offline' ? 'Offline — tudo fica na fila e sobe ao reconectar' : syncState.status === 'conflict' ? `${syncState.conflicts?.length || 0} conflito(s) aguardando decisão` : syncState.lastSyncAt ? `Sincronizado em ${new Date(syncState.lastSyncAt).toLocaleString('pt-BR')}` : 'Ainda não sincronizou'
  return <div className="space-y-5 max-w-xl">
    <section className="card p-6">
      <div className="flex items-center gap-4">
        <div style={{ width: 68, height: 68, borderRadius: 999, background: 'linear-gradient(135deg,var(--brand),var(--brand-dark))', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 900, flexShrink: 0 }}>{initialsOf(displayName || email || 'NoAzul')}</div>
        <div className="flex-1 min-w-0">
          <div className="text-xl font-extrabold truncate">{displayName || 'Visitante'}</div>
          <div className="muted text-sm truncate flex items-center gap-1"><Mail size={14} /> {auth.configured && user ? email : 'Modo local — dados só neste aparelho'}</div>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="badge" style={{ background: isPro ? '#D1FAE5' : '#FEF3C7', color: isPro ? '#065F46' : '#92400E' }}>{isPro ? 'PRO ATIVO' : 'GRÁTIS'}</span>
            {user?.created_at && <span className="muted text-xs">Conta desde {new Date(user.created_at).toLocaleDateString('pt-BR')}</span>}
          </div>
        </div>
      </div>
    </section>
    {syncState.conflicts?.length > 0 && <section className="card p-6 space-y-3" style={{ borderColor: '#FDE68A' }}>
      <h2 className="font-bold text-lg flex items-center gap-2"><AlertTriangle size={18} className="text-amber-500" /> Conflitos de sincronização</h2>
      <p className="muted text-sm">O mesmo registro mudou neste aparelho e na nuvem. Escolha qual versão manter.</p>
      {syncState.conflicts.map((c: any) => <div key={c.id} className="pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
        <div className="text-sm font-bold">{ENTITY_LABELS[c.entity] || c.entity}</div>
        <div className="muted text-xs truncate">Meu: {describeRow(c.local)}</div>
        <div className="muted text-xs truncate">Nuvem: {describeRow(c.remote)}</div>
        <div className="flex gap-2 mt-2"><button className="btn-ghost !py-1.5" onClick={() => resolve(c, 'local')}>Manter meu</button><button className="btn-ghost !py-1.5" onClick={() => resolve(c, 'remote')}>Usar nuvem</button></div>
      </div>)}
    </section>}
    <section className="card p-6 space-y-4">
      <h2 className="font-bold text-lg flex items-center gap-2"><UserRound size={18} className="text-emerald-600" /> Nome de exibição</h2>
      <p className="muted text-sm">É assim que o NoAzul chama você na tela inicial e nos relatórios.</p>
      <Field label="Como você quer ser chamado?" value={draft} onChange={(v: any) => setDraft(v)} placeholder="Ex.: Maria" />
      <button className="btn" onClick={saveName}><Check size={16} /> Salvar nome</button>
    </section>
    <section className="card p-6 space-y-3">
      <h2 className="font-bold text-lg flex items-center gap-2"><Crown size={18} className="text-amber-500" /> Seu plano</h2>
      {isPro ? <>
        <p className="text-sm">Você é <b>Pro</b>{pro.plan === 'lifetime' ? ' vitalício' : ''}, válido até <b>{pro.expiresAt ? new Date(pro.expiresAt).toLocaleDateString('pt-BR') : '—'}</b>.</p>
        <div className="flex gap-2 flex-wrap"><button className="btn-ghost" onClick={goPro}>Ver detalhes do Pro</button>{checkout && <a className="btn-ghost" href={checkout} target="_blank" rel="noreferrer">Renovar</a>}</div>
      </> : <>
        <p className="text-sm muted">Versão grátis. Desbloqueie análise anual, metas automáticas, Excel e temas premium.</p>
        <button className="btn" onClick={goPro}><Crown size={16} /> Conhecer o Pro</button>
      </>}
    </section>
    <section className="card p-6 space-y-3">
      <h2 className="font-bold text-lg flex items-center gap-2"><ShieldCheck size={18} className="text-emerald-600" /> Conta e sincronização</h2>
      {auth.configured && user ? <>
        <div className="text-sm break-all">E-mail: <b>{email}</b></div>
        <div className="text-sm muted">{syncText}</div>
        <div className="flex gap-2 flex-wrap"><button className="btn-ghost" onClick={runSync}>Sincronizar agora</button><button className="btn-ghost" onClick={async () => { await auth.signOut(); window.location.reload() }}><LogOut size={15} /> Sair da conta</button></div>
        <button className="btn-ghost text-rose-600" onClick={async () => { if (!confirm('Excluir conta e todos os dados na nuvem? Isso é definitivo.')) return; const r = await auth.deleteAccount(); show(r.error || 'Conta excluída'); if (!r.error) window.location.reload() }}>Excluir conta</button>
        <p className="muted text-xs">A exclusão apaga seus dados na nuvem. Os dados locais deste aparelho continuam até você apagá-los em Ajustes → Zona de perigo.</p>
      </> : <p className="muted text-sm">Sem conta conectada: o NoAzul está em <b>modo local</b> e seus dados ficam só neste aparelho. Configure o Supabase para sincronizar entre dispositivos.</p>}
    </section>
    {auth.configured && user && <section className="card p-6 space-y-3">
      <h2 className="font-bold text-lg flex items-center gap-2"><KeyRound size={18} className="text-emerald-600" /> Alterar senha</h2>
      <Field label="Nova senha" value={pwd} onChange={(v: any) => setPwd(v)} placeholder="Mínimo 6 caracteres" type="password" />
      <Field label="Repita a nova senha" value={pwd2} onChange={(v: any) => setPwd2(v)} placeholder="••••••••" type="password" />
      <button className="btn" onClick={changePassword} disabled={busy}><KeyRound size={16} /> {busy ? 'Salvando...' : 'Atualizar senha'}</button>
    </section>}
  </div>
}

function Config({ userId, dark, setDark, categories, bills, payments, tx, reload, show, isPro, accent, setAccent, requirePro, checkoutUrl, setCheckoutUrl, licenseApiUrl, setLicenseApiUrl, goPro, goPerfil, pro, enqueueDelete }: any) {
  const [catName, setCatName] = useState(''); const [catType, setCatType] = useState<'in' | 'out'>('out')
  const [reminders, setReminders] = useState<ReminderSettings>({ enabled: false, daysBefore: 3, hour: 9 })
  const [permission, setPermission] = useState<string>(notificationPermission())
  useEffect(() => { getSetting('reminderSettings').then(v => setReminders(parseReminderSettings(v))) }, [])
  const saveReminders = (patch: Partial<ReminderSettings>) => { const next = { ...reminders, ...patch }; setReminders(next); setSetting('reminderSettings', JSON.stringify(next)) }
  const enableReminders = async (on: boolean) => { if (on) { const p = await requestNotifications(); setPermission(p); if (p === 'unsupported') return show('Este navegador não suporta notificações.'); if (p !== 'granted') return show('Permita notificações no navegador para receber lembretes.') } saveReminders({ enabled: on }) }
  const preview = dueBills(bills || [], payments || [], new Date(), reminders.daysBefore)
  return <div className="space-y-5 max-w-xl">
    <section className="card p-6 flex items-center gap-3">
      <UserRound size={22} className="text-emerald-600" />
      <div className="text-sm"><b>Perfil e conta</b><div className="muted text-xs">Nome, e-mail, senha, plano e sincronização.</div></div>
      <button className="link ml-auto shrink-0" onClick={goPerfil}>Abrir perfil</button>
    </section>
    <section className="card p-6 space-y-5">
      <h2 className="font-bold text-lg">Ajustes</h2>
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={dark} onChange={e => { setDark(e.target.checked); setSetting('theme', e.target.checked ? 'dark' : 'light') }} /> Modo escuro</label>
      <div>
        <div className="label">Cor do app {isPro ? '' : '(temas coloridos são Pro)'}</div>
        <div className="chips">{Object.entries(ACCENTS).map(([k, a]: any) => <button key={k} className="chip flex items-center gap-2" data-active={accent === k} onClick={() => { if (k !== 'esmeralda' && !isPro) return requirePro(); setAccent(k); setSetting('accent', k) }}><span className="swatch" style={{ background: a.brand }} />{a.label}{k !== 'esmeralda' && !isPro && <Lock size={11} />}</button>)}</div>
      </div>
      <div className="flex items-center gap-2 text-sm"><Crown size={16} className="text-amber-500" />{isPro ? <span>Pro ativo até {pro.expiresAt ? new Date(pro.expiresAt).toLocaleDateString('pt-BR') : '—'}</span> : <span>Versão grátis</span>}<button className="link ml-auto" onClick={goPro}>{isPro ? 'Ver Pro' : `Assinar por ${brl(PRO_PRICE_BRL)}/mês`}</button></div>
      <Field label="Link de pagamento da Cakto (dono do app)" value={checkoutUrl} onChange={(v: any) => { setCheckoutUrl(v); setSetting('caktoCheckoutUrl', v) }} placeholder="https://pay.cakto.com.br/seu-produto" />
      <p className="muted text-xs -mt-3">Crie o produto de assinatura de R$ 10/mês na Cakto e cole o link aqui. Também pode editar em src/config/plans.ts.</p>
      <Field label="URL do servidor de licenças (dono do app)" value={licenseApiUrl} onChange={(v: any) => { setLicenseApiUrl(v); setSetting('licenseApiUrl', v) }} placeholder="https://noazul-license.seu.workers.dev" />
      <p className="muted text-xs -mt-3">URL do Worker em server/. Com ela, o “Verificar assinatura” libera o Pro automaticamente pelo e-mail.</p>
    </section>
    <section className="card p-6 space-y-4">
      <h2 className="font-bold">Categorias</h2>
      <p className="muted text-sm">Crie categorias do seu jeito, por exemplo: Pet, Viagem, Presentes.</p>
      <div className="flex gap-2 flex-wrap">
        <input className="input flex-1 min-w-[140px]" placeholder="Nova categoria" value={catName} onChange={e => setCatName(e.target.value)} />
        <select className="input !w-auto" value={catType} onChange={e => setCatType(e.target.value as any)}><option value="out">Saída</option><option value="in">Entrada</option></select>
        <button className="btn" onClick={async () => { if (!catName.trim()) return show('Informe o nome da categoria'); try { await addCategory(catName.trim(), catType, userId); await reload(); setCatName(''); show('Categoria criada') } catch (e:any) { show(e?.message || 'Não foi possível salvar.') } }}><Plus size={16} /> Criar</button>
      </div>
      {(['out', 'in'] as const).map(tp => <div key={tp}><div className="label">{tp === 'out' ? 'Saídas' : 'Entradas'}</div><div className="chips">{categories.filter((c: any) => c.type === tp).map((c: any) => <span key={c.name} className="chip flex items-center gap-1">{c.name}<button onClick={async () => { if (!confirm(`Apagar a categoria ${c.name}?`)) return; try { await deleteCategory(c.name, tp, userId); enqueueDelete('categories', { ...c, id: c.name }); await reload() } catch (e:any) { show(e?.message || 'Não foi possível excluir.') } }} aria-label="Apagar categoria"><Trash2 size={12} /></button></span>)}</div></div>)}
    </section>
    <section className="card p-6 space-y-4">
      <h2 className="font-bold">Lembretes de contas</h2>
      <p className="muted text-sm">Avisos do navegador quando uma conta fixa estiver perto de vencer. O lembrete aparece uma vez por dia com o app aberto.</p>
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={reminders.enabled} onChange={e => enableReminders(e.target.checked)} /> Ativar lembretes</label>
      <div className="flex gap-3 flex-wrap">
        <label className="text-sm">Avisar com antecedência<select className="input mt-1" value={reminders.daysBefore} onChange={e => saveReminders({ daysBefore: Number(e.target.value) })}><option value={0}>No dia</option><option value={1}>1 dia</option><option value={3}>3 dias</option><option value={7}>7 dias</option><option value={14}>14 dias</option></select></label>
        <label className="text-sm">Horário<select className="input mt-1" value={reminders.hour} onChange={e => saveReminders({ hour: Number(e.target.value) })}>{[8, 9, 12, 18, 20].map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></label>
      </div>
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <button className="btn-ghost" onClick={() => requestNotifications().then(p => { setPermission(p); show(p === 'granted' ? 'Notificações permitidas' : 'Permissão não concedida') })}>Permitir notificações</button>
        <button className="btn-ghost" onClick={async () => { const ok = await showReminderNotification('NoAzul: contas chegando', 'Teste de lembrete — tudo funcionando!'); show(ok ? 'Notificação enviada' : 'Ative a permissão de notificações primeiro') }}>Testar</button>
        <span className="muted">{permission === 'granted' ? 'Notificações permitidas' : permission === 'denied' ? 'Notificações bloqueadas no navegador' : permission === 'unsupported' ? 'Navegador sem suporte' : 'Permissão pendente'}</span>
      </div>
      {preview.length > 0 && <p className="muted text-xs">Agora: {reminderMessage(preview, 2)}</p>}
    </section>
    <section className="card p-6 space-y-4">
      <h2 className="font-bold">Seus dados</h2>
      <div className="flex gap-2 flex-wrap">
        <button className="btn-ghost" onClick={async () => { try { const b = await exportBackup(); const u = URL.createObjectURL(new Blob([b as any], { type: 'application/octet-stream' })); const a = document.createElement('a'); a.href = u; a.download = 'noazul-backup.db'; a.click(); show('Cópia baixada') } catch (e:any) { show(e?.message || 'Não foi possível baixar a cópia.') } }}><Download size={15} /> Baixar cópia</button>
        <button className="btn-ghost" onClick={async () => { try { const [transactions, fixedBills, goals, budgets, billPayments, recurrences, recurrenceLaunches, categories, goalAutoLaunches, investments, investmentTransactions] = await Promise.all([listTransactions(userId), listFixedBills(userId), listGoals(userId), listBudgets(userId), listBillPayments(userId), listRecurrences(userId), listRecurrenceLaunches(userId), listCategories(userId), listGoalAutoLaunches(userId), listInvestments(userId), listAllInvestmentTransactions(userId)]); const payload = { exportedAt: new Date().toISOString(), transactions, fixedBills, goals, budgets, billPayments, recurrences, recurrenceLaunches, categories, goalAutoLaunches, investments, investmentTransactions }; const u = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = 'noazul-dados.json'; a.click(); URL.revokeObjectURL(u); show('JSON exportado') } catch (e:any) { show(e?.message || 'Não foi possível exportar o JSON.') } }}><Download size={15} /> Exportar JSON</button>
        <label className="btn-ghost cursor-pointer"><Upload size={15} /> Restaurar cópia<input type="file" className="hidden" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { await importBackup(new Uint8Array(await f.arrayBuffer())); await reload(); show('Dados restaurados') } catch (err:any) { show(err?.message || 'Não foi possível restaurar.') } }} /></label>
        <label className="btn-ghost cursor-pointer"><Upload size={15} /> Importar OFX/CSV<input type="file" accept=".csv,.ofx,.qfx,text/csv,application/x-ofx" className="hidden" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { const text = await f.text(); const rows = /\.(ofx|qfx)$/i.test(f.name) || looksLikeOfx(text) ? parseOfx(text) : parseCsvImport(text); if (!rows.length) return show('Nenhum lançamento válido encontrado no arquivo'); const known = tx.slice(); let imported = 0; let skipped = 0; for (const r of rows) { const t = { ...r, userId }; if (known.some((k: any) => k.date === t.date && k.type === t.type && k.amount === t.amount && (k.description || '').trim().toLowerCase() === (t.description || '').trim().toLowerCase())) { skipped++; continue } await addTransaction(t); known.push(t); imported++ } await reload(); show(`${imported} lançamento(s) importado(s)${skipped ? ` • ${skipped} duplicado(s) ignorado(s)` : ''}`) } catch (err:any) { show(err?.message || 'Não foi possível importar.') } }} /></label>
      </div>
      <p className="muted text-xs">CSV no formato Data;Descrição;Tipo;Categoria;Valor (o mesmo que o app exporta) ou extrato OFX/QFX do banco. Lançamentos idênticos são ignorados. A cópia completa guarda tudo em um arquivo só — ela também contém sua licença e dados financeiros, então guarde em local seguro.</p>
    </section>
    <section className="card p-6 space-y-3" style={{ borderColor: '#FECDD3' }}>
      <h2 className="font-bold text-rose-600">Zona de perigo</h2>
      <p className="muted text-sm">Apaga todos os movimentos, contas, metas, limites e recorrências deste aparelho. Não tem como desfazer.</p>
      <button className="btn-ghost text-rose-600" onClick={async () => { if (!confirm('Tem certeza? Todos os seus dados serão apagados.')) return; if (!confirm('Última chance: apagar tudo mesmo?')) return; try { await clearAllData(userId); await reload(); show('Todos os dados foram apagados') } catch (e:any) { show(e?.message || 'Não foi possível apagar.') } }}><Trash2 size={15} /> Apagar todos os meus dados</button>
    </section>
    <section className="card p-6">
      <div className="font-bold text-sm">Sobre o NoAzul</div>
      <p className="muted text-sm mt-1 leading-relaxed">O NoAzul mantém suas finanças no azul: registre o que entra e sai, veja quanto sobra, acompanhe contas fixas, limites, recorrências e metas. Feito para pessoas comuns, sem jargão. Funciona no navegador e pode virar app de desktop.</p>
      <div className="flex gap-4 mt-3 text-sm"><a className="link" href="/termos.html" target="_blank" rel="noreferrer">Termos de Uso</a><a className="link" href="/privacidade.html" target="_blank" rel="noreferrer">Política de Privacidade</a><a className="link" href="mailto:suporte@noazul.app.br">Suporte</a></div>
    </section>
  </div>
}
