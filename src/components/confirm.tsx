import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

export interface ConfirmOptions {
  danger?: boolean
  confirmLabel?: string
  title?: string
}

type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>

let handler: ConfirmFn | null = null

/**
 * Substituto async do confirm() nativo, com a cara do app.
 * Uso: if (!await confirmDialog('Apagar esta conta?')) return
 * Fora do app (ou antes do ConfirmHost montar), cai para o confirm nativo.
 */
export const confirmDialog: ConfirmFn = (message, opts) =>
  handler ? handler(message, opts) : Promise.resolve(window.confirm(message))

export function ConfirmHost() {
  const [state, setState] = useState<{ message: string; opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null)
  useEffect(() => {
    handler = (message, opts = {}) => new Promise(resolve => setState({ message, opts, resolve }))
    return () => { handler = null }
  }, [])
  if (!state) return null
  const close = (v: boolean) => { state.resolve(v); setState(null) }
  const danger = state.opts.danger ?? true
  return (
    <div className="modal-backdrop" onClick={() => close(false)}>
      <div className="modal card" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={state.opts.title || 'Confirmar'}>
        <div className="flex items-center gap-3">
          <div className="stat-icon" style={{ background: danger ? '#FFE4E6' : '#D1FAE5', color: danger ? '#9F1239' : '#065F46' }}><AlertTriangle size={20} /></div>
          <div className="font-extrabold text-lg">{state.opts.title || 'Você tem certeza?'}</div>
        </div>
        <p className="text-sm mt-3 leading-relaxed">{state.message}</p>
        <div className="flex gap-2 mt-5 justify-end">
          <button className="btn-ghost" onClick={() => close(false)}>Cancelar</button>
          <button className="btn" style={danger ? { background: '#E11D63' } : undefined} onClick={() => close(true)}>{state.opts.confirmLabel || (danger ? 'Apagar' : 'Confirmar')}</button>
        </div>
      </div>
    </div>
  )
}
