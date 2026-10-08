/**
 * End-to-end DOM test: mounts the real panel component in jsdom against the real
 * host routes on a real HTTP server, then drives it the way a user would
 * (click a file, type, Ctrl+S, right-click create/rename/delete).
 *
 * Sandbox: <system temp>/ide-e2e (DSH_IDE_ROOT), torn down at the end.
 *
 * Run: node test/dom-e2e.mjs
 */
import http from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const SANDBOX = path.resolve(process.env.DSH_IDE_SANDBOX || path.join(os.tmpdir(), 'ide-e2e'))
const DEPS = process.env.DSH_IDE_TEST_DEPS || path.join(os.tmpdir(), 'ide-test-deps')

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition)
    passed += 1
  else
    failures.push(`${label}${detail === undefined ? '' : ` → ${detail}`}`)
}

/* ------------------------------------------------------------- sandbox --- */

await fs.rm(SANDBOX, { recursive: true, force: true })
await fs.mkdir(path.join(SANDBOX, 'docs'), { recursive: true })
await fs.writeFile(path.join(SANDBOX, 'hello.js'), 'const a = 1\nconst b = 2\n', 'utf8')
await fs.writeFile(path.join(SANDBOX, 'docs', 'note.txt'), 'note\n', 'utf8')
await fs.mkdir(path.join(SANDBOX, 'docs', 'zipped'), { recursive: true })
await fs.writeFile(path.join(SANDBOX, 'docs', 'zipped', 'inner.txt'), 'inner\n', 'utf8')
await fs.writeFile(path.join(SANDBOX, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))
process.env.DSH_IDE_ROOT = SANDBOX

const { routes } = await import('../lib/index.js')

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  const route = routes.find(item => item.kind === 'exact' && item.path === pathname)
  if (!route) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"no route"}')
    return
  }
  await route.handler(request, response)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

// 用真实路由先把 docs/zipped 打包，树里才会有一个压缩包可点
const zipFixture = await fetch(`${BASE}/api/ide-vscode/compress`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: 'docs/zipped', name: 'zipped.zip' }),
})
if (zipFixture.status !== 200)
  failures.push(`fixture zip failed → ${zipFixture.status} ${await zipFixture.text()}`)

/* ------------------------------------------------------------------ dom --- */

const depRequire = createRequire(path.join(DEPS, 'package.json'))
const { JSDOM } = depRequire('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${BASE}/`, pretendToBeVisual: true })
const { window } = dom
const realFetch = globalThis.fetch
const baseFetch = (input, init) => realFetch(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init)

globalThis.window = window
globalThis.document = window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
try {
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
}
catch {}
globalThis.fetch = baseFetch
window.fetch = baseFetch

const React = depRequire('react')
const ReactDOMClient = depRequire('react-dom/client')
const { act } = depRequire('react-dom/test-utils')
const h = React.createElement

/* ---------------------------------------------------------- client half --- */

const source = await fs.readFile(new URL('../client/client.js', import.meta.url), 'utf8')
let spec
window.__ModuleLoader__ = { load: loaded => { spec = loaded } }

const icon = () => function StubIcon() { return null }
const primitives = {
  GuideArtworkFiles: icon(),
  IconPlusOutlineRegular: icon(),
  IconRefreshOutlineRegular: icon(),
  IconFolderOpenRegular: icon(),
  IconFolderCloseRegular: icon(),
  IconCodeOutlineRegular: icon(),
  IconDeliverDocRegular: icon(),
  IconTrashOutlineRegular: icon(),
  IconEditOutlineRegular: icon(),
  IconWorkspaceTreeOutlineRegular: icon(),
  languageForPath: name => (/\.js$/.test(name) ? 'javascript' : 'text'),
  useCodeHighlighter: () => code => String(code).split('\n').map(line => (line ? [{ text: line, style: { color: '#7aa2f7' } }] : [])),
}
const requireStub = (name) => {
  if (name === 'react')
    return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives')
    return primitives
  throw new Error(`unexpected require("${name}")`)
}

new Function('window', 'document', 'fetch', source)(window, window.document, baseFetch)
const mod = spec.factory(requireStub)

const slots = []
mod.apply({
  effect: callback => callback(),
  sidebarRightTabs: { register: () => () => {} },
  slots: {
    inject: (name, factory) => factory(),
    register: (declaration, component) => {
      slots.push(component)
      return () => {}
    },
  },
})
const Body = slots[0]

/* ------------------------------------------------------------ mounting --- */

const container = window.document.createElement('div')
window.document.body.appendChild(container)
const root = ReactDOMClient.createRoot(container)

/**
 * React only flushes pending state updates and effects when an `act` scope exits,
 * and this panel advances through request → state → effect → request chains.
 * So one long act scope is not enough: run several short ones.
 */
async function flush(ms = 70) {
  const rounds = Math.max(3, Math.round(ms / 12))
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, Math.min(ms, 12)))
    })
  }
}

