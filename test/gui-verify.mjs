/**
 * Real-GUI verification for the dsh-ide-vscode panel.
 *
 * Boots a headless Edge with CDP, opens a running DSH web instance, screenshots
 * the start page, clicks the「工作区 IDE」guide card and reports what the panel
 * actually rendered.
 *
 * Usage: node test/gui-verify.mjs "<http://127.0.0.1:PORT/?token=...>" [outDir]
 *
 * Edge is spawned with stdio ignored (piped stdio is not allowed here); all
 * control happens over the CDP HTTP/WebSocket endpoint.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TARGET_URL = process.argv[2]
const OUT_DIR = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'gui-verify'))
const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333
const VIEW = { width: 1600, height: 1000 }

if (!TARGET_URL) {
  console.error('usage: node test/gui-verify.mjs "<url with token>" [outDir]')
  process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function json(pathname, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method })
  return response.json()
}

/* ------------------------------------------------------------ start Edge --- */

await mkdir(OUT_DIR, { recursive: true })
spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MsEdgeIdentityFeatures',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT_DIR, 'edge-profile')}`,
  `--window-size=${VIEW.width},${VIEW.height}`,
  'about:blank',
], { detached: true, stdio: 'ignore' }).unref()

let version
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    version = await json('/json/version')
    break
  }
  catch {
    await sleep(500)
  }
}
if (!version) {
  console.error('edge did not expose a CDP endpoint')
  process.exit(1)
}

const target = await json(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT')

/* --------------------------------------------------------------- cdp glue --- */

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error)
      reject(new Error(JSON.stringify(message.error)))
    else
      resolve(message.result)
    return
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')
    consoleErrors.push(String(message.params.entry.text).slice(0, 300))
  if (message.method === 'Runtime.exceptionThrown')
    consoleErrors.push(String(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).slice(0, 300))
})

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails)
    return { error: String(result.exceptionDetails.exception?.description || result.exceptionDetails.text) }
  return { value: result.result.value }
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT_DIR, name)
  await writeFile(file, Buffer.from(result.data, 'base64'))
  return file
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: TARGET_URL })
await sleep(9000)

const report = { edge: version.Browser, url: TARGET_URL, steps: [] }
report.steps.push({ name: 'loaded', title: (await evaluate('document.title')).value, file: await shot('01-loaded.png') })

const buttons = (await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('button,[role="button"],[title]')).map(node => ({
  tag: node.tagName,
  title: node.getAttribute('title'),
  aria: node.getAttribute('aria-label'),
  text: (node.textContent || '').trim().slice(0, 24),
})).slice(0, 120))`)).value
report.buttons = JSON.parse(buttons || '[]')

async function text() {
  return (await evaluate('document.body.innerText.replace(/\\n{2,}/g, "\\n").slice(0, 4000)')).value || ''
}

report.startText = await text()

/* ---- click the guide card, opening the right sidebar first when needed ---- */

async function findCard() {
  return (await evaluate(`(() => {
    const wanted = '工作区 IDE'
    const node = Array.from(document.querySelectorAll('*')).find(el => el.children.length === 0 && (el.textContent || '').trim() === wanted)
    if (!node) return false
    const clickable = node.closest('[role="button"],button,li,div')
    ;(clickable || node).click()
    return true
  })()`)).value
}

let cardClicked = await findCard()
if (!cardClicked) {
  const selectors = [
    '[title*="右"]', '[aria-label*="右"]',
    '[title*="sidebar" i]', '[aria-label*="sidebar" i]',
    '[title*="面板"]', '[aria-label*="面板"]',
  ]
  for (const selector of selectors) {
    const clicked = (await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return false
      node.click()
      return true
    })()`)).value
    if (!clicked)
      continue
    await sleep(2500)
    report.steps.push({ name: `toggle ${selector}`, text: (await text()).slice(0, 400) })
    cardClicked = await findCard()
    if (cardClicked)
      break
  }
}

