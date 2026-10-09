/**
 * Offline smoke test for the client half.
 *
 * Loads client/client.js the same way the DSH web client does
 * (window.__ModuleLoader__.load), runs the factory with stubbed host modules,
 * asserts the two-phase registration, then server-renders the panel body with a
 * real React if one is available next to this repo.
 *
 * Run: node test/client-smoke.mjs
 */
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

// React lives wherever you installed it for testing; defaults to the shared
// temp dir used by the other suites.
const DEP_DIR = process.env.DSH_IDE_TEST_DEPS || path.join(os.tmpdir(), 'ide-test-deps')
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

let React
let renderToStaticMarkup
try {
  const depRequire = createRequire(path.join(DEP_DIR, 'package.json'))
  React = depRequire('react')
  renderToStaticMarkup = depRequire('react-dom/server').renderToStaticMarkup
}
catch (error) {
  console.log(`SKIP render checks: React not installed in ${DEP_DIR} (${error.message.split('\n')[0]})`)
}

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition)
    passed += 1
  else
    failures.push(`${label}${detail === undefined ? '' : ` → ${detail}`}`)
}

/* ---------------------------------------------------------------- stubs --- */

const html = []
globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  setTimeout,
  clearTimeout,
  __ModuleLoader__: { load: spec => { globalThis.__loaded = spec } },
}
globalThis.document = {
  getElementById: id => html.find(node => node.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: node => html.push(node) },
}
globalThis.fetch = async () => { throw new Error('offline test: fetch should not run during render') }

const icon = name => function StubIcon() { return null }
const primitives = {
  GuideArtworkFiles: icon(),
  GuideArtworkBrowser: icon(),
  IconPlusOutlineRegular: icon(),
  IconRefreshOutlineRegular: icon(),
  IconFolderOpenRegular: icon(),
  IconFolderCloseRegular: icon(),
  IconCodeOutlineRegular: icon(),
  IconDeliverDocRegular: icon(),
  IconTrashOutlineRegular: icon(),
  IconEditOutlineRegular: icon(),
  IconWorkspaceTreeOutlineRegular: icon(),
  FileTypeIcon: icon(),
  languageForPath: name => (/\.(js|mjs|cjs|jsx)$/.test(name) ? 'javascript' : 'text'),
  useCodeHighlighter: () => code => String(code).split('\n').map(line => (line ? [{ text: line, style: { color: '#7aa2f7' } }] : [])),
}
const requireStub = spec => {
  if (spec === 'react')
    return React ?? { createElement: (type, props, ...kids) => ({ type, props, kids }), useState: v => [typeof v === 'function' ? v() : v, () => {}], useRef: v => ({ current: v }), useEffect: () => {}, useMemo: f => f(), useCallback: f => f }  /* eslint-disable-line */
  if (spec === '@deepseek-ai/dsh-client-ui-primitives')
    return primitives
  throw new Error(`unexpected require("${spec}")`)
}

/* ----------------------------------------------------------------- load --- */

const source = await fs.readFile(path.join(here, '..', 'client', 'client.js'), 'utf8')
check('client half is a module-loader script', source.includes('__ModuleLoader__') && source.includes('exports.apply'), String(source.length))

new Function('window', 'document', 'fetch', source)(globalThis.window, globalThis.document, globalThis.fetch)
const spec = globalThis.__loaded
check('module loader called once', !!spec, String(spec))
check('module id is the package name', spec?.id === 'dsh-ide-vscode', String(spec?.id))
check('factory is a function', typeof spec?.factory === 'function')

const mod = spec.factory(requireStub)
check('exports.name', mod.name === 'dsh-ide-vscode', String(mod.name))
check('exports.apply is a function', typeof mod.apply === 'function')
check('exports.inject lists the services it uses', Array.isArray(mod.inject) && mod.inject.includes('slots') && mod.inject.includes('sidebarRightTabs') && mod.inject.includes('sidebarRight'), JSON.stringify(mod.inject))

/* ----------------------------------------------------------- apply(ctx) --- */