function rows() {
  return Array.from(container.querySelectorAll('.hx-row'))
}
function rowNamed(name) {
  return rows().find(row => row.querySelector('.hx-name')?.textContent === name)
}
function menuItems() {
  return Array.from(container.querySelectorAll('.hx-menu .hx-mi'))
}
async function click(element) {
  // A real mouse click is pointerdown → mousedown → pointerup → mouseup → click.
  // Dispatching only "click" hides bugs where a document-level pointerdown
  // listener unmounts the node before the click can land (that is exactly how
  // the context menu used to swallow「新建文件」).
  await act(async () => {
    const fire = (type, ctor) => element.dispatchEvent(new window[ctor](type, { bubbles: true, cancelable: true, button: 0 }))
    fire('pointerdown', 'MouseEvent')
    fire('mousedown', 'MouseEvent')
    fire('pointerup', 'MouseEvent')
    fire('mouseup', 'MouseEvent')
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await flush()
}
async function clickOutside(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
  await flush(20)
}
async function rightClick(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 }))
  })
  await flush(20)
}
async function clickMenu(label) {
  const item = menuItems().find(node => node.textContent.includes(label))
  check(`menu item "${label}" exists`, !!item, menuItems().map(node => node.textContent).join(' | '))
  if (item)
    await click(item)
}
function setValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')
  descriptor.set.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}
async function type(element, value) {
  await act(async () => { setValue(element, value) })
  await flush(10)
}
async function confirmDialog(label) {
  const button = Array.from(container.querySelectorAll('.hx-dlg .hx-btn')).find(node => node.textContent === label)
  check(`dialog button "${label}" exists`, !!button, Array.from(container.querySelectorAll('.hx-dlg .hx-btn')).map(node => node.textContent).join(' | '))
  if (button)
    await click(button)
}

/* ----------------------------------------------------------------- flow --- */