await sleep(5000)
report.cardClicked = cardClicked
report.steps.push({ name: 'after card click', text: await text(), file: await shot('02-after-click.png') })

report.panel = (await evaluate(`JSON.stringify({
  side: document.querySelectorAll('.hx-side').length,
  tree: document.querySelectorAll('.hx-tree').length,
  rows: document.querySelectorAll('.hx-row').length,
  names: Array.from(document.querySelectorAll('.hx-row .hx-name')).slice(0, 12).map(node => node.textContent),
  editor: document.querySelectorAll('.hx-ta').length,
  editorValue: document.querySelector('.hx-ta') ? document.querySelector('.hx-ta').value.slice(0, 120) : null,
  empty: document.querySelectorAll('.hx-empty').length,
  styleTag: !!document.getElementById('dsh-ide-vscode-style'),
  tabChips: Array.from(document.querySelectorAll('[class*="tab"]')).map(node => (node.textContent || '').trim()).filter(Boolean).slice(0, 12),
})`)).value
report.panel = JSON.parse(report.panel || '{}')
/* ---- interaction pass: open, edit, save, create, delete ---------------- */

const { readFile, readdir, stat } = await import('node:fs/promises')
const ROOT = process.env.IDE_GUI_ROOT || process.cwd()

async function clickExpr(expression) {
  const result = await evaluate(expression)
  return result.value === true
}

async function rowExpr(name) {
  return `Array.from(document.querySelectorAll('.hx-row')).find(row => row.querySelector('.hx-name') && row.querySelector('.hx-name').textContent === ${JSON.stringify(name)})`
}

async function menuPick(label) {
  return realClick(`Array.from(document.querySelectorAll('.hx-menu .hx-mi')).find(node => node.textContent.includes(${JSON.stringify(label)}))`)
}

async function dialogFill(value) {
  return evaluate(`(() => {
    const input = document.querySelector('.hx-dlg .hx-in')
    if (!input) return null
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
}

async function dialogConfirm(label) {
  return realClick(`Array.from(document.querySelectorAll('.hx-dlg .hx-btn')).find(node => node.textContent === ${JSON.stringify(label)})`)
}

/* -- real mouse / keyboard: el.click() skips pointerdown, which is exactly the
      path a real user takes. Menu items used to die there. ------------------ */

async function rectOf(expression) {
  const result = await evaluate(`(() => {
    const node = ${expression}
    if (!node) return null
    const rect = node.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  return result.value
}

async function realMouse(x, y, button) {
  const buttons = button === 'right' ? 2 : 1
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 })
  await sleep(50)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 })
}

async function realClick(expression) {
  const point = await rectOf(expression)
  if (!point)
    return false
  await realMouse(point.x, point.y, 'left')
  return true
}

async function realRightClick(expression) {
  const point = await rectOf(expression)
  if (!point)
    return false
  await realMouse(point.x, point.y, 'right')
  return true
}

async function realCtrlS() {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 })
  await sleep(40)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 })
}

const interactions = {}

// dismiss the first-run notices so later clicks are not swallowed by an overlay
for (const label of ['继续', '稍后配置']) {
  if (await realClick(`Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(label)})`))
    await sleep(1500)
}

// open docs/hello.js from the tree
interactions.blockedBy = (await evaluate(`(() => {
  const row = ${await rowExpr('hello.js')}
  if (!row) return 'no hello.js row'
  const rect = row.getBoundingClientRect()
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return row.contains(top) ? null : 'hit ' + (top ? top.className || top.tagName : 'nothing')
})()`)).value
interactions.openedFromTree = await realClick(await rowExpr('hello.js'))
await sleep(2500)
interactions.editorAfterOpen = (await evaluate(`JSON.stringify({
  value: document.querySelector('.hx-ta') ? document.querySelector('.hx-ta').value : null,
  name: document.querySelector('.hx-fname') ? document.querySelector('.hx-fname').textContent : null,
  status: document.querySelector('.hx-status') ? document.querySelector('.hx-status').textContent : null,
})`)).value
report.steps.push({ name: 'file opened from tree', file: await shot('03-open-file.png') })