const definitions = []
const slots = []
const injectedInto = []
const effects = []
const registered = []
const opened = []
const ctxInjections = []
const capturedTarget = { sessionId: 'ses-1', paneId: 'pane-1', host: 'dock', tabId: 'tab-1' }
let captured = capturedTarget
const shortcuts = {
  register(command) {
    registered.push(command)
    return () => {}
  },
}
const ctx = {
  effect(callback, label) {
    effects.push(label)
    return callback()
  },
  inject(names, callback) {
    ctxInjections.push(Array.isArray(names) ? names.join('+') : String(names))
    return callback({
      effect(callback2, label) {
        effects.push(label)
        return callback2()
      },
      shortcuts,
    })
  },
  sidebarRightTabs: {
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
  },
  sidebarRight: {
    commandTarget: () => captured,
    openTabFromTarget(kind, target) {
      opened.push({ kind, target })
    },
  },
  slots: {
    inject(name, factory) {
      injectedInto.push(name)
      return factory()
    },
    register(declaration, component) {
      slots.push({ declaration, component })
      return () => {}
    },
  },
}
mod.apply(ctx)

check('registers exactly one tab type', definitions.length === 1, String(definitions.length))
const definition = definitions[0] ?? {}
check('kind is ide-vscode', definition.kind === 'ide-vscode', String(definition.kind))
check('id is the package name', definition.id === 'dsh-ide-vscode', String(definition.id))
check('priority is extension', definition.priority === 'extension', String(definition.priority))
check('claims code files without shadowing the builtin list', Array.isArray(definition.patterns) && definition.patterns.includes('*.js') && definition.patterns.includes('*.py') && !definition.patterns.includes('*.md'), JSON.stringify(definition.patterns))
check('allows more than one open file', definition.multiple === true, String(definition.multiple))
const entry = definition.guide?.[0] ?? {}
check('has one guide card', Array.isArray(definition.guide) && definition.guide.length === 1, JSON.stringify(definition.guide))
check('guide card carries id and order', entry.id === 'ide' && typeof entry.order === 'number', JSON.stringify({ id: entry.id, order: entry.order }))
check('guide card title/description are locale functions', typeof entry.title === 'function' && typeof entry.description === 'function', `${typeof entry.title}/${typeof entry.description}`)
check('tab chip names the opened file', definition.title?.('dsh-resource://file/session/ses-1/lib/index.js') === 'index.js', String(definition.title?.('dsh-resource://file/session/ses-1/lib/index.js')))
check('tab chip falls back to the panel name', definition.title?.('sidebar://ide-vscode') === '工作区 IDE', String(definition.title?.('sidebar://ide-vscode')))
check('guide card carries the panel command id', entry.commandId === 'dsh-ide-vscode.open', String(entry.commandId))

/* ------------------------------------------------------ global shortcut --- */

const command = registered[0] ?? {}
check('registers one panel shortcut', registered.length === 1 && command.id === 'dsh-ide-vscode.open', JSON.stringify(registered.map(item => item.id)))
check('asks the host for the shortcuts service', ctxInjections.includes('shortcuts'), JSON.stringify(ctxInjections))
check('desktop default is primary+KeyD', command.defaults?.['desktop:windows']?.code === 'KeyD' && command.defaults['desktop:windows'].modifiers.join('+') === 'primary', JSON.stringify(command.defaults?.['desktop:windows']))
check('web default dodges the browser bookmark key', command.defaults?.['web:windows']?.modifiers.join('+') === 'primary+alt', JSON.stringify(command.defaults?.['web:windows']))
check('shortcut still fires while an editor has focus', Array.isArray(command.regions) && command.regions.includes('editable') && command.regions.includes('page'), JSON.stringify(command.regions))
check('shortcut carries a label and search aliases', typeof command.label === 'function' && Array.isArray(command.aliases) && command.label() === '打开工作区 IDE', String(command.label?.()))
const outside = command.resolve?.({ target: null })
if (typeof outside?.run === 'function')
  outside.run()
check('outside the editor the keys open the panel', outside?.status === 'handled' && opened.length === 1 && opened[0].kind === 'ide-vscode' && opened[0].target === capturedTarget, JSON.stringify(opened))
captured = undefined
const noTarget = command.resolve?.({ target: null })
captured = capturedTarget
check('without a panel target the keys are blocked', noTarget?.status === 'blocked' && typeof noTarget.reason === 'string', JSON.stringify(noTarget))
const fakeTa = {}
const fakeEditor = { closest: selector => (selector === '.hx-ta' ? fakeTa : null) }
let duplicated = 0
mod.__internals.editorDuplicate.set(fakeTa, () => { duplicated += 1 })
const insideEditor = command.resolve?.({ target: fakeEditor })
if (typeof insideEditor?.run === 'function')
  insideEditor.run()
