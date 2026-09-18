import { useEffect, useRef, useState } from 'react'
import { Star } from 'lucide-react'
import { Modal } from './Modal'

const welcomeStorageKey = 'navo.star-welcome.seen'

export function StarWelcome() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(welcomeStorageKey) !== 'true'
    } catch {
      return true
    }
  })
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)

  useEffect(() => {
    if (!open) return
    try {
      localStorage.setItem(welcomeStorageKey, 'true')
    } catch {
      // The welcome remains dismissible when storage is unavailable.
    }
  }, [open])

  async function openProject() {
    if (busy.current) return
    busy.current = true
    setOpening(true)
    setError('')
    try {
      await window.navo.openProjectPage()
      setOpen(false)
    } catch {
      setError('暂时无法打开浏览器，请重试，或访问 github.com/DuskLin/navo。')
    } finally {
      busy.current = false
      setOpening(false)
    }
  }

  if (!open) return null

  return (
    <Modal title="欢迎使用 Navo" close={() => setOpen(false)} className="star-welcome">
      <div className="star-welcome-icon" aria-hidden="true">
        <Star size={28} />
      </div>
      <h3>一颗小星星，是继续创造的动力</h3>
      <p>
        很高兴与你相遇！如果你喜欢 Navo，欢迎在 GitHub 为项目点一颗 Star。
        你的支持，会给开发者带来更多持续打磨产品的动力。
      </p>
      <p>我会持续改进产品体验，也会陆续加入新的试验性功能， 和你一起探索更多可能。</p>
      <p className="star-welcome-note">这份邀请只出现一次。你可以先体验，喜欢时再来支持。</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button" onClick={() => setOpen(false)}>
          先体验一下
        </button>
        <button
          type="button"
          className="button primary"
          disabled={opening}
          onClick={() => void openProject()}
        >
          <Star size={15} aria-hidden="true" />
          {opening ? '正在打开…' : '去 GitHub 点星'}
        </button>
      </div>
    </Modal>
  )
}