// edit and save with Ctrl+S
interactions.typed = (await evaluate(`(() => {
  const area = document.querySelector('.hx-ta')
  if (!area) return null
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(area, 'const hello = "gui saved"\\nconsole.log(hello)\\n')
  area.dispatchEvent(new Event('input', { bubbles: true }))
  return area.value
})()`)).value
await sleep(800)
interactions.saved = (await evaluate(`(() => {
  const area = document.querySelector('.hx-ta')
  if (!area) return false
  area.focus()
  return true
})()`)).value === true
await realCtrlS()
await sleep(2000)
interactions.fileOnDisk = await readFile(path.join(ROOT, 'hello.js'), 'utf8').catch(error => `ERR ${error.code}`)
interactions.statusAfterSave = (await evaluate(`document.querySelector('.hx-status') ? document.querySelector('.hx-status').textContent : null`)).value
report.steps.push({ name: 'after Ctrl+S', file: await shot('04-saved.png') })

// right-click the docs folder -> new file, then switch the suffix with a chip
interactions.contextMenu = await realRightClick(await rowExpr('docs'))
await sleep(900)
interactions.menuItems = (await evaluate(`Array.from(document.querySelectorAll('.hx-menu .hx-mi')).map(node => node.textContent)`)).value
interactions.pickedNewFile = await menuPick('新建文件')
await sleep(900)
interactions.filledName = (await dialogFill('probe')).value
await sleep(300)
interactions.chip = await realClick(`Array.from(document.querySelectorAll('.hx-chip')).find(node => node.textContent === '.md')`)
await sleep(400)
interactions.nameAfterChip = (await evaluate(`document.querySelector('.hx-dlg .hx-in') ? document.querySelector('.hx-dlg .hx-in').value : null`)).value
report.steps.push({ name: 'new file dialog', file: await shot('05-new-file-dialog.png') })
interactions.confirmed = await dialogConfirm('确定')
await sleep(2200)
interactions.probeOnDisk = await stat(path.join(ROOT, 'docs', 'probe.md')).then(info => `ok ${info.size} B`, error => `ERR ${error.code}`)

// rename it (suffix change is the same dialog)
interactions.renameMenu = await realRightClick(await rowExpr('probe.md'))
await sleep(800)
await menuPick('重命名')
await sleep(800)
interactions.renamePrefill = (await evaluate(`document.querySelector('.hx-dlg .hx-in') ? document.querySelector('.hx-dlg .hx-in').value : null`)).value
await dialogFill('probe.ps1')
await sleep(300)
await dialogConfirm('确定')
await sleep(2200)
interactions.renamedOnDisk = await stat(path.join(ROOT, 'docs', 'probe.ps1')).then(() => 'ok', error => `ERR ${error.code}`)
interactions.oldNameGone = await stat(path.join(ROOT, 'docs', 'probe.md')).then(() => 'still there', error => `gone (${error.code})`)

// delete it -> recycle bin
await realRightClick(await rowExpr('probe.ps1'))
await sleep(800)
await menuPick('删除')
await sleep(800)
interactions.deleted = await dialogConfirm('移到回收站')
await sleep(2200)
interactions.deletedOnDisk = await stat(path.join(ROOT, 'docs', 'probe.ps1')).then(() => 'still there', error => `gone (${error.code})`)
const trashDir = path.join(ROOT, 'workspace', 'backup', 'ide-trash')
interactions.trash = await readdir(trashDir).catch(() => [])
report.steps.push({ name: 'after delete', file: await shot('06-after-delete.png') })

