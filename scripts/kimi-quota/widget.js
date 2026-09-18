// 展示已启用的 Navo 账号；不推断 Desktop 登录账号或当前会话调度账号。
;(() => {
  if (document.getElementById('navo-quota-widget')) return
  const host = document.createElement('div')
  host.id = 'navo-quota-widget'
  host.style.cssText = 'position:fixed;z-index:1000;-webkit-app-region:no-drag;pointer-events:none'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>
    :host {font:12px -apple-system,BlinkMacSystemFont,sans-serif;color:var(--color-text,#303238)}
    *{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer;-webkit-app-region:no-drag}
    [hidden]{display:none!important}.bar{display:flex;align-items:center;gap:6px;pointer-events:auto;height:32px}
    .accounts{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;min-width:0;padding:2px 0}
    .accounts::-webkit-scrollbar{display:none}
    .account{flex:0 0 var(--card-width,252px);scroll-snap-align:start;display:flex;align-items:center;justify-content:space-between;gap:8px;height:28px;padding:4px 9px;border:1px solid var(--color-line,#e5e7eb);border-radius:7px;background:var(--color-bg,#fff);white-space:nowrap}
    .account:hover,.account[aria-expanded=true]{border-color:#77b69a;background:color-mix(in srgb,var(--color-bg,#fff) 94%,#42aa80)}
    .account:focus-visible,.nav:focus-visible{outline:2px solid #42aa80;outline-offset:-2px}
    .name{max-width:66px;overflow:hidden;text-overflow:ellipsis;font-weight:550}.stat{display:flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}.muted{color:#8a8f99}
    .track{width:27px;height:4px;background:var(--color-line,#e9ebef);border-radius:4px;overflow:hidden}.fill{height:100%;background:#3b9e78;border-radius:4px}
    .nav{flex:0 0 20px;width:20px;height:24px;padding:0;border:0;border-radius:5px;background:var(--color-bg,#fff);color:#8a8f99;font-size:17px}.nav:disabled{opacity:.3;cursor:default}
    .empty{padding:5px 10px;color:#8a8f99;white-space:nowrap}
    .panel{position:fixed;width:340px;padding:18px;border:1px solid var(--color-line,#e4e6ea);border-radius:14px;background:var(--color-bg,#fff);box-shadow:0 12px 40px #0002;pointer-events:auto}
    h3{font-size:14px;margin:0 0 5px}.sub{font-size:11px;color:#8a8f99;line-height:1.7}.account-name{font-size:13px;margin-top:15px;font-weight:600;overflow-wrap:anywhere}
    .row{margin:12px 0 17px}.labels{display:flex;justify-content:space-between;margin-bottom:8px}.large{width:100%;height:5px}.reset{margin-top:6px;font-size:11px;color:#8a8f99}
    footer{border-top:1px solid var(--color-line,#eee);padding-top:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:#8a8f99}.refresh{border:0;background:none;color:#3b9e78;padding:3px}.warn{color:#ba8540}
    :host([compact]) .account .track{display:none}:host([compact]) .account{gap:4px;padding:4px 6px}:host([compact]) .name{max-width:48px}
  </style><div class="bar"><button class="nav prev" aria-label="向左查看账号" hidden>‹</button><div class="accounts" role="group" aria-label="Navo 已启用账号额度"></div><button class="nav next" aria-label="向右查看账号" hidden>›</button></div>
  <section class="panel" aria-label="账号额度详情" hidden><h3>Navo 账号额度 <span class="sub">实验版</span></h3><div class="sub">Navo 已启用账号 · 非 Desktop 登录账号绑定</div><div class="account-name"></div><div class="details"></div><footer><span class="status"></span><button class="refresh">重新读取</button></footer></section>`
  document.body.append(host)
  const $ = (s) => root.querySelector(s)
  let data = null,
    failed = false,
    selected = '',
    disabled = false,
    cardWidth = 252
  const cards = new Map()
  const values = [
    ['fiveHour', '5h', '5 小时窗口'],
    ['weekly', '周', '7 天窗口']
  ]
  const percent = (w, checkedAt) => {
    if (
      !w ||
      !checkedAt ||
      Date.now() - checkedAt > 120000 ||
      (w.resetAt && Date.parse(w.resetAt) <= Date.now())
    )
      return null
    if (!Number.isFinite(w.remaining) || !Number.isFinite(w.limit) || w.limit <= 0) return null
    return Math.max(0, Math.min(100, (w.remaining / w.limit) * 100))
  }
  const stale = () => failed || !data || Date.now() - data.exportedAt > 20000
  const provider = (a) =>
    ({ kimi: 'Kimi', 'opencode-go': 'Go', deepseek: 'DS' })[a.provider || 'kimi'] || '账号'
  const balanceText = (a) =>
    stale() || !a.checkedAt || Date.now() - a.checkedAt > 120000
      ? '等待更新'
      : a.balance?.balances
          ?.map((b) => `${b.currency} ${Number(b.balance).toFixed(2)}`)
          .join(' · ') || '暂无余额'
  const meter = (p, large = false) =>
    `<div class="track ${large ? 'large' : ''}"><div class="fill" style="width:${p ?? 0}%;background:${p !== null && p < 20 ? '#d99444' : '#3b9e78'}"></div></div>`
  function close() {
    $('.panel').hidden = true
    for (const button of cards.values()) button.setAttribute('aria-expanded', 'false')
  }
  function details() {
    const a = data?.accounts.find((x) => x.id === selected)
    if (!a) {
      close()
      return
    }
    $('.account-name').textContent = `${provider(a)} · ${a.name}` + (a.enabled ? '' : '（已停用）')
    $('.details').innerHTML = (a.monthly ? [...values, ['monthly', '月', '月度窗口']] : values)
      .map(([key, , label]) => {
        const p = stale() ? null : percent(a[key], a.checkedAt)
        const time = Date.parse(a[key]?.resetAt || '')
        const reset = Number.isFinite(time)
          ? new Date(time).toLocaleString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            }) + ' 重置'
          : '重置时间未知'
        return `<div class="row"><div class="labels"><span>${label}</span><strong>${p === null ? '等待更新' : '剩余 ' + Math.round(p) + '%'}</strong></div>${meter(p, true)}<div class="reset">${reset}</div></div>`
      })
      .join('')
    if (a.provider === 'deepseek') {
      $('.details').replaceChildren()
      const row = document.createElement('p')
      row.textContent = '按量付费余额：' + balanceText(a)
      $('.details').append(row)
    }
    $('.status').textContent = stale()
      ? 'Navo 未连接或数据同步已停止'
      : !a.checkedAt || Date.now() - a.checkedAt > 120000
        ? '额度已过期，等待 Navo 更新'
        : `额度更新于 ${new Date(a.checkedAt).toLocaleTimeString('zh-CN')}`
    $('.status').classList.toggle('warn', stale())
  }
  function render() {
    const accounts = data?.accounts || []
    for (const [id, button] of cards)
      if (!accounts.some((a) => a.id === id)) {
        button.remove()
        cards.delete(id)
      }
    $('.empty')?.remove()
    if (!accounts.length) {
      const empty = document.createElement('span')
      empty.className = 'empty'
      empty.textContent = failed ? '等待 Navo 连接' : '暂无已启用账号'
      $('.accounts').append(empty)
    }
    accounts.forEach((a, index) => {
      let button = cards.get(a.id)
      if (!button) {
        button = document.createElement('button')
        button.className = 'account'
        button.innerHTML =
          '<span class="name"></span><span class="stats" style="display:contents"></span>'
        button.setAttribute('aria-expanded', 'false')
        button.onclick = () => {
          const same = selected === a.id && !$('.panel').hidden
          close()
          selected = a.id
          if (!same) {
            $('.panel').hidden = false
            button.setAttribute('aria-expanded', 'true')
            details()
            position()
          }
        }
        cards.set(a.id, button)
      }
      if ($('.accounts').children[index] !== button)
        $('.accounts').insertBefore(button, $('.accounts').children[index] || null)
      button.querySelector('.name').textContent = `${provider(a)} ${a.name}`
      button.setAttribute('aria-label', `查看 ${a.name} 额度`)
      button.title = `${provider(a)} · ${a.name}${a.enabled ? '' : '（已停用）'} · 剩余额度 · 点击查看详情`
      button.querySelector('.stats').innerHTML = values
        .map(([key, label]) => {
          const p = stale() ? null : percent(a[key], a.checkedAt)
          return `<span class="stat"><span class="muted">${label}</span>${meter(p)}<span>${p === null ? '—' : Math.round(p) + '%'}</span></span>`
        })
        .join('')
      if (a.provider === 'deepseek') button.querySelector('.stats').textContent = balanceText(a)
    })
    if (!$('.panel').hidden) details()
    position()
  }
  async function refresh() {
    try {
      const r = await fetch('/assets/navo-quota-data.json?t=' + Date.now(), { cache: 'no-store' })
      if (!r.ok) throw new Error('not ready')
      const next = await r.json()
      if (!Array.isArray(next.accounts)) throw new Error('invalid data')
      disabled = next.enabled === false
      data = { ...next, accounts: next.accounts.filter((a) => a.enabled === true) }
      failed = false
    } catch {
      failed = true
    }
    render()
  }
  function arrows() {
    const list = $('.accounts')
    $('.prev').disabled = list.scrollLeft < 2
    $('.next').disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 2
  }
  function position() {
    const header = [...document.querySelectorAll('.chat-header')].find(
      (el) => el.getBoundingClientRect().width > 0
    )
    const spacer = header?.querySelector('.ch-spacer')
    if (!header || !spacer || disabled) {
      host.style.display = 'none'
      return
    }
    const r = header.getBoundingClientRect(),
      s = spacer.getBoundingClientRect()
    // 使用真实弹性空白区，左右留白；不再用固定偏移猜测操作按钮位置。
    const available = Math.floor(s.width - 48)
    if (available < 155) {
      host.style.display = 'none'
      return
    }
    const n = Math.max(1, data?.accounts.length || 1)
    let count = Math.max(1, Math.min(3, n, Math.floor((available + 8) / 260)))
    let overflow = n > count
    if (overflow) count = Math.max(1, Math.min(count, Math.floor((available - 52 + 8) / 260)))
    overflow = n > count
    const navWidth = overflow && available >= 207 ? 52 : 0
    cardWidth = Math.min(252, Math.floor((available - navWidth - (count - 1) * 8) / count))
    host.toggleAttribute('compact', cardWidth < 230)
    host.style.setProperty('--card-width', `${cardWidth}px`)
    host.style.display = ''
    host.style.top = `${r.top + (r.height - 32) / 2}px`
    host.style.right = `${innerWidth - s.right + 24}px`
    host.style.width = `${count * cardWidth + (count - 1) * 8 + navWidth}px`
    host.dataset.visibleCount = String(count)
    $('.prev').hidden = $('.next').hidden = !navWidth
    $('.accounts').style.width = `${count * cardWidth + (count - 1) * 8}px`
    $('.panel').style.top = `${r.bottom + 8}px`
    $('.panel').style.right = `${Math.max(12, innerWidth - s.right + 24)}px`
    arrows()
  }
  $('.prev').onclick = () => $('.accounts').scrollBy({ left: -(cardWidth + 8), behavior: 'smooth' })
  $('.next').onclick = () => $('.accounts').scrollBy({ left: cardWidth + 8, behavior: 'smooth' })
  $('.accounts').addEventListener('scroll', arrows)
  $('.accounts').addEventListener(
    'wheel',
    (e) => {
      if ($('.accounts').scrollWidth > $('.accounts').clientWidth) {
        e.preventDefault()
        $('.accounts').scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      }
    },
    { passive: false }
  )
  $('.refresh').onclick = refresh
  document.addEventListener('pointerdown', (e) => {
    if (!e.composedPath().includes(host)) close()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
  })
  window.addEventListener('resize', position)
  setInterval(position, 800)
  setInterval(refresh, 5000)
  position()
  void refresh()
})()
