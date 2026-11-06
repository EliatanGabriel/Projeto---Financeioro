import { useEffect, useState } from 'react'
import { supabase, supabaseConfigured } from '../supabase/client'
import type { Session, User } from '@supabase/supabase-js'

export interface AuthState {
  configured: boolean; loading: boolean; session: Session | null; user: User | null
  signUp: (name: string, email: string, password: string) => Promise<{ error: string | null; needsConfirmation?: boolean }>
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<{ error: string | null }>
  updatePassword: (password: string) => Promise<{ error: string | null }>
  deleteAccount: () => Promise<{ error: string | null }>
}

export function useAuth(): AuthState {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(supabaseConfigured)

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const err = (e: any) => e?.message || 'Erro inesperado. Tente novamente.'

  return {
    configured: supabaseConfigured, loading, session, user: session?.user ?? null,
    async signUp(name, email, password) {
      if (!supabase) return { error: 'Supabase não configurado.' }
      const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: window.location.origin } })
      if (error) return { error: err(error) }
      return { error: null, needsConfirmation: !data.session }
    },
    async signIn(email, password) {
      if (!supabase) return { error: 'Supabase não configurado.' }
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      return { error: error ? err(error) : null }
    },
    async signOut() { try { await supabase?.auth.signOut() } catch {} },
    async resetPassword(email) {
      if (!supabase) return { error: 'Supabase não configurado.' }
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/redefinir` })
      return { error: error ? err(error) : null }
    },
    async updatePassword(password) {
      if (!supabase) return { error: 'Supabase não configurado.' }
      const { error } = await supabase.auth.updateUser({ password })
      return { error: error ? err(error) : null }
    },
    async deleteAccount() {
      if (!supabase) return { error: 'Supabase não configurado.' }
      try {
        const res = await supabase.functions.invoke('delete-account', { method: 'POST' })
        if (res.error) return { error: res.error.message || 'Não foi possível excluir a conta.' }
        await supabase.auth.signOut()
        return { error: null }
      } catch (e: any) { return { error: err(e) } }
    },
  }
}