// new folder
await realRightClick(await rowExpr('docs'))
await sleep(800)
interactions.pickedNewFolder = await menuPick('新建文件夹')
await sleep(900)
await dialogFill('sub')
await sleep(300)
await dialogConfirm('确定')
await sleep(2200)
interactions.newFolderOnDisk = await stat(path.join(ROOT, 'docs', 'sub')).then(info => (info.isDirectory() ? 'directory' : 'not a directory'), error => `ERR ${error.code}`)
report.steps.push({ name: 'after new folder', file: await shot('07-after-new-folder.png') })

// a picture must open as a preview, never in the text editor
interactions.pictureClicked = await realClick(await rowExpr('pixel.png'))
await sleep(3000)
if (!(await evaluate(`!!document.querySelector('.hx-img-wrap')`)).value) {
  // the tree may have re-rendered between measuring the row and clicking it
  interactions.pictureRetry = await realClick(await rowExpr('pixel.png'))
  await sleep(3000)
}
interactions.pictureMain = (await evaluate(`document.querySelector('.hx-main') ? document.querySelector('.hx-main').innerHTML.slice(0, 300) : 'no .hx-main'`)).value
interactions.picturePane = (await evaluate(`JSON.stringify({
  wrap: !!document.querySelector('.hx-img-wrap'),
  tag: document.querySelector('.hx-tag') ? document.querySelector('.hx-tag').textContent : null,
  textarea: !!document.querySelector('.hx-ta'),
  src: document.querySelector('img.hx-img') ? document.querySelector('img.hx-img').getAttribute('src') : null,
  naturalWidth: (function () { const img = document.querySelector('img.hx-img'); return img ? img.naturalWidth : null })(),
  status: document.querySelector('.hx-status') ? document.querySelector('.hx-status').textContent : null
})`)).value
report.steps.push({ name: 'picture preview', file: await shot('08-picture.png') })

// an archive must list its members and unpack next to itself
if (!(await evaluate(`!!${await rowExpr('sample.zip')}`)).value)
  await realClick(await rowExpr('docs'))
await sleep(1000)
await realClick(await rowExpr('sample.zip'))
await sleep(2500)
interactions.archivePane = (await evaluate(`JSON.stringify({
  box: !!document.querySelector('.hx-arch'),
  tag: document.querySelector('.hx-tag') ? document.querySelector('.hx-tag').textContent : null,
  members: document.querySelector('.hx-arch') ? document.querySelector('.hx-arch').textContent : null
})`)).value
report.steps.push({ name: 'archive listing', file: await shot('09-archive.png') })
interactions.unpackClicked = await realClick(`Array.from(document.querySelectorAll('button')).find(node => node.textContent.includes('解压到旁边'))`)
await sleep(3500)
interactions.unpackedOnDisk = await (async () => {
  const stack = [path.join(ROOT, 'docs')]
  while (stack.length) {
    const dir = stack.pop()
    for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (item.isDirectory())
        stack.push(path.join(dir, item.name))
      else if (item.name === 'inner.txt')
        return `${path.relative(ROOT, path.join(dir, item.name)).replace(/\\/g, '/')} ok`
    }
  }
  return 'not found'
})()
report.steps.push({ name: 'after unpack', file: await shot('10-unpacked.png') })

/* ---- audio / video: the players stream from the raw route ---- */

await realClick(await rowExpr('sound.wav'))
await sleep(2500)
interactions.audioPane = (await evaluate(`JSON.stringify({
  wrap: !!document.querySelector('.hx-media-wrap'),
  tag: document.querySelector('.hx-tag') ? document.querySelector('.hx-tag').textContent : null,
  src: document.querySelector('audio.hx-audio') ? document.querySelector('audio.hx-audio').getAttribute('src') : null,
  readyState: (function () { const node = document.querySelector('audio.hx-audio'); return node ? node.readyState : null })(),
  duration: (function () { const node = document.querySelector('audio.hx-audio'); return node ? node.duration : null })(),
  error: (function () { const node = document.querySelector('audio.hx-audio'); return node && node.error ? node.error.code : null })(),
  status: document.querySelector('.hx-status') ? document.querySelector('.hx-status').textContent : null
})`)).value
report.steps.push({ name: 'audio player', file: await shot('11-audio.png') })

