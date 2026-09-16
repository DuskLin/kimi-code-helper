import { useEffect, useRef, useState, type ReactNode } from 'react'

// 保留原生滚动与键盘行为，悬浮滑块不占用表单布局宽度。
export function OverlayScrollArea({ children, label }: { children: ReactNode; label: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const drag = useRef<{ offset: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const [thumb, setThumb] = useState({ height: 0, top: 0, overflow: false })

  function measure() {
    const scroll = scrollRef.current,
      track = trackRef.current
    if (!scroll || !track) return
    const overflow = scroll.scrollHeight > scroll.clientHeight + 1
    const height = Math.min(
      track.clientHeight,
      Math.max(28, (track.clientHeight * scroll.clientHeight) / Math.max(1, scroll.scrollHeight))
    )
    const top = overflow
      ? (scroll.scrollTop / (scroll.scrollHeight - scroll.clientHeight)) *
        (track.clientHeight - height)
      : 0
    setThumb({ height, top, overflow })
  }
  function hideLater() {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (!drag.current) setVisible(false)
    }, 1000)
  }
  function reveal() {
    setVisible(true)
    hideLater()
  }
  function moveThumb(clientY: number) {
    const scroll = scrollRef.current,
      track = trackRef.current
    if (!scroll || !track || !drag.current) return
    const y = clientY - track.getBoundingClientRect().top - drag.current.offset
    const ratio = Math.min(1, Math.max(0, y / Math.max(1, track.clientHeight - thumb.height)))
    scroll.scrollTop = ratio * (scroll.scrollHeight - scroll.clientHeight)
  }
  useEffect(() => {
    const observer = new ResizeObserver(measure)
    if (scrollRef.current) observer.observe(scrollRef.current)
    if (contentRef.current) observer.observe(contentRef.current)
    measure()
    return () => {
      observer.disconnect()
      clearTimeout(hideTimer.current)
    }
  }, [])

  return (
    <div className="modal-scroll-shell">
      <div
        className="modal-scroll-body"
        ref={scrollRef}
        tabIndex={0}
        aria-label={label}
        onScroll={() => {
          measure()
          reveal()
        }}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      <div
        className={`modal-scroll-track ${thumb.overflow && visible ? 'is-visible' : ''}`}
        ref={trackRef}
        aria-hidden="true"
        onPointerEnter={() => clearTimeout(hideTimer.current)}
        onPointerLeave={hideLater}
        onPointerDown={(event) => {
          event.preventDefault()
          const y = event.clientY - event.currentTarget.getBoundingClientRect().top
          drag.current = {
            offset:
              y >= thumb.top && y <= thumb.top + thumb.height ? y - thumb.top : thumb.height / 2
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          reveal()
          moveThumb(event.clientY)
        }}
        onPointerMove={(event) => {
          if (drag.current) moveThumb(event.clientY)
        }}
        onPointerUp={(event) => {
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          hideLater()
        }}
        onLostPointerCapture={() => {
          drag.current = null
          hideLater()
        }}
      >
        <div
          className="modal-scroll-thumb"
          style={{ height: thumb.height, transform: `translateY(${thumb.top}px)` }}
        />
      </div>
    </div>
  )
}
