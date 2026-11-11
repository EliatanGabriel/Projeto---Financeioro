import type { BillPayment, FixedBill } from '../types'

export interface ReminderSettings {
  enabled: boolean
  daysBefore: number
  hour: number
}

export const REMINDER_DEFAULTS: ReminderSettings = { enabled: false, daysBefore: 3, hour: 9 }

export function parseReminderSettings(raw?: string | null): ReminderSettings {
  if (!raw) return { ...REMINDER_DEFAULTS }
  try {
    const v = JSON.parse(raw)
    return {
      enabled: v?.enabled === true,
      daysBefore: Math.min(14, Math.max(0, Number(v?.daysBefore) || REMINDER_DEFAULTS.daysBefore)),
      hour: Math.min(23, Math.max(0, Number(v?.hour) || REMINDER_DEFAULTS.hour)),
    }
  } catch {
    return { ...REMINDER_DEFAULTS }
  }
}

export interface DueBill {
  bill: FixedBill
  due: Date
  days: number
}

function monthKeyOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function dueDateFor(year: number, month: number, dueDay: number) {
  const lastDay = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(Math.max(1, dueDay || 1), lastDay))
}

export function dueBills(bills: FixedBill[], payments: BillPayment[], now = new Date(), daysBefore = 3): DueBill[] {
  const paid = new Set(payments.filter((p) => p.month === monthKeyOf(now)).map((p) => p.billId))
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const out: DueBill[] = []
  for (const bill of bills) {
    if (paid.has(bill.id)) continue
    const due = dueDateFor(now.getFullYear(), now.getMonth(), bill.dueDay)
    const days = Math.round((due.getTime() - today.getTime()) / 86400000)
    if (days <= daysBefore && days >= -5) out.push({ bill, due, days })
  }
  return out.sort((a, b) => a.due.getTime() - b.due.getTime())
}

export function reminderMessage(items: DueBill[], max = 3): string {
  const parts = items.slice(0, max).map(({ bill, days }) => {
    if (days < 0) return `${bill.name} venceu há ${Math.abs(days)} dia${Math.abs(days) === 1 ? '' : 's'}`
    if (days === 0) return `${bill.name} vence hoje`
    if (days === 1) return `${bill.name} vence amanhã`
    return `${bill.name} vence em ${days} dias`
  })
  const rest = items.length - Math.min(max, items.length)
  return parts.join(' • ') + (rest > 0 ? ` • e mais ${rest}` : '')
}

export function reminderFingerprint(items: DueBill[], now = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return day + ':' + items.map((i) => i.bill.id).sort().join(',')
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported'
}

export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported'
  try { return await Notification.requestPermission() } catch { return Notification.permission }
}

export async function showReminderNotification(title: string, body: string): Promise<boolean> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false
  const options: NotificationOptions = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'noazul-bills',
    data: { url: '/' },
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) { await reg.showNotification(title, options); return true }
  } catch { /* cai para Notification direta */ }
  try { new Notification(title, options); return true } catch { return false }
}
