/**
 * @dsh-external/dsh-pet-notepad — client 半区（纯 JS 手写，无 React/JSX 编译，无需构建）。
 *
 * 形态：`window.__ModuleLoader__.load({ id, factory })`（tsdown 等价产物）。
 * slot 条目的 component 会被官方 renderer 用 `jsx(Comp, props)` 直接渲染，
 * 所以这里用纯 React 组件做「挂载宿主」（ref + useEffect），内部交给自己管理的 DOM。
 *
 * 注册三处：
 *   1. sidebar.panellist     → 左侧栏「记事本」图标入口（id 与 main 的 key 关联）
 *   2. main                  → 中间整块记事本面板
 *   3. settings.plugin.item  → 设置页插件卡片（说明 + 数据文件位置 + 字数）
 *
 * 外加一个**不占 slot** 的悬浮记事本：右键宠物（`[data-dsh-pet-root]` 内）弹出，
 * 挂在宠物正下方；位置靠 DOM 锚点实时测量，宠物被拖动时跟着走。
 *
 * ── 抗更新设计（本插件存在的前提）────────────────────────────────────────
 * dsh-pet 是 profile 的版本依赖，一升级整目录被覆盖。本插件一行都不碰 pet，
 * 也不 import 它，只依赖一个 DOM 标记：`[data-dsh-pet-root]`。它是 pet 在
 * `document.body` 上挂的插件根节点，既当右键命中区，也是量精灵位置的查询范围。
 * 三档降级：量到精灵 → 贴宠物下方；精灵标记变了 → 退到 root 内最大可见元素；
 * pet 整块消失 → 右键不再命中，但侧栏入口照常可用。
 * 最坏情况只是「右键触发失效，位置不准」，记事本本身不会丢。
 *
 * ── 与 pet 自身面板的位置冲突（已知）────────────────────────────────────
 * pet 在 hover 时也会在宠物下方弹面板（`.panel`，`top: 100%`）。本悬浮窗
 * z-index 更高，打开时会盖住它；用户选了右键触发，所以不会天天撞。
 *
 * @module @dsh-external/dsh-pet-notepad/client
 */

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-pet-notepad',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** React 由 ModuleLoader 共享提供（与官方 client bundle 同款用法）。 */
    const React = require('react')

    /** 需要的客户端服务：只有 slots。 */
    const inject = ['slots']

    /** Host API 前缀。 */
    const API = '/pet-notepad/api'

    /** 侧边栏入口 id，同时也是 main 面板的 key。 */
    const PANEL_ID = 'pet-notepad'

    /** 输入停顿多久后自动落盘。 */
    const SAVE_DEBOUNCE_MS = 600

    // ────────────────────────────────────────────────────────── 共享 store
    // 悬浮窗和侧栏面板是同一份内容的两个视图，共用一个 store：
    // 任意一处编辑，另一处立刻跟着变；落盘由 store 统一节流。

    function createStore() {
      let state = {
        text: '',
        savedText: '',
        revision: 0,
        updatedAt: 0,
        storagePath: '',
        loaded: false,
        loading: false,
        status: 'idle', // idle | dirty | saving | saved | error
        error: null,
        warning: null,
      }
      const listeners = new Set()
      let saveTimer = null
      let saving = false
      let pending = false

      function get() {
        return state
      }

      function emit() {
        for (const fn of Array.from(listeners)) {
          try {
            fn()
          } catch (error) {
            console.error('[pet-notepad] listener failed', error)
          }
        }
      }

      function set(patch) {
        state = Object.assign({}, state, patch)
        emit()
      }

      function subscribe(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }

      async function request(path, init) {
        const res = await fetch(API + path, init)
        let data = null
        try {
          data = await res.json()
        } catch {
          data = null
        }
        return { res, data }
      }

      /** 拉取权威内容。失败只在 UI 上提示，不覆盖本地已输入的内容。 */
      async function load() {
        if (state.loading) return
        set({ loading: true })
        try {
          const { res, data } = await request('/state', { headers: { accept: 'application/json' } })
          if (!res.ok || data === null || data.ok !== true) {
            throw new Error(data !== null && data.error ? data.error : 'HTTP ' + res.status)
          }
          const s = data.state
          set({
            text: s.text,
            savedText: s.text,
            revision: s.revision,
            updatedAt: s.updatedAt,
            storagePath: s.storagePath,
            loaded: true,
            loading: false,
            status: 'idle',
            error: null,
            warning: typeof s.warning === 'string' ? s.warning : null,
          })
        } catch (error) {
          set({
            loading: false,
            loaded: true,
            status: 'error',
            error: messageOf(error),
          })
        }
      }

      /** 本地编辑：先更新视图，再节流落盘。 */
      function setText(text) {
        set({ text, status: 'dirty', error: null })
        if (saveTimer !== null) clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => {
          saveTimer = null
          void save()
        }, SAVE_DEBOUNCE_MS)
      }

      /** 立即落盘（blur / 关闭悬浮窗 / 卸载时调用）。 */
      async function save() {
        if (saveTimer !== null) {
          clearTimeout(saveTimer)
          saveTimer = null
        }
        if (state.text === state.savedText) return
        if (saving) {
          pending = true
          return
        }
        saving = true
        const sent = state.text
        set({ status: 'saving', error: null })
        try {
          let { res, data } = await request('/set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: sent, baseRevision: state.revision }),
          })
          // 409 = 服务端被别的标签页推进过。重放一次，以本页内容为准。
          if (res.status === 409 && data !== null && data.state) {
            const { res: res2, data: data2 } = await request('/set', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: sent, baseRevision: data.state.revision }),
            })
            res = res2
            data = data2
          }
          if (!res.ok || data === null || data.ok !== true) {
            throw new Error(data !== null && data.error ? data.error : 'HTTP ' + res.status)
          }
          const next = { revision: data.state.revision, updatedAt: data.state.updatedAt, savedText: sent, error: null }
          next.status = state.text === sent ? 'saved' : 'dirty'
          set(next)
        } catch (error) {
          set({ status: 'error', error: messageOf(error) })
        } finally {
          saving = false
          if (pending) {
            pending = false
            void save()
          }
        }
      }

      /** 清空（先本地清，再走同一条落盘链路）。 */
      function clear() {
        setText('')
        void save()
      }

      return { get, set, subscribe, load, setText, save, clear }
    }

    /** 统一取错误文案。 */
    function messageOf(error) {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
      return String(error)
    }

    /** 状态文案 + 色调。 */
    function statusView(s) {
      if (s.status === 'error') return { text: '保存失败：' + s.error, tone: 'error' }
      if (s.loading) return { text: '读取中…', tone: 'muted' }
      if (s.status === 'saving') return { text: '保存中…', tone: 'muted' }
      if (s.status === 'dirty') return { text: '未保存', tone: 'warn' }
      if (s.status === 'saved') return { text: '已保存', tone: 'muted' }
      if (s.loaded) return { text: '已同步', tone: 'muted' }
      return { text: '待读取', tone: 'muted' }
    }

    const store = createStore()

    // ───────────────────────────────────────────────────────────────── CSS

    const CSS = `
.pn-root {
  --pn-bg: var(--dsw-alias-bg-layer-1, #1b1b1f);
  --pn-bg2: var(--dsw-alias-bg-layer-2, #232329);
  --pn-border: var(--dsw-alias-border-l2, rgba(255,255,255,.14));
  --pn-border-hi: var(--dsw-alias-border-l3, rgba(255,255,255,.28));
  --pn-fg: var(--dsw-alias-label-primary, #e8e8ea);
  --pn-fg2: var(--dsw-alias-label-tertiary, #9a9aa2);
  --pn-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px;
  height: 100%; min-height: 0;
  color: var(--pn-fg);
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.pn-root *, .pn-root *::before, .pn-root *::after { box-sizing: border-box; }
.pn-head { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.pn-title { font-size: 12.5px; font-weight: 600; letter-spacing: .02em; }
.pn-status { margin-left: auto; font-size: 11.5px; color: var(--pn-fg2); white-space: nowrap; }
.pn-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.pn-status[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #e0a44a); }
.pn-textarea {
  flex: 1 1 auto; min-height: 0; width: 100%; resize: none;
  padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--pn-border);
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #101014) 72%, transparent);
  color: var(--pn-fg); outline: none;
  font: 12.5px/1.65 ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei", monospace;
  transition: border-color .15s ease;
}
.pn-textarea::placeholder { color: var(--pn-fg2); }
.pn-textarea:focus { border-color: var(--pn-accent); }
.pn-foot { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; font-size: 11.5px; color: var(--pn-fg2); }
.pn-count { margin-right: auto; }
.pn-btn {
  appearance: none; cursor: pointer; white-space: nowrap;
  padding: 4px 10px; border-radius: 8px;
  border: 1px solid var(--pn-border);
  background: var(--pn-bg2); color: var(--pn-fg);
  font-size: 11.5px; line-height: 1.45;
  transition: border-color .15s ease, background .15s ease;
}
.pn-btn:hover { border-color: var(--pn-border-hi); }
.pn-btn:active { transform: translateY(1px); }
.pn-icon {
  appearance: none; cursor: pointer; flex: 0 0 auto;
  width: 22px; height: 22px; padding: 0; border-radius: 7px;
  border: 1px solid transparent; background: transparent;
  color: var(--pn-fg2); font-size: 15px; line-height: 1;
}
.pn-icon:hover { border-color: var(--pn-border); color: var(--pn-fg); }
.pn-note {
  flex: 0 0 auto; padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--pn-border); background: var(--pn-bg2);
  font-size: 11.5px; color: var(--pn-fg2); word-break: break-all;
}
.pn-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #ff6b6b); }
.pn-float {
  position: fixed; z-index: 2147483300;
  width: 340px; height: 268px; padding: 10px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay, #16161a) 96%, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));
  box-shadow: 0 18px 48px rgba(0,0,0,.46);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  backdrop-filter: blur(14px) saturate(1.2);
}
.pn-settings { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
.pn-settings .pn-dim { color: var(--pn-fg2); font-size: 11.5px; word-break: break-all; }
`

    // ──────────────────────────────────────────────────────────── 记事本视图

    /**
     * 造一块记事本 DOM。两个变体共用同一套结构与 store：
     * `panel`（侧栏整块）与 `float`（宠物下方悬浮窗）。
     * @returns {{ node: HTMLElement, dispose: () => void }}
     */
    function mountNotepad(opts) {
      const variant = opts.variant === 'float' ? 'float' : 'panel'
      const root = document.createElement('div')
      root.className = 'pn-root'
      if (variant === 'float') root.title = store.get().storagePath

      const head = document.createElement('div')
      head.className = 'pn-head'
      const title = document.createElement('span')
      title.className = 'pn-title'
      title.textContent = '记事本'
      const status = document.createElement('span')
      status.className = 'pn-status'
      head.append(title, status)
      if (variant === 'float') {
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'pn-icon'
        close.textContent = '×'
        close.title = '关闭（Esc）'
        close.addEventListener('click', () => {
          if (typeof opts.onClose === 'function') opts.onClose()
        })
        head.append(close)
      }

      const ta = document.createElement('textarea')
      ta.className = 'pn-textarea'
      ta.placeholder = '随手粘贴…（自动保存）'
      ta.spellcheck = false
      ta.addEventListener('input', () => store.setText(ta.value))
      ta.addEventListener('blur', () => {
        void store.save()
      })

      const note = document.createElement('div')
      note.className = 'pn-note'
      note.style.display = 'none'

      const foot = document.createElement('div')
      foot.className = 'pn-foot'
      const count = document.createElement('span')
      count.className = 'pn-count'
      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'pn-btn'
      copyBtn.textContent = '复制全部'
      copyBtn.addEventListener('click', () => {
        void copyAll(copyBtn)
      })
      const clearBtn = document.createElement('button')
      clearBtn.type = 'button'
      clearBtn.className = 'pn-btn'
      clearBtn.textContent = '清空'
      clearBtn.addEventListener('click', () => {
        if (store.get().text === '' || window.confirm('清空记事本？此操作不可撤销。')) store.clear()
      })
      foot.append(count, copyBtn, clearBtn)

      const parts = [head, ta]
      if (variant === 'panel') {
        const pathEl = document.createElement('div')
        pathEl.className = 'pn-note'
        parts.push(pathEl)
      }
      parts.push(note, foot)
      root.append.apply(root, parts)

      function render() {
        const s = store.get()
        // 正在输入时绝不回写 textarea（会打乱光标 / IME 组合）
        if (document.activeElement !== ta && ta.value !== s.text) ta.value = s.text
        const view = statusView(s)
        status.textContent = view.text
        status.dataset.tone = view.tone
        count.textContent = s.text.length + ' 字'
        if (variant === 'panel') {
          const pathEl = root.querySelector('.pn-note')
          if (pathEl !== null && pathEl !== note) {
            pathEl.textContent = s.storagePath === '' ? '' : '存储：' + s.storagePath
            pathEl.style.display = s.storagePath === '' ? 'none' : ''
          }
        }
        const alert = s.status === 'error' ? s.error : s.warning
        if (alert === null || alert === undefined || alert === '') {
          note.style.display = 'none'
        } else {
          note.style.display = ''
          note.dataset.tone = s.status === 'error' ? 'error' : ''
          note.textContent = alert
        }
      }

      const unsubscribe = store.subscribe(render)
      render()
      if (typeof opts.onMounted === 'function') opts.onMounted(root, ta)
      return {
        node: root,
        dispose: () => {
          unsubscribe()
          void store.save()
        },
      }
    }

    /** 复制全部：优先 navigator.clipboard，退化到 textarea + execCommand。 */
    async function copyAll(button) {
      const text = store.get().text
      const original = button.textContent
      let ok = false
      try {
        if (navigator.clipboard !== undefined && window.isSecureContext) {
          await navigator.clipboard.writeText(text)
          ok = true
        }
      } catch {
        ok = false
      }
      if (!ok) {
        const scratch = document.createElement('textarea')
        scratch.value = text
        scratch.style.position = 'fixed'
        scratch.style.opacity = '0'
        document.body.append(scratch)
        scratch.select()
        try {
          ok = document.execCommand('copy')
        } catch {
          ok = false
        }
        scratch.remove()
      }
      button.textContent = ok ? '已复制' : '复制失败'
      window.setTimeout(() => {
        button.textContent = original
      }, 1200)
    }

    /** 侧栏图标（契约：{ size, active }）。 */
    function NotepadIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      const active = props.active === true
      return React.createElement(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size + 'px',
            height: size + 'px',
            opacity: active ? 1 : 0.72,
          },
        },
        React.createElement(
          'svg',
          { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
          React.createElement('rect', {
            x: 3.25, y: 1.75, width: 9.5, height: 12.5, rx: 1.6,
            stroke: 'currentColor', strokeWidth: 1.3,
          }),
          React.createElement('path', {
            d: 'M5.6 5.2h4.8M5.6 7.7h4.8M5.6 10.2h3',
            stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
          }),
        ),
      )
    }

    /**
     * 纯 DOM 视图的 React 挂载宿主：slot 要的是 React 组件，视图是手写 DOM。
     * 组件只负责 ref 容器 + 生命周期，内容全交给 mount()。
     */
    function reactHost(mount, hostStyle) {
      return function PetNotepadHost() {
        const ref = React.useRef(null)
        React.useEffect(() => {
          const host = ref.current
          if (host === null) return undefined
          const instance = mount()
          host.append(instance.node)
          return () => {
            try {
              instance.dispose()
            } catch (error) {
              console.error('[pet-notepad] dispose failed', error)
            }
            instance.node.remove()
          }
        }, [])
        return React.createElement('div', { ref, style: hostStyle })
      }
    }

    // ───────────────────────────────────────────────────── 宠物下方悬浮窗

    /** 作用域内面积最大的可见矩形（精灵容器的兜底测量）。 */
    function largestRect(scope) {
      let best = null
      let bestArea = 0
      for (const el of scope.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect()
        if (rect.width < 8 || rect.height < 8) continue
        const area = rect.width * rect.height
        if (area > bestArea) {
          bestArea = area
          best = rect
        }
      }
      return best
    }

    /**
     * 量宠物精灵的屏幕矩形，三档降级：
     *   ① `[data-dsh-pet-root]` 内面积最大的 `[role=button][aria-label]`（精灵本体）
     *   ② root 内面积最大的可见元素（pet 换了内部标记时的兜底）
     * 都量不到返回 null，调用方走固定位置。
     *
     * 两个必须知道的坑（都实测过）：
     *   - 精灵是 **portal 进 root** 的，所以它是 `[data-pet-dock]` 那个 span 的
     *     **兄弟节点**，不是子节点 —— 从 dock 里 querySelector 一定找不到。
     *   - `[data-pet-dock]` span 自身是 0×0（子元素全 fixed 定位，不参与它的
     *     布局），直接拿它的 rect 会得到全 0。
     * 所以作用域只能是 `[data-dsh-pet-root]`，且要按面积挑。
     */
    function petSpriteRect() {
      const root = document.querySelector('[data-dsh-pet-root]')
      if (root === null) return null
      let best = null
      let bestArea = 0
      for (const el of root.querySelectorAll('[role="button"][aria-label]')) {
        const rect = el.getBoundingClientRect()
        if (rect.width < 8 || rect.height < 8) continue
        const area = rect.width * rect.height
        if (area > bestArea) {
          bestArea = area
          best = rect
        }
      }
      if (best !== null) return best
      return largestRect(root)
    }

    /**
     * 悬浮记事本：右键宠物弹出，挂在宠物正下方；下方放不下就翻到上方，
     * 再放不下就贴视口底边。宠物被拖动时靠 250ms 的跟随定时器贴住。
     */
    function createFloat() {
      const el = document.createElement('div')
      el.className = 'pn-float'
      el.dataset.dshPetNotepad = 'float'
      el.style.display = 'none'
      let view = null
      let follow = null

      function place() {
        if (el.style.display === 'none') return
        const w = el.offsetWidth
        const h = el.offsetHeight
        if (w === 0 || h === 0) return
        const margin = 8
        const gap = 10
        const rect = petSpriteRect()
        let left
        let top
        if (rect === null) {
          // 兜底：宠物量不到（被隐藏 / DOM 变了 / pet 换了实现）时贴右下角，
          // 功能照常，只是不跟随。
          left = window.innerWidth - w - 24
          top = window.innerHeight - h - 24
        } else {
          left = rect.left + rect.width / 2 - w / 2
          top = rect.bottom + gap
          if (top + h > window.innerHeight - margin) {
            const above = rect.top - gap - h
            top = above >= margin ? above : window.innerHeight - h - margin
          }
        }
        left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - w - margin))
        top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - h - margin))
        el.style.left = Math.round(left) + 'px'
        el.style.top = Math.round(top) + 'px'
      }

      function open() {
        if (view === null) {
          view = mountNotepad({ variant: 'float', onClose: close })
          el.append(view.node)
        }
        el.style.display = ''
        void store.load()
        place()
        if (follow === null) follow = window.setInterval(place, 250)
        const ta = el.querySelector('textarea')
        if (ta !== null) ta.focus()
      }

      function close() {
        if (el.style.display === 'none') return
        el.style.display = 'none'
        if (follow !== null) {
          clearInterval(follow)
          follow = null
        }
        void store.save()
      }

      function isOpen() {
        return el.style.display !== 'none'
      }

      return {
        el,
        open,
        close,
        isOpen,
        toggle: () => (isOpen() ? close() : open()),
        place,
        dispose: () => {
          if (follow !== null) clearInterval(follow)
          follow = null
          if (view !== null) view.dispose()
          view = null
        },
      }
    }

    // ───────────────────────────────────────────────────────────────── 插件

    function apply(ctx) {
      ctx.effect(
        () => {
          const style = document.createElement('style')
          style.dataset.dshPetNotepadStyle = '1'
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        },
        'pet-notepad: styles',
      )

      // 悬浮窗 + 全局触发。监听器挂在 document 上（capture），
      // 这样 pet 热重载 / 换 DOM 都不用重新绑定，且本插件从不持有 pet 的引用。
      ctx.effect(
        () => {
          const float = createFloat()
          document.body.append(float.el)
          void store.load()

          const onContextMenu = (event) => {
            const target = event.target
            if (!(target instanceof Element)) return
            if (target.closest('[data-dsh-pet-root]') === null) return
            // 只对宠物抑制浏览器右键菜单，并切换悬浮记事本。
            event.preventDefault()
            float.toggle()
          }
          const onKeyDown = (event) => {
            if (event.key !== 'Escape' || !float.isOpen()) return
            // 输入法组合中的 Esc 是「取消候选」，交回给输入法；
            // 组合结束后（isComposing 为 false）的 Esc 才是关闭悬浮窗。
            if (event.isComposing) return
            event.stopPropagation()
            float.close()
          }
          const onPointerDown = (event) => {
            // 只用左键关闭：右键自身会先触发 pointerdown 再触发 contextmenu，
            // 若在这里关，右键就会被「关掉又打开」，等于关不掉。
            if (event.button !== 0 || !float.isOpen()) return
            const target = event.target
            if (!(target instanceof Element)) return
            if (target.closest('[data-dsh-pet-notepad]') !== null) return
            float.close()
          }
          const onResize = () => float.place()

          document.addEventListener('contextmenu', onContextMenu, true)
          document.addEventListener('keydown', onKeyDown, true)
          document.addEventListener('pointerdown', onPointerDown, true)
          window.addEventListener('resize', onResize)
          return () => {
            document.removeEventListener('contextmenu', onContextMenu, true)
            document.removeEventListener('keydown', onKeyDown, true)
            document.removeEventListener('pointerdown', onPointerDown, true)
            window.removeEventListener('resize', onResize)
            float.dispose()
            float.el.remove()
          }
        },
        'pet-notepad: floating notepad',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 61, label: () => '记事本' }, NotepadIcon),
          ),
        'pet-notepad: sidebar entry',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID },
              reactHost(
                () => {
                  void store.load()
                  return mountNotepad({ variant: 'panel' })
                },
                { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '320px', padding: '14px' },
              ),
            ),
          ),
        'pet-notepad: panel',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugin.item', () =>
            ctx.slots.register(
              { name: 'settings.plugin.item', id: PANEL_ID, order: 61, label: () => '记事本' },
              reactHost(mountSettingsCard, {}),
            ),
          ),
        'pet-notepad: settings card',
      )
    }

    /** 设置页卡片：说明 + 数据文件位置 + 当前字数。 */
    function mountSettingsCard() {
      const root = document.createElement('div')
      root.className = 'pn-root pn-settings'
      const desc = document.createElement('div')
      desc.textContent = '右键桌面宠物弹出悬浮记事本；左侧栏「记事本」入口查看/编辑同一份内容。内容存在 Host 侧 JSON 文件里，刷新、重开浏览器都不丢。'
      const path = document.createElement('div')
      path.className = 'pn-dim'
      const count = document.createElement('div')
      count.className = 'pn-dim'
      root.append(desc, path, count)

      function render() {
        const s = store.get()
        path.textContent = s.storagePath === '' ? '' : '数据文件：' + s.storagePath
        count.textContent = '当前 ' + s.text.length + ' 字'
      }
      const unsubscribe = store.subscribe(render)
      void store.load()
      render()
      return { node: root, dispose: unsubscribe }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
