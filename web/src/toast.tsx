import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type Toast = { id: number; message: string; kind: 'info' | 'error' }
type Show = (message: string, kind?: Toast['kind']) => void

const ToastContext = createContext<Show>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const show = useCallback<Show>((message, kind = 'info') => {
    const id = nextId.current++
    setToasts((current) => [...current.slice(-3), { id, message, kind }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), kind === 'error' ? 7000 : 4000)
  }, [])

  const value = useMemo(() => show, [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