await realClick(await rowExpr('clip.mp4'))
await sleep(2200)
interactions.videoPane = (await evaluate(`JSON.stringify({
  wrap: !!document.querySelector('.hx-media-wrap'),
  tag: document.querySelector('.hx-tag') ? document.querySelector('.hx-tag').textContent : null,
  src: document.querySelector('video.hx-video') ? document.querySelector('video.hx-video').getAttribute('src') : null,
  textarea: !!document.querySelector('.hx-ta'),
  status: document.querySelector('.hx-status') ? document.querySelector('.hx-status').textContent : null
})`)).value
// 播放器拖动进度条靠 Range —— 用和 <video> 一样的方式问一次
interactions.videoRange = (await evaluate(`(async () => {
  const node = document.querySelector('video.hx-video')
  const src = node ? node.getAttribute('src') : null
  if (!src) return 'no video src'
  const res = await fetch(src, { headers: { Range: 'bytes=0-1' } })
  const body = await res.arrayBuffer()
  return res.status + ' ' + res.headers.get('content-range') + ' len=' + body.byteLength
})()`)).value
report.steps.push({ name: 'video player', file: await shot('12-video.png') })

/* ---- tar (not only zip) lists its members ---- */

if (!(await evaluate(`!!${await rowExpr('sample.tar')}`)).value)
  await realClick(await rowExpr('docs'))
await sleep(900)
await realClick(await rowExpr('sample.tar'))
await sleep(2200)
interactions.tarPane = (await evaluate(`JSON.stringify({
  box: !!document.querySelector('.hx-arch'),
  tag: document.querySelector('.hx-tag') ? document.querySelector('.hx-tag').textContent : null,
  members: document.querySelector('.hx-arch') ? document.querySelector('.hx-arch').textContent : null
})`)).value
report.steps.push({ name: 'tar listing', file: await shot('13-tar.png') })

/* ---- search box: bare word searches, pasted path jumps ---- */

async function realEnter() {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
}

async function typeInto(selector, value) {
  await realClick(`document.querySelector(${JSON.stringify(selector)})`)
  await sleep(250)
  return (await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return null
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)).value
}

interactions.searchTyped = await typeInto('.hx-find-in', 'inner')
await realEnter()
await sleep(2500)
interactions.searchHits = (await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.hx-find-hit')).map(node => node.textContent))`)).value
report.steps.push({ name: 'search hits', file: await shot('14-search.png') })
interactions.searchHitClicked = await realClick(`document.querySelector('.hx-find-hit')`)
await sleep(2500)
interactions.searchJump = (await evaluate(`JSON.stringify({
  bar: document.querySelector('.hx-bar') ? document.querySelector('.hx-bar').textContent : null,
  hitsLeft: document.querySelectorAll('.hx-find-hit').length,
  selected: document.querySelector('.hx-row.sel') ? document.querySelector('.hx-row.sel').textContent : null
})`)).value

interactions.pathPasted = await typeInto('.hx-find-in', path.join(ROOT, 'docs'))
await realEnter()
await sleep(2500)
interactions.pathJump = (await evaluate(`JSON.stringify({
  selected: document.querySelector('.hx-row.sel') ? document.querySelector('.hx-row.sel').textContent : null,
  toast: document.querySelector('.hx-toast') ? document.querySelector('.hx-toast').textContent : null,
  rows: Array.from(document.querySelectorAll('.hx-row .hx-name')).map(node => node.textContent).slice(0, 8)
})`)).value
report.steps.push({ name: 'path jump', file: await shot('15-path-jump.png') })

report.interactions = interactions
report.consoleErrors = consoleErrors
report.screenshots = report.steps.map(step => step.file).filter(Boolean)

await writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
socket.close()
process.exit(0)
