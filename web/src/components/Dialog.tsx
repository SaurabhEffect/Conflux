import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Icon } from './Icons'

type Props = {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}

export function Dialog({ title, onClose, children, wide = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close()
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  )
}