check('inside the editor the same keys duplicate the line', insideEditor?.status === 'handled' && duplicated === 1 && opened.length === 1, JSON.stringify({ duplicated, opened: opened.length }))
mod.__internals.editorDuplicate.delete(fakeTa)
check('the editor probe ignores unrelated elements', mod.__internals.duplicateActionFor({ closest: () => null }) === undefined)
check('duplicateLine copies the caret line', JSON.stringify(mod.__internals.duplicateLine('abc', 1, 1)) === JSON.stringify({ text: 'abc\nabc', caret: 5 }), JSON.stringify(mod.__internals.duplicateLine('abc', 1, 1)))
check('duplicateLine keeps a multi-line selection whole', JSON.stringify(mod.__internals.duplicateLine('a\nb\nc', 2, 3)) === JSON.stringify({ text: 'a\nb\nb\nc', caret: 4 }), JSON.stringify(mod.__internals.duplicateLine('a\nb\nc', 2, 3)))
check('duplicateLine leaves an empty file alone', mod.__internals.duplicateLine('', 0, 0) === null, String(mod.__internals.duplicateLine('', 0, 0)))

check('body registered on sidebar.right.pane.tab', slots.length === 1 && slots[0].declaration.name === 'sidebar.right.pane.tab', JSON.stringify(slots.map(entry => entry.declaration.name)))
check('body slot key equals the definition id', slots[0]?.declaration.key === definition.id, String(slots[0]?.declaration.key))
check('body is a component function', typeof slots[0]?.component === 'function')
check('both phases run inside ctx.effect', effects.length >= 2, JSON.stringify(effects))
check('stylesheet injected exactly once', html.filter(node => node.id === 'dsh-ide-vscode-style').length === 1, String(html.length))

/* ------------------------------------------------------- address parsing --- */

const internals = mod.__internals ?? {}
const relFromAddress = internals.relFromAddress ?? (() => '')
check('keeps the scope prefix out of the path', relFromAddress('dsh-resource://file/session/ses-1/lib/index.js') === 'lib/index.js', relFromAddress('dsh-resource://file/session/ses-1/lib/index.js'))
check('decodes escaped characters', relFromAddress('dsh-resource://file/session/ses-1/docs/%E4%B8%AD%E6%96%87.md') === 'docs/中文.md', relFromAddress('dsh-resource://file/session/ses-1/docs/%E4%B8%AD%E6%96%87.md'))
check('drops query and hash', relFromAddress('dsh-resource://file/workspace/w-1/a/b.ts?line=3#x') === 'a/b.ts', relFromAddress('dsh-resource://file/workspace/w-1/a/b.ts?line=3#x'))
check('ignores other addresses', relFromAddress('sidebar://guide') === '' && relFromAddress('') === '' && relFromAddress(undefined) === '')
check('ancestors are outermost first', JSON.stringify(internals.ancestorsOf?.('a/b/c.txt')) === JSON.stringify(['a', 'a/b']), JSON.stringify(internals.ancestorsOf?.('a/b/c.txt')))
check('top-level file has no ancestors', JSON.stringify(internals.ancestorsOf?.('README.md')) === '[]', JSON.stringify(internals.ancestorsOf?.('README.md')))

/* --------------------------------------------------------------- render --- */

if (renderToStaticMarkup) {
  const Body = slots[0].component
  const withTab = renderToStaticMarkup(React.createElement(Body, { useTabInfo: () => ({ tab: { id: 'tab-1' } }) }))
  check('renders the panel shell', withTab.includes('hx-root'), String(withTab.length))
  check('renders the empty editor hint', withTab.includes('左边选一个文件打开'), withTab.slice(0, 200))
  check('renders a busy tree placeholder', withTab.includes('读取中'), withTab.slice(0, 200))
  check('renders the tree header actions', withTab.includes('hx-ico'), withTab.slice(0, 200))

  const withoutTab = renderToStaticMarkup(React.createElement(Body, {}))
  check('renders without the useTabInfo prop', withoutTab.includes('hx-root'), String(withoutTab.length))
}

console.log(`client smoke: ${passed} passed, ${failures.length} failed`)
for (const failure of failures)
  console.log(`  FAIL ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
