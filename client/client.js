/**
 * dsh-ide-vscode — client half.
 *
 * A right-sidebar tab: workspace tree on the left, editor on the right, with
 * right-click create / rename / delete and Ctrl+S save. Registered as a page
 * type with a guide entry, so it shows up as a card on the sidebar start page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ide-vscode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    let P = {}
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    }
    catch (error) {
      P = {}
    }

    const ID = 'dsh-ide-vscode'
    const KIND = 'ide-vscode'
    const API = '/api/ide-vscode'
    // 面板的全局快捷键：桌面 Ctrl+D 打开工作区 IDE（焦点在编辑器里时改为复制当前行）。
    const COMMAND_OPEN = 'dsh-ide-vscode.open'
    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

    const CODE_EXT = new Set(['js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'py', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'cmd', 'bat', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'sql', 'lua', 'rb', 'php', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'vue', 'svelte'])
    // Resource addresses this page claims: code / config / data files open straight
    // in the IDE. Markdown and HTML stay with the built-in document preview.
    const CLAIM_PATTERNS = Array.from(CODE_EXT)
      .filter(ext => ext !== 'html' && ext !== 'htm')
      .concat(['txt', 'log', 'csv', 'tsv', 'env', 'properties'])
      .map(ext => `*.${ext}`)
    const EXT_FALLBACK = {
      js: 'javascript', cjs: 'javascript', mjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
      py: 'python', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
      ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
      md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
      css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
      xml: 'xml', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
      go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php', lua: 'lua',
      vue: 'vue', svelte: 'svelte', txt: 'text',
    }

    const useHighlighter = typeof P.useCodeHighlighter === 'function'
      ? P.useCodeHighlighter
      : () => () => undefined
    const languageOf = typeof P.languageForPath === 'function'
      ? (name) => P.languageForPath(name)
      : (name) => EXT_FALLBACK[String(name).split('.').pop().toLowerCase()]

    // Pictures are previewed instead of opened as text, sound and video are played
    // in place, archives get a member list plus 解压/打包. Everything else is text.
    const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif']
    const ARCHIVE_EXT = ['.zip', '.tar', '.tar.gz', '.tgz', '.gz', '.7z', '.rar']
    const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.weba', '.wma', '.mid']
    const VIDEO_EXT = ['.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv', '.avi']

    function extOfName(name) {
      const lower = String(name || '').toLowerCase()
      if (lower.endsWith('.tar.gz'))
        return '.tar.gz'
      const dot = lower.lastIndexOf('.')
      return dot <= 0 ? '' : lower.slice(dot)
    }

    function kindOfName(name) {
      const ext = extOfName(name)
      if (IMAGE_EXT.includes(ext))
        return 'image'
      if (AUDIO_EXT.includes(ext))
        return 'audio'
      if (VIDEO_EXT.includes(ext))
        return 'video'
      if (ARCHIVE_EXT.includes(ext))
        return 'archive'
      return 'text'
    }

    // ---------------------------------------------------------------- helpers

    function report(message) {
      try {
        fetch(`${API}/log`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: String(message) }),
        }).catch(() => {})
      }
      catch {}
    }

    async function getJson(url) {
      const response = await fetch(url, { credentials: 'same-origin' })
      const text = await response.text()
      let payload = {}
      try {
        payload = JSON.parse(text)
      }
      catch {
        throw new Error(`接口返回非 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok)
        throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    /** First non-empty string among the candidates, else ''. */
    function firstString(...values) {
      for (const value of values) {
        if (typeof value === 'string' && value !== '')
          return value
      }
      return ''
    }

    async function postJson(path, body, session) {
      const headers = { 'content-type': 'application/json' }
      if (session)
        headers['x-dsh-session'] = session
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify(body || {}),
      })
      const text = await response.text()
      let payload = {}
      try {
        payload = JSON.parse(text)
      }
      catch {
        throw new Error(`接口返回非 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok)
        throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    function fmtSize(size) {
      if (!size)
        return '0 B'
      if (size < 1024)
        return `${size} B`
      if (size < 1024 * 1024)
        return `${(size / 1024).toFixed(1)} KB`
      return `${(size / 1024 / 1024).toFixed(1)} MB`
    }

    function baseName(rel) {
      return String(rel).split('/').pop() || rel
    }

    function parentOf(rel) {
      const parts = String(rel).split('/')
      parts.pop()
      return parts.join('/')
    }

    /** Ancestor directories of a path, outermost first (`a/b/c.txt` → ['a', 'a/b']). */
    function ancestorsOf(rel) {
      const parts = String(rel).split('/')
      parts.pop()
      const chain = []
      let acc = ''
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part
        chain.push(acc)
      }
      return chain
    }

    /**
     * Workspace-relative path of a `dsh-resource://file/<scope>/<id>/<path>` address.
     * Returns `''` for anything else, so a page opened without a target still works.
     */
    function relFromAddress(address) {
      const prefix = 'dsh-resource://file/'
      const raw = String(address || '')
      if (raw.indexOf(prefix) !== 0)
        return ''
      let rest = raw.slice(prefix.length).split('#')[0].split('?')[0]
      const first = rest.indexOf('/')
      if (first < 0)
        return ''
      rest = rest.slice(first + 1)
      const second = rest.indexOf('/')
      if (second < 0)
        return ''
      const rel = rest.slice(second + 1)
      try {
        return decodeURIComponent(rel)
      }
      catch (error) {
        return rel
      }
    }

    function ic(component, size) {
      return typeof component === 'function' ? h(component, { size }) : h('span', { className: 'hx-glyph' }, '•')
    }

    function isCodeFile(name) {
      return CODE_EXT.has(String(name).split('.').pop().toLowerCase())
    }

    // ------------------------------------------------------------------ style

    const CSS = `
.hx-root{position:relative;display:flex;height:100%;min-height:320px;overflow:hidden;background:var(--dsw-alias-bg-base,#101418);color:var(--dsw-alias-label-primary,#e6e6e6);font:12.5px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif}
.hx-side{display:flex;flex-direction:column;flex:0 0 226px;min-width:150px;border-right:1px solid var(--dsw-alias-border-l1,#2a2f36);background:var(--dsw-specific-sidebar-fill,rgba(127,127,127,.05))}
.hx-side-head{display:flex;align-items:center;gap:4px;height:30px;padding:0 6px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2f36);font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b0)}
.hx-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.hx-ico{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b0);cursor:pointer;flex:0 0 auto}
.hx-ico:hover{background:rgba(127,127,127,.18);color:var(--dsw-alias-label-primary,#e6e6e6)}
.hx-tree{flex:1;overflow:auto;padding:3px 0 10px}
.hx-row{display:flex;align-items:center;gap:4px;height:22px;padding-right:6px;cursor:pointer;white-space:nowrap;font-size:12.5px}
.hx-row:hover{background:rgba(127,127,127,.15)}
.hx-row.sel{background:rgba(127,127,127,.22)}
.hx-row.act{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a8cff) 26%,transparent)}
.hx-tw{width:11px;flex:0 0 11px;text-align:center;opacity:.6;font-size:9px}
.hx-name{overflow:hidden;text-overflow:ellipsis}
.hx-glyph{font-size:10px;opacity:.7}
.hx-note{padding:4px 0 4px 12px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a93a0)}
.hx-note.err{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.hx-main{display:flex;flex-direction:column;flex:1;min-width:0}
.hx-bar{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px 0 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2f36);font-size:12px}
.hx-fname{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hx-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#e0a000);flex:0 0 auto}
.hx-spacer{flex:1}
.hx-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a4149);background:transparent;color:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.hx-btn:hover{background:rgba(127,127,127,.16)}
.hx-btn.primary{background:var(--dsw-alias-brand-primary,#4a8cff);border-color:transparent;color:#fff}
.hx-btn.danger{background:var(--dsw-alias-state-error-primary,#ff6b6b);border-color:transparent;color:#fff}
.hx-btn:disabled{opacity:.45;cursor:default}
.hx-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary,#8a93a0);font-size:12.5px;text-align:center;padding:20px}
.hx-code{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}
.hx-gutter{flex:0 0 48px;overflow:hidden;padding:8px 6px 0 0;box-sizing:border-box;text-align:right;border-right:1px solid var(--dsw-alias-border-l1,#2a2f36);background:rgba(127,127,127,.05);color:var(--dsw-alias-label-secondary,#7f8894);font:12.5px/20px ui-monospace,Consolas,"Cascadia Mono",monospace}
.hx-gutter-inner{will-change:transform}
.hx-area{position:relative;flex:1;min-width:0;overflow:hidden}
.hx-pre,.hx-ta{position:absolute;top:0;left:0;width:100%;height:100%;margin:0;border:0;padding:8px 12px;box-sizing:border-box;font:12.5px/20px ui-monospace,Consolas,"Cascadia Mono",monospace;white-space:pre;tab-size:2;overflow:auto}
.hx-pre{color:var(--dsw-alias-label-primary,#e6e6e6);pointer-events:none;background:transparent}
.hx-ta{background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary,#fff);resize:none;outline:none;overflow:auto}
.hx-ta::selection{background:rgba(74,140,255,.32)}
.hx-line{height:20px;white-space:pre}
.hx-status{display:flex;align-items:center;gap:12px;height:23px;padding:0 10px;border-top:1px solid var(--dsw-alias-border-l1,#2a2f36);font-size:11px;color:var(--dsw-alias-label-secondary,#8a93a0);white-space:nowrap;overflow:hidden}
.hx-menu{position:fixed;z-index:9999;min-width:176px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-overlay,#1b2026);border:1px solid var(--dsw-alias-border-l2,#3a4149);box-shadow:0 10px 28px rgba(0,0,0,.38)}
.hx-mi{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12.5px}
.hx-mi:hover{background:rgba(127,127,127,.2)}
.hx-mi.danger{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.hx-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,#2a2f36)}
.hx-ov{position:absolute;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.3)}
.hx-dlg{width:340px;max-width:93%;padding:14px;border-radius:10px;background:var(--dsw-alias-bg-overlay,#1b2026);border:1px solid var(--dsw-alias-border-l2,#3a4149);box-shadow:0 18px 44px rgba(0,0,0,.42)}
.hx-dlg-title{font-size:13px;font-weight:600;margin-bottom:8px}
.hx-dlg-text{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b0);margin-bottom:10px;line-height:1.6;word-break:break-all}
.hx-in{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a4149);background:var(--dsw-alias-bg-layer-1,#12171c);color:var(--dsw-alias-label-primary,#e6e6e6);font:12.5px/1.4 ui-monospace,Consolas,monospace;outline:none}
.hx-in:focus{border-color:var(--dsw-alias-brand-primary,#4a8cff)}
.hx-chips{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 2px}
.hx-chip{padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a4149);font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa4b0)}
.hx-chip:hover{background:rgba(127,127,127,.18)}
.hx-chip.on{border-color:var(--dsw-alias-brand-primary,#4a8cff);color:var(--dsw-alias-brand-primary,#4a8cff)}
.hx-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.hx-toast{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);max-width:80%;padding:6px 14px;border-radius:999px;font-size:12px;background:var(--dsw-alias-bg-overlay,#1b2026);border:1px solid var(--dsw-alias-border-l2,#3a4149);box-shadow:0 8px 20px rgba(0,0,0,.35);z-index:9997}
.hx-toast.err{color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.hx-tag{padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a4149);font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa4b0);white-space:nowrap}
.hx-img-wrap{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(127,127,127,.06)}
.hx-img-wrap.full{align-items:flex-start;justify-content:flex-start}
.hx-img{max-width:100%;max-height:100%;object-fit:contain;image-rendering:auto;box-shadow:0 4px 18px rgba(0,0,0,.28);background:#fff}
.hx-img-wrap.full .hx-img{max-width:none;max-height:none}
.hx-arch{flex:1;min-height:0;overflow:auto;padding:6px 0 10px}
.hx-arch-row{display:flex;align-items:center;gap:6px;height:21px;padding-right:10px;font-size:12px;white-space:nowrap}
.hx-arch-row:hover{background:rgba(127,127,127,.12)}
.hx-arch-row.dir{color:var(--dsw-alias-label-primary,#e6e6e6)}
.hx-media-wrap{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(127,127,127,.06)}
.hx-audio{width:min(520px,100%)}
.hx-video{max-width:100%;max-height:100%;background:#000;box-shadow:0 4px 18px rgba(0,0,0,.28)}
.hx-media-wrap .hx-empty{width:100%}
.hx-find{display:flex;flex-direction:column;border-bottom:1px solid var(--dsw-alias-border-l1,#2a2f36)}
.hx-find-row{display:flex;align-items:center;gap:6px;padding:4px 6px}
.hx-find-in{flex:1;min-width:0;height:22px;padding:0 7px;border-radius:5px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#3a4149);background:var(--dsw-alias-bg-base,#101418);color:var(--dsw-alias-label-primary,#e6e6e6);font-family:inherit}
.hx-find-in:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4c8dff)}
.hx-find-list{max-height:190px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,#2a2f36)}
.hx-find-hit{display:flex;align-items:center;gap:6px;height:22px;padding:0 10px;font-size:12px;white-space:nowrap;overflow:hidden;cursor:pointer}
.hx-find-hit:hover{background:rgba(127,127,127,.14)}
.hx-find-hit .hx-note{padding:0}
`

    function ensureStyle() {
      try {
        if (document.getElementById('dsh-ide-vscode-style'))
          return
        const node = document.createElement('style')
        node.id = 'dsh-ide-vscode-style'
        node.textContent = CSS
        document.head.appendChild(node)
      }
      catch (error) {
        report(`style insert failed: ${error && error.message}`)
      }
    }

    // ------------------------------------------------------------- editor pane

    /**
     * 复制光标所在的整行（选区跨多行时就是那几行），返回新文本与光标落点。
     * 空文件没有可复制的行，返回 null。
     */
    function duplicateLine(text, start, end) {
      if (text === '')
        return null
      const blockStart = text.lastIndexOf('\n', start - 1) + 1
      const breakAt = text.indexOf('\n', end)
      const blockEnd = breakAt === -1 ? text.length : breakAt
      const block = text.slice(blockStart, blockEnd)
      // 复制出来的那份插在下面，光标停在副本的同一列
      return { text: `${text.slice(0, blockEnd)}\n${block}${text.slice(blockEnd)}`, caret: blockEnd + 1 + (start - blockStart) }
    }

    // 挂载中的编辑器 textarea → 它的「复制当前行」动作。全局快捷键优先于编辑器，
    // 所以焦点在编辑器里时要由 resolve 把这一下转发回编辑器。
    const editorDuplicate = new WeakMap()

    /** 焦点元素落在编辑器 textarea 里时返回它的复制动作，否则 undefined。 */
    function duplicateActionFor(element) {
      let node = element
      if (node === undefined || node === null)
        node = typeof document === 'undefined' ? null : document.activeElement
      if (node === undefined || node === null || typeof node.closest !== 'function')
        return undefined
      const ta = node.closest('.hx-ta')
      if (ta === null || ta === undefined)
        return undefined
      return editorDuplicate.get(ta)
    }

    function EditorPane({ file, busy, onChange, onSave, onClose }) {
      const taRef = useRef(null)
      const preRef = useRef(null)
      const gutterRef = useRef(null)
      const caretRef = useRef(null)

      const language = useMemo(() => {
        try {
          return languageOf(file.name)
        }
        catch {
          return undefined
        }
      }, [file.name])
      const highlight = useHighlighter(language)

      const tokens = useMemo(() => {
        if (typeof highlight !== 'function')
          return undefined
        try {
          return highlight(file.text)
        }
        catch {
          return undefined
        }
      }, [highlight, file.text])

      useEffect(() => {
        const caret = caretRef.current
        if (caret === null || taRef.current === null)
          return
        caretRef.current = null
        taRef.current.selectionStart = caret
        taRef.current.selectionEnd = caret
      })

      const syncScroll = useCallback(() => {
        const ta = taRef.current
        if (ta === null)
          return
        if (preRef.current !== null) {
          preRef.current.scrollTop = ta.scrollTop
          preRef.current.scrollLeft = ta.scrollLeft
        }
        if (gutterRef.current !== null)
          gutterRef.current.style.transform = `translateY(${-ta.scrollTop}px)`
      }, [])

      const handleKeyDown = useCallback((event) => {
        const ta = event.currentTarget
        if (event.key === 'Tab') {
          event.preventDefault()
          const start = ta.selectionStart
          const end = ta.selectionEnd
          caretRef.current = start + 2
          onChange(file.text.slice(0, start) + '  ' + file.text.slice(end))
          return
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
          event.preventDefault()
          onSave()
          return
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'd' || event.key === 'D')) {
          event.preventDefault()
          const result = duplicateLine(file.text, ta.selectionStart, ta.selectionEnd)
          if (result === null)
            return
          caretRef.current = result.caret
          onChange(result.text)
          return
        }
      }, [file.text, onChange, onSave])

      // 把「复制当前行」登记给全局快捷键（命令在编辑器里时走这一条）。
      useEffect(() => {
        const ta = taRef.current
        if (ta === null)
          return undefined
        editorDuplicate.set(ta, () => {
          const result = duplicateLine(file.text, ta.selectionStart, ta.selectionEnd)
          if (result === null)
            return
          caretRef.current = result.caret
          onChange(result.text)
        })
        return () => {
          editorDuplicate.delete(ta)
        }
      }, [file.text, onChange])

      const lineCount = useMemo(() => file.text.split('\n').length, [file.text])
      const numbers = useMemo(() => {
        const out = []
        for (let index = 1; index <= lineCount; index += 1)
          out.push(h('div', { key: index }, String(index)))
        return out
      }, [lineCount])

      const body = useMemo(() => {
        if (!Array.isArray(tokens))
          return h('div', { className: 'hx-line' }, file.text === '' ? '\u200b' : file.text)
        return tokens.map((line, index) => h(
          'div',
          { className: 'hx-line', key: index },
          line.length === 0
            ? '\u200b'
            : line.map((token, tokenIndex) => h('span', { key: tokenIndex, style: token.style }, token.text)),
        ))
      }, [tokens, file.text])

      return h(
        'div',
        { className: 'hx-main' },
        h(
          'div',
          { className: 'hx-bar' },
          h('span', { className: 'hx-fname' }, file.name),
          file.dirty ? h('span', { className: 'hx-dot', title: '有未保存的修改' }) : null,
          h('span', { className: 'hx-spacer' }),
          h('button', {
            className: 'hx-btn primary',
            disabled: busy || !file.dirty,
            onClick: onSave,
            title: 'Ctrl+S',
          }, busy ? '保存中…' : '保存'),
          h('button', { className: 'hx-btn', onClick: onClose, title: '关闭文件' }, '关闭'),
        ),
        file.error
          ? h('div', { className: 'hx-empty' }, file.error)
          : h(
            'div',
            { className: 'hx-code' },
            h('div', { className: 'hx-gutter' }, h('div', { className: 'hx-gutter-inner', ref: gutterRef }, numbers)),
            h(
              'div',
              { className: 'hx-area' },
              h('pre', { className: 'hx-pre', ref: preRef, 'aria-hidden': 'true' }, body),
              h('textarea', {
                className: 'hx-ta',
                ref: taRef,
                value: file.text,
                spellCheck: false,
                wrap: 'off',
                onChange: event => onChange(event.target.value),
                onKeyDown: handleKeyDown,
                onScroll: syncScroll,
              }),
            ),
          ),
        h(
          'div',
          { className: 'hx-status' },
          h('span', null, file.rel),
          h('span', null, `${lineCount} 行`),
          h('span', null, `${file.text.length} 字符`),
          h('span', null, file.size ? fmtSize(file.size) : ''),
          h('span', null, file.dirty ? '未保存' : '已保存'),
        ),
      )
    }

    // ------------------------------------------------------- image / archive

    function ImagePane({ file, onClose }) {
      const [fit, setFit] = useState(true)
      const [failed, setFailed] = useState(false)
      return h(
        'div',
        { className: 'hx-main' },
        h(
          'div',
          { className: 'hx-bar' },
          h('span', { className: 'hx-fname' }, file.name),
          h('span', { className: 'hx-tag' }, '图片预览'),
          h('span', { className: 'hx-spacer' }),
          h('button', { className: 'hx-btn', onClick: () => setFit(!fit) }, fit ? '原始大小' : '适应窗口'),
          h('button', { className: 'hx-btn', onClick: onClose, title: '关闭文件' }, '关闭'),
        ),
        file.error
          ? h('div', { className: 'hx-empty' }, file.error)
          : h(
            'div',
            { className: `hx-img-wrap${fit ? '' : ' full'}` },
            failed
              ? h('div', { className: 'hx-empty' }, '这张图读不出来（可能不是真图片）')
              : h('img', {
                className: 'hx-img',
                src: file.url,
                alt: file.name,
                onError: () => setFailed(true),
              }),
          ),
        h(
          'div',
          { className: 'hx-status' },
          h('span', null, file.rel),
          h('span', null, fmtSize(file.size)),
          h('span', null, '只读预览'),
        ),
      )
    }

    /** Sound and video are played in place; the bytes come from `/raw`, which
     *  answers byte ranges so the seek bar works. */
    function MediaPane({ file, onClose }) {
      const [failed, setFailed] = useState(false)
      const isAudio = file.kind === 'audio'
      return h(
        'div',
        { className: 'hx-main' },
        h(
          'div',
          { className: 'hx-bar' },
          h('span', { className: 'hx-fname' }, file.name),
          h('span', { className: 'hx-tag' }, isAudio ? '音频播放' : '视频播放'),
          h('span', { className: 'hx-spacer' }),
          h('a', {
            className: 'hx-btn',
            href: file.url,
            target: '_blank',
            rel: 'noreferrer',
            title: '在新标签页里打开原始文件',
          }, '新标签页打开'),
          h('button', { className: 'hx-btn', onClick: onClose, title: '关闭文件' }, '关闭'),
        ),
        file.error
          ? h('div', { className: 'hx-empty' }, file.error)
          : h(
            'div',
            { className: 'hx-media-wrap' },
            failed
              ? h('div', { className: 'hx-empty' }, isAudio ? '这个音频放不出来（可能不是真音频，或编码浏览器不认）' : '这个视频放不出来（可能不是真视频，或编码浏览器不认）')
              : (isAudio
                ? h('audio', {
                  className: 'hx-audio',
                  src: file.url,
                  controls: true,
                  preload: 'metadata',
                  onError: () => setFailed(true),
                })
                : h('video', {
                  className: 'hx-video',
                  src: file.url,
                  controls: true,
                  preload: 'metadata',
                  onError: () => setFailed(true),
                })),
          ),
        h(
          'div',
          { className: 'hx-status' },
          h('span', null, file.rel),
          h('span', null, isAudio ? '音频' : '视频'),
          h('span', null, fmtSize(file.size)),
          h('span', null, '只读播放'),
        ),
      )
    }

    function ArchivePane({ file, busy, onClose, onExtract }) {
      const data = file.archive || {}
      const entries = Array.isArray(data.entries) ? data.entries : []
      const total = data.count || entries.length
      return h(
        'div',
        { className: 'hx-main' },
        h(
          'div',
          { className: 'hx-bar' },
          h('span', { className: 'hx-fname' }, file.name),
          h('span', { className: 'hx-tag' }, `${total} 项`),
          h('span', { className: 'hx-spacer' }),
          h('button', {
            className: 'hx-btn primary',
            disabled: busy,
            onClick: onExtract,
            title: '解压到压缩包旁边（同名目录已存在就自动加 -2）',
          }, busy ? '解压中…' : '解压到旁边'),
          h('button', { className: 'hx-btn', onClick: onClose, title: '关闭文件' }, '关闭'),
        ),
        file.error
          ? h('div', { className: 'hx-empty' }, file.error)
          : h(
            'div',
            { className: 'hx-arch' },
            entries.length === 0 ? h('div', { className: 'hx-note' }, '这个压缩包是空的') : null,
            entries.map((entry, index) => h(
              'div',
              {
                className: `hx-arch-row${entry.dir ? ' dir' : ''}`,
                key: index,
                style: { paddingLeft: `${10 + (entry.depth || 0) * 14}px` },
              },
              entry.dir
                ? ic(P.IconFolderOpenRegular, 12)
                : h('span', { className: 'hx-glyph' }, '·'),
              h('span', { className: 'hx-name' }, entry.name.split('/').filter(Boolean).pop() || entry.name),
            )),
            data.truncated ? h('div', { className: 'hx-note' }, `只列出前 ${entries.length} 项（共 ${total} 项）`) : null,
          ),
        h(
          'div',
          { className: 'hx-status' },
          h('span', null, file.rel),
          h('span', null, `${total} 项`),
          h('span', null, fmtSize(file.size)),
          h('span', null, '只读预览'),
        ),
      )
    }

    // ------------------------------------------------------------- context menu

    function ContextMenu({ menu, onClose, onPick }) {
      const ref = useRef(null)
      const [position, setPosition] = useState({ left: menu.x, top: menu.y })

      useEffect(() => {
        const node = ref.current
        if (node !== null) {
          const rect = node.getBoundingClientRect()
          const left = Math.min(menu.x, Math.max(4, window.innerWidth - rect.width - 6))
          const top = Math.min(menu.y, Math.max(4, window.innerHeight - rect.height - 6))
          setPosition({ left, top })
        }
      }, [menu.x, menu.y])

      useEffect(() => {
        // 真鼠标点菜单项时，pointerdown 会先冒到 document（capture）——若在这里直接关掉菜单，
        // React 会把菜单项卸载掉，后面那次 click 就永远落不到菜单项上，表现是「点了没反应」。
        // 所以落在菜单内部（或对话框内部）的 pointerdown 不关菜单。
        const close = (event) => {
          const node = ref.current
          const target = event ? event.target : null
          if (node !== null && target && typeof node.contains === 'function' && node.contains(target))
            return
          if (target && typeof target.closest === 'function' && target.closest('.hx-ov'))
            return
          onClose()
        }
        const key = (event) => {
          if (event.key === 'Escape')
            onClose()
        }
        document.addEventListener('pointerdown', close, true)
        document.addEventListener('keydown', key)
        return () => {
          document.removeEventListener('pointerdown', close, true)
          document.removeEventListener('keydown', key)
        }
      }, [onClose])

      const entry = menu.entry
      const items = []
      if (!entry || entry.dir) {
        items.push({ id: 'newFile', label: '新建文件…', icon: P.IconPlusOutlineRegular })
        items.push({ id: 'newFolder', label: '新建文件夹…', icon: P.IconFolderOpenRegular })
        items.push({ id: 'sep1', sep: true })
      }
      if (entry) {
        const kind = entry.kind || kindOfName(entry.name)
        items.push({ id: 'rename', label: '重命名 / 改后缀…', icon: P.IconEditOutlineRegular })
        items.push({ id: 'delete', label: '删除', icon: P.IconTrashOutlineRegular, danger: true })
        items.push({ id: 'sep2', sep: true })
        if (entry.dir)
          items.push({ id: 'openFolder', label: '在编辑区打开这个文件夹', icon: P.IconFolderOpenRegular })
        if (!entry.dir && kind === 'archive')
          items.push({ id: 'extract', label: '解压到旁边', icon: P.IconFolderOpenRegular })
        items.push({ id: 'zip', label: '打包成 zip…', icon: P.IconFolderOpenRegular })
      }
      items.push({ id: 'refresh', label: '刷新', icon: P.IconRefreshOutlineRegular })

      return h(
        'div',
        {
          className: 'hx-menu',
          ref,
          style: { left: position.left, top: position.top },
          onPointerDown: event => event.stopPropagation(),
        },
        items.map((item, index) => (item.sep
          ? h('div', { className: 'hx-sep', key: `sep${index}` })
          : h(
            'div',
            {
              className: `hx-mi${item.danger ? ' danger' : ''}`,
              key: item.id,
              onClick: () => onPick(item.id),
            },
            ic(item.icon, 13),
            h('span', null, item.label),
          ))),
      )
    }

    // ------------------------------------------------------------------ dialog

    const EXT_CHIPS = ['.txt', '.md', '.json', '.js', '.py', '.ps1', '.sh', '.bat', '.yaml', '.ini', '.log', '无后缀']

    function Dialog({ dialog, onCancel, onConfirm, busy }) {
      const [name, setName] = useState(dialog.name || '')
      const inputRef = useRef(null)

      useEffect(() => {
        if (inputRef.current !== null)
          inputRef.current.focus()
      }, [])

      const submit = () => {
        if (!busy)
          onConfirm(name)
      }

      let body = []
      if (dialog.mode === 'newFile' || dialog.mode === 'newFolder' || dialog.mode === 'rename' || dialog.mode === 'zip') {
        body.push(h('div', { className: 'hx-dlg-text', key: 'hint' }, dialog.mode === 'rename'
          ? `重命名：${dialog.rel}`
          : dialog.mode === 'zip'
            ? `把 ${dialog.rel} 打包成 zip，和它在同一个目录里（同名会自动提示，不会覆盖）`
            : `位置：${dialog.dir === '' ? '工作区根目录' : dialog.dir}`))
        body.push(h('input', {
          key: 'input',
          className: 'hx-in',
          ref: inputRef,
          value: name,
          spellCheck: false,
          placeholder: dialog.mode === 'newFolder' ? '文件夹名' : '文件名，例如 note.txt',
          onChange: event => setName(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter')
              submit()
            if (event.key === 'Escape')
              onCancel()
          },
        }))
        if (dialog.mode === 'newFile') {
          body.push(h(
            'div',
            { className: 'hx-chips', key: 'chips' },
            EXT_CHIPS.map((chip) => {
              const stem = name.replace(/\.[^./\\]*$/, '')
              const current = chip === '无后缀' ? (name.includes('.') ? '' : '无后缀') : (name.toLowerCase().endsWith(chip) ? chip : '')
              return h('span', {
                key: chip,
                className: `hx-chip${current === chip ? ' on' : ''}`,
                onClick: () => setName(chip === '无后缀' ? (stem || 'untitled') : `${stem || 'untitled'}${chip}`),
              }, chip)
            }),
          ))
        }
      }
      else if (dialog.mode === 'delete') {
        body.push(h('div', { className: 'hx-dlg-text', key: 'text' },
          `要删除 ${dialog.rel}${dialog.isDir ? '（文件夹及其内容）' : ''}。`,
          h('br', null),
          '默认移到回收站（回收站位置见删除后的提示），不是真删；要真删点“彻底删除”。'))
      }
      else if (dialog.mode === 'switch') {
        body.push(h('div', { className: 'hx-dlg-text', key: 'text' }, `${baseName(dialog.from)} 有未保存的修改，打开 ${baseName(dialog.target)} 之前怎么处理？`))
      }
      else if (dialog.mode === 'purge') {
        body.push(h('div', { className: 'hx-dlg-text', key: 'text' }, `彻底删除 ${dialog.rel}，不进回收站，无法恢复。确定吗？`))
      }

      const confirmLabel = dialog.mode === 'delete' || dialog.mode === 'purge'
        ? (dialog.mode === 'purge' ? '彻底删除' : '移到回收站')
        : (dialog.mode === 'switch' ? '保存并打开' : '确定')

      const buttons = []
      if (dialog.mode === 'switch') {
        buttons.push(h('button', { className: 'hx-btn', key: 'drop', onClick: () => onConfirm('__drop__') }, '放弃修改'))
        buttons.push(h('button', { className: 'hx-btn primary', key: 'save', disabled: busy, onClick: () => onConfirm('__save__') }, '保存并打开'))
        buttons.push(h('button', { className: 'hx-btn', key: 'cancel', onClick: onCancel }, '取消'))
      }
      else {
        buttons.push(h('button', { className: 'hx-btn', key: 'cancel', onClick: onCancel }, '取消'))
        if (dialog.mode === 'delete')
          buttons.push(h('button', { className: 'hx-btn danger', key: 'purge', onClick: () => onConfirm('__purge__') }, '彻底删除'))
        buttons.push(h('button', {
          className: `hx-btn${dialog.mode === 'purge' ? ' danger' : ' primary'}`,
          key: 'ok',
          disabled: busy,
          onClick: submit,
        }, busy ? '处理中…' : confirmLabel))
      }

      return h('div', { className: 'hx-ov', onPointerDown: onCancel },
        h('div', { className: 'hx-dlg', onPointerDown: event => event.stopPropagation() },
          h('div', { className: 'hx-dlg-title' }, {
            newFile: '新建文件',
            newFolder: '新建文件夹',
            rename: '重命名',
            zip: '打包成 zip',
            delete: '删除',
            purge: '彻底删除',
            switch: '未保存的修改',
          }[dialog.mode] || '确认'),
          body,
          h('div', { className: 'hx-btns' }, buttons),
        ))
    }

    // -------------------------------------------------------------- IDE body

    function noTabInfo() {
      return { tab: { id: 'ide-vscode' } }
    }

    function IdeBody(props) {
      const useTabInfo = props && typeof props.useTabInfo === 'function' ? props.useTabInfo : noTabInfo
      const info = useTabInfo()
      const tab = (info && info.tab) || {}
      // When the tab was opened from a claimed resource address, that address is
      // the file to show. A guide-card open has no address and starts empty.
      const navigation = tab.navigation || {}
      const targetPath = relFromAddress(navigation.address || (navigation.params && navigation.params.address))

      // The workspace this panel shows belongs to the session it is open for: the host
      // resolves that session's own working directory, so switching workspace switches
      // the tree instead of pinning whatever directory the host was started in.
      //
      // The id is read through a ref so these three stay stable across renders — every
      // request helper below can then use them without listing them as dependencies.
      const sessionId = firstString(props?.sessionId, info?.sessionId, tab.sessionId)
      const sessionRef = useRef(sessionId)
      sessionRef.current = sessionId
      const scoped = useCallback((url) => {
        const id = sessionRef.current
        return id === '' ? url : `${url}${url.includes('?') ? '&' : '?'}session=${encodeURIComponent(id)}`
      }, [])
      const api = useCallback(url => getJson(scoped(url)), [scoped])
      const apiPost = useCallback((path, body) => postJson(path, body, sessionRef.current), [])

      const [root, setRoot] = useState('')
      const [listings, setListings] = useState({})
      const [expanded, setExpanded] = useState({})
      const [selected, setSelected] = useState('')
      const [file, setFile] = useState(null)
      const [menu, setMenu] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [toast, setToast] = useState(null)
      const [busy, setBusy] = useState(false)
      const [find, setFind] = useState('')
      const [findHits, setFindHits] = useState(null)
      const [findBusy, setFindBusy] = useState(false)

      const fileRef = useRef(null)
      fileRef.current = file

      const notify = useCallback((text, tone) => {
        setToast({ text, tone: tone || 'ok' })
        window.setTimeout(() => setToast(current => (current && current.text === text ? null : current)), 2600)
      }, [])

      const loadDir = useCallback(async (rel) => {
        setListings(prev => ({ ...prev, [rel]: { state: 'loading' } }))
        try {
          const payload = await api(`${API}/list?path=${encodeURIComponent(rel)}`)
          setListings(prev => ({ ...prev, [rel]: { state: 'ready', entries: payload.entries || [] } }))
        }
        catch (error) {
          setListings(prev => ({ ...prev, [rel]: { state: 'error', error: String((error && error.message) || error) } }))
        }
      }, [])

      useEffect(() => {
        let alive = true
        api(`${API}/root`)
          .then((payload) => {
            if (!alive)
              return
            setRoot(payload.root || '')
            return loadDir('')
          })
          .catch(error => notify(`后端没响应：${(error && error.message) || error}`, 'err'))
        return () => {
          alive = false
        }
      }, [sessionId, loadDir, notify])

      const toggleDir = useCallback((rel) => {
        setExpanded((prev) => {
          const next = { ...prev }
          if (next[rel])
            delete next[rel]
          else
            next[rel] = true
          return next
        })
        setListings((prev) => {
          if (prev[rel] && prev[rel].state !== 'error')
            return prev
          return prev
        })
        loadDir(rel).catch(() => {})
      }, [loadDir])

      const openFileNow = useCallback(async (rel, kindHint) => {
        const kind = kindHint || kindOfName(rel)
        const base = { rel, name: baseName(rel), text: '', size: 0, dirty: false, loading: true, kind }
        setFile(base)
        try {
          if (kind === 'image' || kind === 'audio' || kind === 'video') {
            const info = await api(`${API}/stat?path=${encodeURIComponent(rel)}`)
            setFile({
              ...base,
              rel: info.path || rel,
              name: info.name || baseName(rel),
              size: info.size || 0,
              mtimeMs: info.mtimeMs || 0,
              loading: false,
              url: scoped(`${API}/raw?path=${encodeURIComponent(rel)}`),
            })
            return
          }
          if (kind === 'archive') {
            const data = await api(`${API}/archive?path=${encodeURIComponent(rel)}`)
            setFile({
              ...base,
              rel: data.path || rel,
              name: data.name || baseName(rel),
              size: data.size || 0,
              loading: false,
              archive: data,
            })
            return
          }
          const payload = await api(`${API}/read?path=${encodeURIComponent(rel)}`)
          setFile({
            ...base,
            rel: payload.path,
            name: payload.name || baseName(rel),
            text: payload.content || '',
            size: payload.size || 0,
            mtimeMs: payload.mtimeMs || 0,
            loading: false,
          })
        }
        catch (error) {
          setFile({ ...base, loading: false, error: String((error && error.message) || error) })
        }
      }, [])

      // Open the file the tab was launched for, once the root has loaded.
      /** 搜索框：粘贴一个路径就跳过去（逐层展开、选中；是文件就顺手打开）。 */
      const jumpTo = useCallback(async (raw) => {
        const cleaned = String(raw || '')
          .trim()
          .replace(/^"(.*)"$/, '$1')
          .replace(/\\/g, '/')
          .replace(/\/+$/, '')
        if (!cleaned)
          return
        let rel = cleaned
        const rootSlash = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        if (rootSlash && cleaned.toLowerCase().startsWith(rootSlash))
          rel = cleaned.slice(rootSlash.length).replace(/^\/+/, '')
        else if (/^[a-zA-Z]:\//.test(cleaned)) {
          notify(`这个路径不在工作区里（工作区是 ${root}）：${cleaned}`, 'err')
          return
        }
        rel = rel.replace(/^\/+/, '')
        // 路径可能指向文件、也可能指向还不存在的位置：往上退到第一个真实存在的层级。
        const parts = rel.split('/').filter(Boolean)
        let stat = null
        let known = ''
        for (let depth = parts.length; depth >= 0; depth -= 1) {
          const candidate = parts.slice(0, depth).join('/')
          try {
            stat = await api(`${API}/stat?path=${encodeURIComponent(candidate)}`)
            known = candidate
            break
          }
          catch {
            stat = null
          }
        }
        if (!stat) {
          notify(`找不到这个路径：${cleaned}`, 'err')
          return
        }
        const target = stat.path === undefined ? known : stat.path
        setExpanded((prev) => {
          const next = { ...prev }
          for (const parent of ancestorsOf(known))
            next[parent] = true
          if (stat.dir)
            next[known] = true
          return next
        })
        for (const parent of ancestorsOf(known))
          await loadDir(parent).catch(() => {})
        if (stat.dir) {
          await loadDir(known).catch(() => {})
          setSelected(known)
          notify(known ? `已跳到 ${known}` : '已跳到工作区根目录')
        }
        else {
          setSelected(target)
          if (stat.kind !== 'binary')
            await openFileNow(target, stat.kind || kindOfName(target)).catch(() => {})
        }
        setTimeout(() => {
          try {
            const row = document.querySelector('.hx-row.sel')
            if (row && typeof row.scrollIntoView === 'function')
              row.scrollIntoView({ block: 'nearest' })
          }
          catch {}
        }, 90)
      }, [loadDir, notify, openFileNow, root])

      /** 回车：带斜杠的当路径跳，否则按文件名搜。 */
      const runFind = useCallback(async (value) => {
        const text = String(value || '').trim()
        if (!text)
          return
        if (/[\\/]/.test(text) || /^[a-zA-Z]:/.test(text)) {
          setFindHits(null)
          await jumpTo(text)
          return
        }
        setFindBusy(true)
        try {
          const payload = await api(`${API}/search?q=${encodeURIComponent(text)}`)
          setFindHits(Array.isArray(payload.results) ? payload.results : [])
        }
        catch (error) {
          setFindHits([])
          notify(`搜不了：${(error && error.message) || error}`, 'err')
        }
        finally {
          setFindBusy(false)
        }
      }, [jumpTo, notify])

      const openedTarget = useRef(false)
      useEffect(() => {
        if (openedTarget.current || !targetPath || !root)
          return
        openedTarget.current = true
        const chain = ancestorsOf(targetPath)
        if (chain.length) {
          setExpanded((prev) => {
            const next = { ...prev }
            for (const rel of chain)
              next[rel] = true
            return next
          })
          chain.forEach(rel => loadDir(rel).catch(() => {}))
        }
        setSelected(targetPath)
        openFileNow(targetPath, kindOfName(targetPath)).catch(() => {})
      }, [targetPath, root, loadDir, openFileNow])

      const requestOpen = useCallback((rel, kind) => {
        const current = fileRef.current
        if (current && current.dirty && current.rel !== rel) {
          setDialog({ mode: 'switch', from: current.rel, target: rel, kind })
          return
        }
        openFileNow(rel, kind).catch(() => {})
      }, [openFileNow])

      const save = useCallback(async () => {
        const current = fileRef.current
        if (!current || current.error)
          return false
        setBusy(true)
        try {
          const payload = await apiPost(`${API}/write`, { path: current.rel, content: current.text, create: true })
          setFile(prev => (prev ? { ...prev, dirty: false, size: payload.size || prev.size, mtimeMs: payload.mtimeMs || prev.mtimeMs } : prev))
          notify(`已保存 ${current.rel}`)
          return true
        }
        catch (error) {
          notify(`保存失败：${(error && error.message) || error}`, 'err')
          return false
        }
        finally {
          setBusy(false)
        }
      }, [notify])

      const closeFile = useCallback(() => {
        setFile(null)
      }, [])

      const doCreate = useCallback(async (name) => {
        const target = dialog
        setBusy(true)
        try {
          if (target.mode === 'newFolder') {
            await apiPost(`${API}/create`, { dir: target.dir, name, folder: true })
            setExpanded(prev => ({ ...prev, [target.dir]: true }))
            await loadDir(target.dir)
            notify(`已新建文件夹 ${name}`)
          }
          else {
            const payload = await apiPost(`${API}/create`, { dir: target.dir, name, content: '' })
            setExpanded(prev => ({ ...prev, [target.dir]: true }))
            await loadDir(target.dir)
            notify(`已新建文件 ${name}`)
            if (payload.text !== false)
              await openFileNow(payload.path, kindOfName(payload.path || name))
          }
          setDialog(null)
        }
        catch (error) {
          notify(`新建失败：${(error && error.message) || error}`, 'err')
        }
        finally {
          setBusy(false)
        }
      }, [dialog, loadDir, notify, openFileNow])

      const doRename = useCallback(async (name) => {
        const target = dialog
        setBusy(true)
        try {
          const payload = await apiPost(`${API}/rename`, { path: target.rel, name })
          await loadDir(parentOf(target.rel))
          const current = fileRef.current
          if (current && (current.rel === target.rel || current.rel.startsWith(`${target.rel}/`))) {
            if (payload.dir === true && target.isDir)
              closeFile()
            else
              await openFileNow(payload.path, kindOfName(payload.path))
          }
          notify(`已重命名为 ${name}`)
          setDialog(null)
        }
        catch (error) {
          notify(`重命名失败：${(error && error.message) || error}`, 'err')
        }
        finally {
          setBusy(false)
        }
      }, [closeFile, dialog, loadDir, notify, openFileNow])

      /** 打包：把文件/文件夹压成同目录下的 zip。 */
      const doZip = useCallback(async (rel, name) => {
        setBusy(true)
        try {
          const payload = await apiPost(`${API}/compress`, { path: rel, name })
          notify(`已打包 ${payload.path}（${fmtSize(payload.size)}）`)
          await loadDir(parentOf(rel))
          setDialog(null)
        }
        catch (error) {
          notify(`打包失败：${(error && error.message) || error}`, 'err')
        }
        finally {
          setBusy(false)
        }
      }, [loadDir, notify])

      /** 解压：默认解到压缩包旁边（同名目录已存在就自动加 -2）。 */
      const extractAt = useCallback(async (rel) => {
        setBusy(true)
        try {
          const payload = await apiPost(`${API}/extract`, { path: rel })
          const dir = parentOf(payload.dest)
          setExpanded(prev => ({ ...prev, [dir]: true }))
          await loadDir(dir)
          notify(`已解压到 ${payload.dest}`)
        }
        catch (error) {
          notify(`解压失败：${(error && error.message) || error}`, 'err')
        }
        finally {
          setBusy(false)
        }
      }, [loadDir, notify])

      const doDelete = useCallback(async (purge) => {
        const target = dialog
        setBusy(true)
        try {
          const payload = await apiPost(`${API}/delete`, { path: target.rel, purge: purge === true })
          await loadDir(parentOf(target.rel))
          const current = fileRef.current
          if (current && (current.rel === target.rel || current.rel.startsWith(`${target.rel}/`)))
            closeFile()
          notify(payload.purged ? `已彻底删除 ${target.rel}` : `已移到回收站：${payload.trash}`)
          setDialog(null)
        }
        catch (error) {
          notify(`删除失败：${(error && error.message) || error}`, 'err')
        }
        finally {
          setBusy(false)
        }
      }, [closeFile, dialog, loadDir, notify])

      const onDialogConfirm = useCallback((value) => {
        const target = dialog
        if (!target)
          return
        if (target.mode === 'newFile' || target.mode === 'newFolder') {
          if (String(value || '').trim() === '') {
            notify('名称不能为空', 'err')
            return
          }
          doCreate(String(value).trim()).catch(() => {})
          return
        }
        if (target.mode === 'rename') {
          if (String(value || '').trim() === '') {
            notify('名称不能为空', 'err')
            return
          }
          doRename(String(value).trim()).catch(() => {})
          return
        }
        if (target.mode === 'switch') {
          if (value === '__drop__')
            openFileNow(target.target, target.kind).catch(() => {})
          else if (value === '__save__')
            save().then((ok) => {
              if (ok)
                openFileNow(target.target, target.kind).catch(() => {})
            })
          setDialog(null)
          return
        }
        if (target.mode === 'zip') {
          const wanted = String(value || '').trim()
          if (wanted === '') {
            notify('名称不能为空', 'err')
            return
          }
          doZip(target.rel, wanted).catch(() => {})
          return
        }
        if (target.mode === 'delete')
          doDelete(value === '__purge__').catch(() => {})
      }, [dialog, doCreate, doDelete, doRename, doZip, notify, openFileNow, save])

      const onMenuPick = useCallback((id) => {
        const target = menu
        setMenu(null)
        if (!target)
          return
        const entry = target.entry
        const dir = entry ? (entry.dir ? entry.rel : parentOf(entry.rel)) : target.dir
        if (id === 'newFile')
          setDialog({ mode: 'newFile', dir, name: 'untitled.txt' })
        else if (id === 'newFolder')
          setDialog({ mode: 'newFolder', dir, name: '新建文件夹' })
        else if (id === 'rename')
          setDialog({ mode: 'rename', rel: entry.rel, name: entry.name })
        else if (id === 'delete')
          setDialog({ mode: 'delete', rel: entry.rel, isDir: entry.dir })
        else if (id === 'openFolder')
          requestOpen(entry.rel)
        else if (id === 'extract')
          extractAt(entry.rel).catch(() => {})
        else if (id === 'zip')
          setDialog({ mode: 'zip', rel: entry.rel, name: `${entry.name}.zip` })
        else if (id === 'refresh')
          loadDir(entry && entry.dir ? entry.rel : dir).catch(() => {})
      }, [extractAt, loadDir, menu, requestOpen])

      useEffect(() => {
        if (typeof tab.actions?.bindCommands === 'function') {
          try {
            tab.actions.bindCommands({ refresh: () => loadDir('') })
          }
          catch {}
        }
      }, [tab, loadDir])

      // 空白处右键时用来当「新建目标目录」：选中项是文件就落到它所在目录，是目录就用它本身。
      const selectedDir = useMemo(() => {
        if (!selected)
          return ''
        for (const rel of Object.keys(listings)) {
          const node = listings[rel]
          if (!node || !Array.isArray(node.entries))
            continue
          for (const item of node.entries) {
            if (item.rel === selected)
              return item.dir ? item.rel : parentOf(item.rel)
          }
        }
        return selected
      }, [listings, selected])

      const rows = useMemo(() => {
        const out = []
        const context = {
          listings,
          expanded,
          selected,
          file,
          onRow: (entry) => {
            setSelected(entry.rel)
            if (entry.dir)
              toggleDir(entry.rel)
            else
              requestOpen(entry.rel, entry.kind)
          },
          onMenu: (event, entry) => {
            event.preventDefault()
            event.stopPropagation()
            if (entry)
              setSelected(entry.rel)
            setMenu({
              x: event.clientX,
              y: event.clientY,
              entry: entry || null,
              dir: entry ? (entry.dir ? entry.rel : parentOf(entry.rel)) : selected,
            })
          },
        }
        const walk = (rel, depth) => {
          const node = listings[rel]
          const pad = 6 + depth * 13
          if (!node || node.state === 'loading') {
            out.push(h('div', { className: 'hx-note', key: `${rel}#loading`, style: { paddingLeft: pad + 10 } }, '读取中…'))
            return
          }
          if (node.state === 'error') {
            out.push(h('div', { className: 'hx-note err', key: `${rel}#error`, style: { paddingLeft: pad + 10 } }, String(node.error)))
            return
          }
          if (!node.entries.length) {
            out.push(h('div', { className: 'hx-note', key: `${rel}#empty`, style: { paddingLeft: pad + 10 } }, '空目录'))
            return
          }
          for (const entry of node.entries) {
            const isOpen = Boolean(expanded[entry.rel])
            out.push(h(
              'div',
              {
                key: entry.rel,
                className: `hx-row${selected === entry.rel ? ' sel' : ''}${file && file.rel === entry.rel ? ' act' : ''}`,
                style: { paddingLeft: pad },
                title: entry.rel,
                onClick: () => context.onRow(entry),
                onContextMenu: event => context.onMenu(event, entry),
              },
              h('span', { className: 'hx-tw' }, entry.dir ? (isOpen ? '▾' : '▸') : ''),
              ic(entry.dir
                ? (isOpen ? P.IconFolderOpenRegular : P.IconFolderCloseRegular)
                : (isCodeFile(entry.name) ? P.IconCodeOutlineRegular : P.IconDeliverDocRegular), 13),
              h('span', { className: 'hx-name' }, entry.name),
            ))
            if (entry.dir && isOpen)
              walk(entry.rel, depth + 1)
          }
        }
        walk('', 0)
        return out
      }, [expanded, file, listings, requestOpen, selected, toggleDir])

      return h(
        'div',
        { className: 'hx-root' },
        h(
          'div',
          { className: 'hx-side' },
          h(
            'div',
            { className: 'hx-side-head' },
            h('span', { className: 'hx-path', title: root || '工作区' }, root || '工作区'),
            h('button', {
              className: 'hx-ico',
              title: '在根目录新建文件',
              onClick: () => setDialog({ mode: 'newFile', dir: '', name: 'untitled.txt' }),
            }, ic(P.IconPlusOutlineRegular, 13)),
            h('button', {
              className: 'hx-ico',
              title: '刷新根目录',
              onClick: () => loadDir(''),
            }, ic(P.IconRefreshOutlineRegular, 13)),
          ),
          h(
            'div',
            { className: 'hx-find' },
            h(
              'div',
              { className: 'hx-find-row' },
              h('input', {
                className: 'hx-in hx-find-in',
                value: find,
                placeholder: '搜文件名，或粘贴路径跳转',
                spellCheck: false,
                title: '回车搜索；粘贴工作区里的相对路径（如 docs/readme.md）会直接跳到那一层',
                onChange: (event) => setFind(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    runFind(find).catch(() => {})
                  }
                  else if (event.key === 'Escape') {
                    setFindHits(null)
                  }
                },
              }),
              findHits === null
                ? null
                : h('button', {
                  className: 'hx-ico',
                  title: '收起结果',
                  onClick: () => setFindHits(null),
                }, '×'),
            ),
            findHits === null
              ? null
              : h(
                'div',
                { className: 'hx-find-list' },
                findHits.length === 0
                  ? h('div', { className: 'hx-note' }, findBusy ? '搜着呢…' : '没找到')
                  : findHits.map((hit, index) => h(
                    'div',
                    {
                      className: 'hx-find-hit',
                      key: `${index}:${hit.path}`,
                      title: hit.path,
                      onClick: () => {
                        setFindHits(null)
                        jumpTo(hit.path).catch(() => {})
                      },
                    },
                    ic(hit.dir
                      ? P.IconFolderOpenRegular
                      : (isCodeFile(hit.name) ? P.IconCodeOutlineRegular : P.IconDeliverDocRegular), 12),
                    h('span', { className: 'hx-name' }, hit.name),
                    h('span', { className: 'hx-spacer' }),
                    h('span', { className: 'hx-note' }, parentOf(hit.path) || '根目录'),
                  )),
              ),
          ),
          h(
            'div',
            {
              className: 'hx-tree',
              onContextMenu: (event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, entry: null, dir: selectedDir })
              },
            },
            rows,
          ),
        ),
        h(
          'div',
          { className: 'hx-main' },
          file
            ? (file.kind === 'image'
              ? h(ImagePane, { file, onClose: closeFile })
              : file.kind === 'audio' || file.kind === 'video'
                ? h(MediaPane, { file, onClose: closeFile })
                : file.kind === 'archive'
                  ? h(ArchivePane, {
                    file,
                    busy,
                    onClose: closeFile,
                    onExtract: () => { extractAt(file.rel).catch(() => {}) },
                  })
                  : h(EditorPane, {
                  file,
                  busy,
                  onSave: () => { save().catch(() => {}) },
                  onClose: closeFile,
                  onChange: (text) => setFile(prev => (prev ? { ...prev, text, dirty: true } : prev)),
                }))
            : h(
              'div',
              { className: 'hx-empty' },
              ic(P.IconWorkspaceTreeOutlineRegular || P.IconFolderOpenRegular, 28),
              h('div', null, '左边选一个文件打开'),
              h('div', { style: { fontSize: 11.5 } }, '右键目录：新建文件 / 新建文件夹；右键文件：重命名、删除'),
              h('div', { style: { fontSize: 11.5 } }, 'Ctrl+S 保存 · Ctrl+D 复制当前行 · Tab 缩进'),
            ),
        ),
        menu ? h(ContextMenu, { menu, onClose: () => setMenu(null), onPick: onMenuPick }) : null,
        dialog ? h(Dialog, { dialog, busy, onCancel: () => setDialog(null), onConfirm: onDialogConfirm }) : null,
        toast ? h('div', { className: `hx-toast${toast.tone === 'err' ? ' err' : ''}` }, toast.text) : null,
      )
    }

    // ------------------------------------------------------------------- apply

    function definition() {
      return {
        id: ID,
        kind: KIND,
        multiple: true,
        priority: 'extension',
        patterns: CLAIM_PATTERNS,
        title: address => (relFromAddress(address) ? baseName(relFromAddress(address)) : '工作区 IDE'),
        guide: [{
          id: 'ide',
          order: 40,
          title: () => '工作区 IDE',
          description: () => '左树右编辑：新建、改名、删除、保存',
          icon: P.GuideArtworkFiles,
          commandId: COMMAND_OPEN,
        }],
      }
    }

    function apply(ctx) {
      ensureStyle()
      try {
        report('client half mounted')
      }
      catch {}
      ctx.effect(() => ctx.sidebarRightTabs.register(definition()), 'dsh-ide-vscode: tab type')
      ctx.inject(['shortcuts'], scope => {
        scope.effect(() => scope.shortcuts.register({
          id: COMMAND_OPEN,
          label: () => '打开工作区 IDE',
          aliases: ['ide', 'workspace ide', '工作区 IDE', '编辑器'],
          defaults: {
            'desktop:macos': { code: 'KeyD', modifiers: ['primary'] },
            'desktop:windows': { code: 'KeyD', modifiers: ['primary'] },
            'desktop:linux': { code: 'KeyD', modifiers: ['primary'] },
            'web:macos': { code: 'KeyD', modifiers: ['primary', 'alt'] },
            'web:windows': { code: 'KeyD', modifiers: ['primary', 'alt'] },
          },
          regions: ['page', 'editable', 'terminal'],
          modals: [],
          resolve: ({ target }) => {
            // 焦点在编辑器里：这一下是「复制当前行」，不是开面板。
            const duplicate = duplicateActionFor(target)
            if (duplicate !== undefined)
              return { status: 'handled', run: duplicate }
            const captured = ctx.sidebarRight.commandTarget(target)
            if (captured === undefined)
              return { status: 'blocked', reason: '当前没有可打开的工作区面板' }
            return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget(KIND, captured) } }
          },
        }), 'dsh-ide-vscode: shortcut')
      })
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
      }, IdeBody)), 'dsh-ide-vscode: tab body')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = ID
    // Offline test seam only; the loader reads apply/inject/name and ignores this.
    exports.__internals = { relFromAddress, ancestorsOf, definition, CLAIM_PATTERNS, duplicateLine, duplicateActionFor, editorDuplicate }
    return module.exports
  },
})
