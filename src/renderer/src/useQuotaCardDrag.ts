import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'

type DragSession = {
  id: string
  pointer: number
  x: number
  y: number
  dx: number
  dy: number
  order: string[]
  initial: string[]
  ghost?: HTMLElement
  timer?: ReturnType<typeof setTimeout>
  handle: HTMLElement
  cleanup?: () => void
  activate?: () => void
  pointerType: string
}

export function useQuotaCardDrag(
  ids: string[],
  save: (ids: string[]) => Promise<unknown>,
  disabled: boolean
) {
  const grid = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<string[]>()
  const [dragging, setDragging] = useState<string>()
  const positions = useRef(new Map<string, DOMRect>())
  const session = useRef<DragSession | undefined>(undefined)
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const cards = () =>
    Array.from(grid.current?.querySelectorAll<HTMLElement>('[data-quota-id]') ?? [])
  const remember = () => {
    positions.current = new Map(
      cards().map((card) => [card.dataset.quotaId!, card.getBoundingClientRect()])
    )
  }
  useLayoutEffect(() => {
    for (const card of cards()) {
      const old = positions.current.get(card.dataset.quotaId!)
      const next = card.getBoundingClientRect()
      if (old && !reduced() && (old.left !== next.left || old.top !== next.top)) {
        card.animate(
          [
            { transform: `translate(${old.left - next.left}px, ${old.top - next.top}px)` },
            { transform: 'translate(0, 0)' }
          ],
          { duration: 200, easing: 'ease-out' }
        )
      }
    }
    positions.current.clear()
  }, [preview, ids.join('|')])
  const finish = (commit: boolean) => {
    const current = session.current
    if (!current) return
    session.current = undefined
    clearTimeout(current.timer)
    current.cleanup?.()
    setDragging(undefined)
    if (!current.ghost) return
    const ghost = current.ghost
    const target = cards()
      .find((card) => card.dataset.quotaId === current.id)
      ?.getBoundingClientRect()
    if (commit && target && !reduced()) {
      const animation = ghost.animate(
        [
          {
            transform: ghost.style.transform,
            left: ghost.style.left,
            top: ghost.style.top,
            opacity: 0.95
          },
          {
            transform: 'translate(0, 0) scale(1)',
            left: `${target.left}px`,
            top: `${target.top}px`,
            opacity: 0
          }
        ],
        { duration: 180, easing: 'ease-out' }
      )
      void animation.finished.then(
        () => ghost.remove(),
        () => ghost.remove()
      )
    } else ghost.remove()
    if (commit && current.order.join('|') !== current.initial.join('|')) {
      void save(current.order).finally(() => setPreview(undefined))
    } else {
      remember()
      setPreview(undefined)
    }
  }
  useEffect(
    () => () => {
      const current = session.current
      clearTimeout(current?.timer)
      current?.cleanup?.()
      current?.ghost?.remove()
      session.current = undefined
    },
    []
  )
  const pointerDown = (event: ReactMouseEvent<HTMLButtonElement>, id: string) => {
    if (disabled || event.button !== 0 || session.current) return
    // Prevent Chromium from starting image/text native drag after the long press.
    event.preventDefault()
    const handle = event.currentTarget
    handle.focus({ preventScroll: true })
    const current = {
      id,
      pointer: 1,
      pointerType: 'mouse',
      x: event.clientX,
      y: event.clientY,
      dx: 0,
      dy: 0,
      order: [...ids],
      initial: [...ids],
      handle
    } as DragSession
    session.current = current
    // Use one mouse-event stream per gesture. Handling both pointermove and
    // mousemove can reverse a reorder before React commits the new layout.
    const mouseMove = (event: MouseEvent) =>
      pointerMove({
        pointerId: current.pointer,
        clientX: event.clientX,
        clientY: event.clientY,
        preventDefault: () => event.preventDefault()
      })
    const up = () => finish(true)
    const cancel = () => finish(false)
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
    }
    window.addEventListener('mousemove', mouseMove, { capture: true, passive: false })
    window.addEventListener('mouseup', up, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key, true)
    current.cleanup = () => {
      window.removeEventListener('mousemove', mouseMove, true)
      window.removeEventListener('mouseup', up, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key, true)
    }
    current.activate = () => {
      if (current.ghost) return
      clearTimeout(current.timer)
      const card = handle.closest<HTMLElement>('[data-quota-id]')
      if (!card || session.current !== current) return
      const bounds = card.getBoundingClientRect()
      const ghost = card.cloneNode(true) as HTMLElement
      ghost.removeAttribute('data-quota-id')
      ghost.removeAttribute('aria-label')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.inert = true
      ghost.classList.add('quota-drag-ghost')
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${bounds.left}px`,
        top: `${bounds.top}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        margin: '0',
        zIndex: '1000',
        pointerEvents: 'none',
        transform: `translate(${current.dx}px, ${current.dy}px) scale(1.025)`
      })
      document.body.append(ghost)
      current.ghost = ghost
      setDragging(id)
      setPreview(current.order)
      if (!reduced())
        ghost.animate([{ opacity: 0.6 }, { opacity: 1 }], {
          duration: 160,
          easing: 'ease-out'
        })
    }
    current.timer = setTimeout(current.activate, 350)
  }
  const pointerMove = (
    event: Pick<globalThis.PointerEvent, 'pointerId' | 'clientX' | 'clientY' | 'preventDefault'>
  ) => {
    const current = session.current
    if (!current || current.pointer !== event.pointerId) return
    current.dx = event.clientX - current.x
    current.dy = event.clientY - current.y
    if (
      !current.ghost &&
      current.pointerType === 'mouse' &&
      Math.hypot(current.dx, current.dy) >= 8
    )
      current.activate?.()
    if (!current.ghost) return
    event.preventDefault()
    current.ghost.style.transform = `translate(${current.dx}px, ${current.dy}px) scale(1.025)`
    // Hit-test final layout slots, not their animated positions, to prevent oscillation.
    const target = cards().find((card) => {
      const rect = card.getBoundingClientRect()
      const transform = getComputedStyle(card).transform
      const matrix = transform === 'none' ? undefined : new DOMMatrixReadOnly(transform)
      const left = rect.left - (matrix?.m41 ?? 0),
        top = rect.top - (matrix?.m42 ?? 0)
      return (
        event.clientX >= left &&
        event.clientX <= left + rect.width &&
        event.clientY >= top &&
        event.clientY <= top + rect.height
      )
    })
    const targetId = target?.dataset.quotaId
    if (!targetId || targetId === current.id || !grid.current?.contains(target!)) return
    const from = current.order.indexOf(current.id),
      to = current.order.indexOf(targetId)
    if (from < 0 || to < 0) return
    remember()
    const next = [...current.order]
    next.splice(from, 1)
    next.splice(to, 0, current.id)
    current.order = next
    setPreview(next)
  }
  return {
    grid,
    order: preview ?? ids,
    dragging,
    pointerDown,
    pointerMove,
    pointerUp: () => finish(true),
    pointerCancel: () => finish(false)
  }
}