try {
  const address = 'dsh-resource://file/session/ses-1/hello.js'
  await act(async () => {
    root.render(h(Body, { useTabInfo: () => ({ tab: { id: 'tab-1', navigation: { address } } }) }))
  })
  await flush(400)

  check('tree lists the sandbox root', !!rowNamed('hello.js') && !!rowNamed('docs'), rows().map(row => row.querySelector('.hx-name')?.textContent).join(','))
  const area = container.querySelector('.hx-ta')
  check('addressed file opened automatically', area?.value === 'const a = 1\nconst b = 2\n', JSON.stringify(area?.value))
  check('status line shows the file', container.querySelector('.hx-status')?.textContent.includes('hello.js'), container.querySelector('.hx-status')?.textContent)

  // edit + Ctrl+S
  await type(area, 'const a = 42\nconst b = 2\n')
  check('edit marks the buffer dirty', container.querySelector('.hx-status')?.textContent.includes('未保存'), container.querySelector('.hx-status')?.textContent)
  await act(async () => {
    area.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
  })
  await flush(120)
  check('Ctrl+S wrote the file', (await fs.readFile(path.join(SANDBOX, 'hello.js'), 'utf8')) === 'const a = 42\nconst b = 2\n')
  check('save clears the dirty flag', container.querySelector('.hx-status')?.textContent.includes('已保存'), container.querySelector('.hx-status')?.textContent)

  // expand a folder, open a file from the tree
  await click(rowNamed('docs'))
  check('folder expands', !!rowNamed('note.txt'), rows().map(row => row.querySelector('.hx-name')?.textContent).join(','))
  await click(rowNamed('note.txt'))
  check('tree click opens the other file', container.querySelector('.hx-ta')?.value === 'note\n', JSON.stringify(container.querySelector('.hx-ta')?.value))

  // right-click a folder → new file with a changed suffix
  await rightClick(rowNamed('docs'))
  check('right-click opened a context menu', menuItems().length > 0, String(menuItems().length))
  // regression: the real-mouse pointerdown must not unmount the menu before the click lands
  if (menuItems()[0]) {
    await clickOutside(menuItems()[0])
    check('pointerdown on a menu item keeps the menu mounted', menuItems().length > 0, 'menu closed on pointerdown')
  }
  await clickOutside(container.querySelector('.hx-main') || document.body)
  check('pointerdown outside closes the menu', menuItems().length === 0, 'menu stayed mounted')
  await rightClick(rowNamed('docs'))
  await clickMenu('新建文件…')
  const nameInput = container.querySelector('.hx-dlg .hx-in')
  check('new-file dialog opened', !!nameInput, container.querySelector('.hx-dlg')?.textContent)
  await type(nameInput, 'untitled')
  const chip = Array.from(container.querySelectorAll('.hx-chip')).find(node => node.textContent === '.md')
  check('suffix chip exists', !!chip)
  if (chip)
    await click(chip)
  check('suffix chip rewrites the name', container.querySelector('.hx-dlg .hx-in')?.value === 'untitled.md', container.querySelector('.hx-dlg .hx-in')?.value)
  await confirmDialog('确定')
  check('created docs/untitled.md on disk', (await fs.readFile(path.join(SANDBOX, 'docs', 'untitled.md'), 'utf8')) === '')
  check('new file opened in the editor', container.querySelector('.hx-fname')?.textContent === 'untitled.md', container.querySelector('.hx-fname')?.textContent)

  // right-click the new file → rename (change suffix)
  await rightClick(rowNamed('untitled.md'))
  await clickMenu('重命名')
  const renameInput = container.querySelector('.hx-dlg .hx-in')
  check('rename dialog prefills the name', renameInput?.value === 'untitled.md', renameInput?.value)
  await type(renameInput, 'renamed.ts')
  await confirmDialog('确定')
  check('renamed on disk', await fs.stat(path.join(SANDBOX, 'docs', 'renamed.ts')).then(() => true, () => false))
  check('old name is gone', !(await fs.stat(path.join(SANDBOX, 'docs', 'untitled.md')).then(() => true, () => false)))

  // new folder
  await rightClick(rowNamed('docs'))
  await clickMenu('新建文件夹…')
  await type(container.querySelector('.hx-dlg .hx-in'), 'sub')
  await confirmDialog('确定')
  check('created docs/sub', await fs.stat(path.join(SANDBOX, 'docs', 'sub')).then(info => info.isDirectory(), () => false))

  // delete → recycle bin
  await rightClick(rowNamed('renamed.ts'))
  await clickMenu('删除')
  await confirmDialog('移到回收站')
  check('deleted file is gone', !(await fs.stat(path.join(SANDBOX, 'docs', 'renamed.ts')).then(() => true, () => false)))
  const trash = path.join(SANDBOX, 'workspace', 'backup', 'ide-trash')
  const trashed = await fs.readdir(trash).catch(() => [])
  check('deleted file landed in ide-trash', trashed.some(name => name.includes('renamed.ts')), trashed.join(','))

  // picture → preview pane, never the text editor
  await click(rowNamed('pixel.png'))
  await flush(120)
  check('picture opens the preview pane', !!container.querySelector('.hx-img-wrap'), container.querySelector('.hx-main')?.textContent?.slice(0, 80))
  check('picture pane is tagged 图片预览', (container.querySelector('.hx-tag')?.textContent ?? '').includes('图片预览'), container.querySelector('.hx-tag')?.textContent)
  check('picture pane has no text editor', !container.querySelector('.hx-ta'))
  check('picture pane shows the byte size', (container.querySelector('.hx-status')?.textContent ?? '').includes('只读预览'), container.querySelector('.hx-status')?.textContent)
  const imgSrc = container.querySelector('img.hx-img')?.getAttribute('src') ?? ''
  check('picture pane points at the raw route', imgSrc.includes('/api/ide-vscode/raw?path='), imgSrc)

  // archive → member list + unpack
  if (!rowNamed('zipped.zip'))
    await click(rowNamed('docs'))
  await flush(80)
  check('archive row is in the tree', !!rowNamed('zipped.zip'), rows().map(row => row.querySelector('.hx-name')?.textContent).join(','))
  await click(rowNamed('zipped.zip'))
  await flush(150)
  check('archive opens the archive pane', !!container.querySelector('.hx-arch'), container.querySelector('.hx-main')?.textContent?.slice(0, 80))
  check('archive pane lists the member', (container.querySelector('.hx-arch')?.textContent ?? '').includes('inner.txt'), container.querySelector('.hx-arch')?.textContent)
  check('archive pane is tagged with the count', /项/.test(container.querySelector('.hx-tag')?.textContent ?? ''), container.querySelector('.hx-tag')?.textContent)

  const unpackButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent.includes('解压到旁边'))
  check('archive pane has an unpack button', !!unpackButton, Array.from(container.querySelectorAll('button')).map(button => button.textContent).join(' | '))
  if (unpackButton)
    await click(unpackButton)
  await flush(400)
  check('unpacked next to the archive', await fs.stat(path.join(SANDBOX, 'docs', 'zipped', 'inner.txt')).then(() => true, () => false))

  // guide-card open (a tab with no address) mounts fresh and starts empty
  const guideContainer = window.document.createElement('div')
  window.document.body.appendChild(guideContainer)
  const guideRoot = ReactDOMClient.createRoot(guideContainer)
  await act(async () => {
    guideRoot.render(h(Body, { useTabInfo: () => ({ tab: { id: 'tab-guide' } }) }))
  })
  await flush(80)
  check('address-less open shows the empty editor', !!guideContainer.querySelector('.hx-empty'), guideContainer.querySelector('.hx-main')?.textContent?.slice(0, 80))
  await act(async () => { guideRoot.unmount() })
  guideContainer.remove()
}
catch (error) {
  failures.push(`unexpected throw: ${error?.stack ?? error}`)
}
finally {
  try {
    await act(async () => { root.unmount() })
  }
  catch {}
  server.close()
  await fs.rm(SANDBOX, { recursive: true, force: true })
}

console.log(`dom e2e: ${passed} passed, ${failures.length} failed`)
for (const failure of failures)
  console.log(`  FAIL ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
