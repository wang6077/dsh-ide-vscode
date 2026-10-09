/**
 * Offline smoke test for the host half. Exercises every route against a real
 * temporary directory (the system temp dir, or DSH_IDE_ROOT if you set one),
 * then cleans up.
 *
 * Run: node test/host-smoke.mjs
 */
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

// The host half reads its root at import time, so pin it to a throwaway sandbox
// before importing (ESM imports are hoisted — hence the dynamic import).
const SANDBOX = path.resolve(process.env.DSH_IDE_ROOT || path.join(os.tmpdir(), 'dsh-ide-vscode-smoke'))
process.env.DSH_IDE_ROOT = SANDBOX
await fs.mkdir(path.join(SANDBOX, 'workspace', 'tmp'), { recursive: true })
await fs.writeFile(path.join(SANDBOX, 'README.md'), '# sandbox\n', 'utf8')
const { routes, apply, iconKeyFor, parseIconDump, systemIcons } = await import('../lib/index.js')

const ROOT = SANDBOX
const WORK = 'workspace/tmp/ide-smoke'

/**
 * Session registry stub. The host half asks it for the requesting session's own working
 * directory; `live-1` is the one session this test claims to know.
 */
const SESSION_CWD = path.join(SANDBOX, 'session-workspace')
const REGISTRY_CWD = path.join(SANDBOX, 'registry-workspace')
const SESSIONS = {
  get: id => (id === 'live-1' ? { header: { cwd: SESSION_CWD } } : undefined),
}

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition)
    passed += 1
  else
    failures.push(`${label}${detail === undefined ? '' : ` → ${detail}`}`)
}

function fakeRequest({ method = 'GET', url = '/', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks)
        yield chunk
    },
  }
}

function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers || {}
    },
    end(body) {
      state.body = body || ''
    },
    get status() {
      return state.status
    },
    get json() {
      try {
        return JSON.parse(state.body)
      }
      catch {
        return undefined
      }
    },
    get raw() {
      return state.body
    },
    get headers() {
      return state.headers
    },
  }
}

async function call(routePath, options, table = routes) {
  const route = table.find(item => item.path === routePath)
  if (!route)
    throw new Error(`no route ${routePath}`)
  const response = fakeResponse()
  await route.handler(fakeRequest({ url: routePath + (options?.query ?? ''), ...options }), response)
  return response
}

const api = path => `/api/ide-vscode${path}`
const q = value => `?path=${encodeURIComponent(value)}`

async function exists(abs) {
  return fs.stat(abs).then(() => true, () => false)
}

/** A real, playable 0.2s 440Hz mono WAV — the browser can actually decode this one. */
function makeWav() {
  const rate = 8000
  const samples = Math.floor(rate * 0.2)
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 8000), index * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const created = []

try {
  // 0. route + mount surface
  check('15 routes exported', routes.length === 15, String(routes.length))
  const registered = []
  apply({
    effect(callback, label) {
      registered.push(label)
      callback()
      return () => {}
    },
    inject(_names, callback) {
      callback({ sessions: SESSIONS })
      return () => {}
    },
    webServer: { register: () => () => {} },
  })
  check('apply registers every route', registered.length === routes.length, `${registered.length} of ${routes.length}`)

  // 0b. shell icons: pure helpers first, then the route itself
  check('iconKeyFor keeps the extension', iconKeyFor('notes.TXT') === '.txt', iconKeyFor('notes.TXT'))
  check('iconKeyFor takes the last extension', iconKeyFor('archive.tar.gz') === '.gz', iconKeyFor('archive.tar.gz'))
  check('iconKeyFor rejects an extensionless name', iconKeyFor('README') === '', iconKeyFor('README'))
  check('iconKeyFor rejects a dotfile', iconKeyFor('.gitignore') === '', iconKeyFor('.gitignore'))
  const dumped = parseIconDump(`.txt\t${'A'.repeat(80)}\n.bat\tbroken\n.zip\t${'B'.repeat(64)}`)
  check('parseIconDump reads every usable row', Object.keys(dumped).join(',') === '.txt,.zip', Object.keys(dumped).join(','))
  check('parseIconDump makes a data url', String(dumped['.txt']).startsWith('data:image/png;base64,'), String(dumped['.txt']).slice(0, 30))
  check('parseIconDump drops short payloads', parseIconDump('nothing here') && Object.keys(parseIconDump('nothing here')).length === 0, JSON.stringify(parseIconDump('nothing here')))
  // The Windows-only guard: off Windows the extractor must not even be reached, so we
  // assert on the empty answer *and* that it arrives without a PowerShell round trip (a
  // real run takes well over a second, whether or not this host is Windows itself).
  const offWindows = await systemIcons(['.txt', '.zip'], 'darwin')
  check('systemIcons is empty off Windows', Object.keys(offWindows).length === 0, JSON.stringify(offWindows))
  const onLinux = await systemIcons(['.txt'], 'linux')
  check('systemIcons is empty on Linux', Object.keys(onLinux).length === 0, JSON.stringify(onLinux))
  const guardStart = Date.now()
  await systemIcons(['.txt', '.zip'], 'darwin')
  const guardMs = Date.now() - guardStart
  check('systemIcons never spawns off Windows', guardMs < 500, `${guardMs}ms`)
  let iconResponse = await call(api('/icons'))
  check('GET /icons without extensions 200', iconResponse.status === 200, String(iconResponse.status))
  check('GET /icons without extensions is empty', JSON.stringify(iconResponse.json?.icons) === '{}', JSON.stringify(iconResponse.json?.icons))
  iconResponse = await call(api('/icons'), { query: '?ext=%2Etxt%2Cgarbage' })
  if (process.platform === 'win32') {
    const url = iconResponse.json?.icons?.['.txt']
    check('GET /icons .txt is a png data url', typeof url === 'string' && url.startsWith('data:image/png;base64,'), String(url).slice(0, 30))
    check('GET /icons ignores a bogus extension', iconResponse.json?.icons?.garbage === undefined, String(iconResponse.json?.icons?.garbage))
  }
  else {
    check('GET /icons is empty off Windows', JSON.stringify(iconResponse.json?.icons) === '{}', JSON.stringify(iconResponse.json?.icons))
  }
  // The same guard on the production path: pretend this host is macOS and ask the route
  // for an extension that has never been cached, so only the platform check can stop it
  // (if the guard were missing, the extractor would run and hand back a generic icon).
  const realPlatform = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const asMac = await call(api('/icons'), { query: '?ext=%2Enomacmarker' })
    check('GET /icons reports its platform', asMac.json?.platform === 'darwin', String(asMac.json?.platform))
    check('GET /icons stays empty when the host is not Windows', JSON.stringify(asMac.json?.icons) === '{}', JSON.stringify(asMac.json?.icons))
  }
  finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  }
  check('the platform stub is undone', process.platform === realPlatform, process.platform)

  // 1. root
  let response = await call(api('/root'))
  check('GET /root 200', response.status === 200, String(response.status))
  check('root is the workspace', response.json?.root === ROOT, String(response.json?.root))

  // 2. listing
  response = await call(api('/list'), { query: q('') })
  const names = (response.json?.entries || []).map(entry => entry.name)
  check('list root 200', response.status === 200, String(response.status))
  check('list hides node_modules', !names.includes('node_modules'), JSON.stringify(names.slice(0, 12)))
  check('list finds README.md', names.includes('README.md'), JSON.stringify(names.slice(0, 12)))
  check('list marks directories', (response.json?.entries || []).some(entry => entry.dir))

  // 3. read
  response = await call(api('/read'), { query: q('README.md') })
  check('read README.md 200', response.status === 200, String(response.status))
  check('read returns text', typeof response.json?.content === 'string' && response.json.content.length > 0)

  response = await call(api('/read'), { query: q('does-not-exist.txt') })
  check('read missing → 404', response.status === 404, String(response.status))

  response = await call(api('/read'), { query: q('workspace') })
  check('read a directory → 400', response.status === 400, String(response.status))

  response = await call(api('/list'), { query: q('README.md') })
  check('list a file → 400', response.status === 400, String(response.status))

  // 4. confinement
  response = await call(api('/list'), { query: q('../..') })
  check('list ../.. → 403', response.status === 403, String(response.status))

  response = await call(api('/read'), { query: q('C:\\Windows\\win.ini') })
  check('read absolute outside → 403', response.status === 403, String(response.status))

  response = await call(api('/read'), { query: q('memory/../README.md') })
  check('read path with .. that stays inside → 200', response.status === 200, String(response.status))

  response = await call(api('/read'), { query: q('/README.md') })
  check('read with leading slash → 200', response.status === 200, String(response.status))

  // 5. create folder + file
  await fs.rm(path.join(ROOT, WORK), { recursive: true, force: true })
  response = await call(api('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: 'workspace/tmp', name: 'ide-smoke', folder: true }),
  })
  check('create folder 200', response.status === 200, `${response.status} ${response.json?.error ?? ''}`)
  check('folder exists', await exists(path.join(ROOT, WORK)))

  response = await call(api('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: WORK, name: 'hello.txt', content: '' }),
  })
  check('create file 200', response.status === 200, `${response.status} ${response.json?.error ?? ''}`)
  created.push(path.join(ROOT, WORK, 'hello.txt'))

  response = await call(api('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: WORK, name: 'hello.txt', content: '' }),
  })
  check('duplicate create → 409', response.status === 409, String(response.status))

  response = await call(api('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: WORK, name: 'bad/name.txt' }),
  })
  check('name with slash → 400', response.status === 400, String(response.status))

  response = await call(api('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: WORK, name: 'con.txt' }),
  })
  check('windows reserved name → 400', response.status === 400, String(response.status))

  response = await call(api('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: '..', name: 'escape.txt' }),
  })
  check('create outside → 403', response.status === 403, String(response.status))

  // 6. write + read back
  response = await call(api('/write'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/hello.txt`, content: '你好 hello\nline2\n' }),
  })
  check('write 200', response.status === 200, `${response.status} ${response.json?.error ?? ''}`)

  response = await call(api('/read'), { query: q(`${WORK}/hello.txt`) })
  check('read back content', response.json?.content === '你好 hello\nline2\n', JSON.stringify(response.json?.content))

  response = await call(api('/write'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/never-created.txt`, content: 'x' }),
  })
  check('write missing without create → 404', response.status === 404, String(response.status))

  response = await call(api('/write'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  check('bad JSON body → 400', response.status === 400, String(response.status))

  response = await call(api('/write'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'workspace/node_modules/x.txt', content: 'x' }),
  })
  check('write inside node_modules → 403', response.status === 403, String(response.status))

  // 7. binary / unsupported extension
  await fs.writeFile(path.join(ROOT, WORK, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
  created.push(path.join(ROOT, WORK, 'blob.bin'))
  response = await call(api('/read'), { query: q(`${WORK}/blob.bin`) })
  check('read .bin → 415', response.status === 415, String(response.status))

  // 8. rename
  response = await call(api('/rename'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/hello.txt`, name: 'hello2.md' }),
  })
  check('rename 200', response.status === 200, `${response.status} ${response.json?.error ?? ''}`)
  check('renamed target exists', await exists(path.join(ROOT, WORK, 'hello2.md')))
  check('old name gone', !(await exists(path.join(ROOT, WORK, 'hello.txt'))))
  created.push(path.join(ROOT, WORK, 'hello2.md'))

  response = await call(api('/rename'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/hello2.md`, name: 'blob.bin' }),
  })
  check('rename onto existing → 409', response.status === 409, String(response.status))

  response = await call(api('/rename'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '', name: 'nope' }),
  })
  check('rename root → 403', response.status === 403, String(response.status))

  // 9. delete → trash
  response = await call(api('/delete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/hello2.md` }),
  })
  check('delete 200', response.status === 200, `${response.status} ${response.json?.error ?? ''}`)
  check('delete reports trash path', typeof response.json?.trash === 'string' && !path.isAbsolute(response.json.trash) && response.json.trash.includes('trash'), String(response.json?.trash))
  check('deleted file gone', !(await exists(path.join(ROOT, WORK, 'hello2.md'))))
  check('trash lives inside the workspace root', typeof response.json?.trash === 'string' && path.resolve(ROOT, response.json.trash).startsWith(ROOT + path.sep), String(response.json?.trash))
  const rootListing = await call(api('/list'), { query: q('') })
  check('trash is hidden from the tree', !(rootListing.json?.entries ?? []).some(entry => entry.name === '.dsh-ide-vscode'), JSON.stringify((rootListing.json?.entries ?? []).map(entry => entry.name)))
  if (response.json?.trash)
    created.push(path.join(ROOT, response.json.trash.replace(/\//g, path.sep)))

  response = await call(api('/delete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '' }),
  })
  check('delete root → 403', response.status === 403, String(response.status))

  response = await call(api('/delete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'node_modules' }),
  })
  check('delete node_modules → 403', response.status === 403, String(response.status))

  response = await call(api('/delete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/blob.bin`, purge: true }),
  })
  check('purge 200', response.status === 200 && response.json?.purged === true, String(response.status))
  check('purged file gone', !(await exists(path.join(ROOT, WORK, 'blob.bin'))))

  // 10. pictures: stat + raw bytes (a picture must never go through /read)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
  await fs.writeFile(path.join(ROOT, WORK, 'pixel.png'), png)
  response = await call(api('/stat'), { query: q(`${WORK}/pixel.png`) })
  check('stat picture 200', response.status === 200, String(response.status))
  check('stat reports image kind', response.json?.kind === 'image', String(response.json?.kind))
  check('stat reports byte size', response.json?.size === png.length, String(response.json?.size))

  response = await call(api('/raw'), { query: q(`${WORK}/pixel.png`) })
  check('raw picture 200', response.status === 200, String(response.status))
  check('raw content-type image/png', response.headers['content-type'] === 'image/png', String(response.headers['content-type']))
  check('raw content-length matches', response.headers['content-length'] === png.length, String(response.headers['content-length']))
  check('raw returns the bytes', Buffer.isBuffer(response.raw) && response.raw.equals(png), String(response.raw?.length))
  check('raw is no-store', response.headers['cache-control'] === 'no-store', String(response.headers['cache-control']))

  response = await call(api('/read'), { query: q(`${WORK}/pixel.png`) })
  check('read a picture → 415', response.status === 415, String(response.status))

  response = await call(api('/raw'), { query: q('../escape.png') })
  check('raw .. outside → 403', response.status === 403, String(response.status))

  // 11. archives: zip a folder, list it, unpack it, refuse the gates
  await fs.mkdir(path.join(ROOT, WORK, 'zipme'), { recursive: true })
  await fs.writeFile(path.join(ROOT, WORK, 'zipme', 'inner.txt'), 'inner\n', 'utf8')
  response = await call(api('/compress'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/zipme`, name: 'pack.zip' }),
  })
  check('compress a folder 200', response.status === 200, `${response.status} ${response.json?.error ?? ''}`)
  check('compress wrote the zip', await exists(path.join(ROOT, WORK, 'pack.zip')))
  check('compress reports a size', (response.json?.size || 0) > 0, String(response.json?.size))

  response = await call(api('/compress'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/zipme`, name: 'pack.zip' }),
  })
  check('compress onto existing → 409', response.status === 409, String(response.status))

  response = await call(api('/archive'), { query: q(`${WORK}/pack.zip`) })
  check('archive listing 200', response.status === 200, `${response.status} ${response.json?.error ?? ''}`)
  check('archive lists the member', (response.json?.entries || []).some(entry => String(entry.name).includes('inner.txt')), JSON.stringify((response.json?.entries || []).map(entry => entry.name)))

  response = await call(api('/extract'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/pack.zip` }),
  })
  check('extract 200', response.status === 200, `${response.status} ${response.json?.error ?? ''}`)
  const unpacked = response.json?.dest ? path.join(ROOT, response.json.dest.replace(/\//g, path.sep)) : ''
  check('extract defaults to a sibling folder', unpacked.endsWith(`${path.sep}pack`), String(response.json?.dest))
  check('extract wrote the member', unpacked !== '' && await exists(path.join(unpacked, 'zipme', 'inner.txt')))

  response = await call(api('/archive'), { query: q(`${WORK}/zipme`) })
  check('archive on a folder → 400', response.status === 400, String(response.status))

  response = await call(api('/extract'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/pixel.png` }),
  })
  check('extract a picture → 415', response.status === 415, String(response.status))

  response = await call(api('/compress'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${WORK}/zipme`, name: 'bad.tar' }),
  })
  check('compress to non-zip name → 400', response.status === 400, String(response.status))

  response = await call(api('/compress'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'node_modules' }),
  })
  check('compress node_modules → 403', response.status === 403, String(response.status))

  // 10. audio + video + tar + search
  const wav = makeWav()
  await fs.writeFile(path.join(ROOT, WORK, 'sound.wav'), wav)
  await fs.writeFile(path.join(ROOT, WORK, 'clip.mp4'), Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex'))

  response = await call(api('/stat'), { query: q(`${WORK}/sound.wav`) })
  check('stat says audio', response.json?.kind === 'audio', String(response.json?.kind))
  response = await call(api('/raw'), { query: q(`${WORK}/sound.wav`) })
  check('raw content-type audio/wav', response.headers['content-type'] === 'audio/wav', String(response.headers['content-type']))
  check('raw advertises byte ranges', response.headers['accept-ranges'] === 'bytes', String(response.headers['accept-ranges']))
  check('raw sends the whole wav', Buffer.isBuffer(response.raw) && response.raw.equals(wav), String(response.raw?.length))

  response = await call(api('/raw'), { query: q(`${WORK}/sound.wav`), headers: { range: 'bytes=0-3' } })
  check('range request → 206', response.status === 206, String(response.status))
  check('range content-range header', response.headers['content-range'] === `bytes 0-3/${wav.length}`, String(response.headers['content-range']))
  check('range sends just the slice', Buffer.isBuffer(response.raw) && response.raw.length === 4 && response.raw.equals(wav.subarray(0, 4)), String(response.raw?.length))

  response = await call(api('/raw'), { query: q(`${WORK}/sound.wav`), headers: { range: `bytes=${wav.length + 32}-` } })
  check('unsatisfiable range → 416', response.status === 416, String(response.status))
  check('416 tells the total size', response.headers['content-range'] === `bytes */${wav.length}`, String(response.headers['content-range']))

  response = await call(api('/stat'), { query: q(`${WORK}/clip.mp4`) })
  check('stat says video', response.json?.kind === 'video', String(response.json?.kind))
  response = await call(api('/raw'), { query: q(`${WORK}/clip.mp4`) })
  check('raw content-type video/mp4', response.headers['content-type'] === 'video/mp4', String(response.headers['content-type']))

  // a plain .tar (not just .zip) has to be listed too
  const tarPath = path.join(ROOT, WORK, 'plain.tar')
  try {
    execFileSync('tar', ['-cf', tarPath, '-C', path.join(ROOT, WORK, 'zipme'), 'inner.txt'], { stdio: 'ignore', windowsHide: true })
  }
  catch {
    // no system tar: the assertion below will fail loudly
  }
  response = await call(api('/archive'), { query: q(`${WORK}/plain.tar`) })
  check('tar members listed', response.status === 200 && JSON.stringify(response.json?.entries ?? []).includes('inner.txt'), `${response.status} ${JSON.stringify(response.json?.entries ?? [])}`)

  response = await call(api('/search'), { query: '?q=inner' })
  check('search finds by name', response.status === 200 && (response.json?.results ?? []).some(hit => hit.name === 'inner.txt'), JSON.stringify(response.json?.results?.slice(0, 3) ?? []))
  check('search hits carry path + dir', (response.json?.results ?? []).every(hit => typeof hit.path === 'string' && typeof hit.dir === 'boolean'))
  response = await call(api('/search'), { query: `?q=${encodeURIComponent('sound')}` })
  check('search finds the wav', (response.json?.results ?? []).some(hit => hit.path === `${WORK}/sound.wav`), JSON.stringify(response.json?.results?.slice(0, 3) ?? []))
  response = await call(api('/search'), { query: '?q=' })
  check('empty search → 400', response.status === 400, String(response.status))
  response = await call(api('/search'), { query: `?q=${encodeURIComponent('nothing-with-this-name')}` })
  check('search miss → empty list', response.status === 200 && response.json?.count === 0, JSON.stringify(response.json))

  // 11. gates
  response = await call(api('/write'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', host: '127.0.0.1:19387' },
    body: JSON.stringify({ path: `${WORK}/hello.txt`, content: 'x' }),
  })
  check('cross-origin write → 403', response.status === 403, String(response.status))

  response = await call(api('/write'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' },
    body: JSON.stringify({ path: `${WORK}/same-origin.txt`, content: 'ok', create: true }),
  })
  check('same-origin write → 200', response.status === 200, String(response.status))
  created.push(path.join(ROOT, WORK, 'same-origin.txt'))

  response = await call(api('/read'), { query: q('README.md'), remoteAddress: '192.168.1.9' })
  check('non-loopback → 403', response.status === 403, String(response.status))

  response = await call(api('/log'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'smoke test' }),
  })
  check('log 200', response.status === 200, String(response.status))

  // 13. root resolution when the environment override is absent: the requesting session's
  // own workspace wins, then DSH's persisted default workspace, then the process cwd.
  // A second module instance is needed because ENV_ROOT is captured at import time.
  await fs.mkdir(SESSION_CWD, { recursive: true })
  await fs.mkdir(REGISTRY_CWD, { recursive: true })
  const profile = path.join(SANDBOX, 'fake-profile')
  await fs.mkdir(path.join(profile, '.dsh', 'storages'), { recursive: true })
  await fs.writeFile(
    path.join(profile, '.dsh', 'storages', 'workspace.json'),
    JSON.stringify({
      global: { defaultWorkspaceId: 'ws-1', workspaceIds: ['ws-1'] },
      tables: { workspaces: { 'ws-1': { path: REGISTRY_CWD, title: 'sandbox' } } },
    }),
    'utf8',
  )

  const savedEnv = {
    DSH_IDE_ROOT: process.env.DSH_IDE_ROOT,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  }
  const restoreEnv = (name, value) => {
    if (value === undefined)
      delete process.env[name]
    else
      process.env[name] = value
  }
  let fallback
  try {
    delete process.env.DSH_IDE_ROOT
    process.env.USERPROFILE = profile
    process.env.HOME = profile
    fallback = await import(`../lib/index.js?no-env-root=${Date.now()}`)
  }
  finally {
    restoreEnv('DSH_IDE_ROOT', savedEnv.DSH_IDE_ROOT)
    restoreEnv('USERPROFILE', savedEnv.USERPROFILE)
    restoreEnv('HOME', savedEnv.HOME)
  }

  const fallbackRoutes = fallback.routes
  check('fallback instance still exports 15 routes', fallbackRoutes.length === 15, String(fallbackRoutes.length))
  if (fallbackRoutes.length === 14) {
    const mounted = []
    fallback.apply({
      effect(callback, label) {
        mounted.push(label)
        callback()
        return () => {}
      },
      inject(_names, callback) {
        callback({ sessions: SESSIONS })
        return () => {}
      },
      webServer: { register: () => () => {} },
    })
    check('fallback instance mounts every route', mounted.length === fallbackRoutes.length)

    response = await call(api('/root'), { headers: { 'x-dsh-session': 'live-1' } }, fallbackRoutes)
    check('session header picks the session workspace', response.json?.root === SESSION_CWD, String(response.json?.root))

    response = await call(api('/root'), { query: '?session=live-1' }, fallbackRoutes)
    check('?session= picks the session workspace', response.json?.root === SESSION_CWD, String(response.json?.root))

    response = await call(api('/root'), {}, fallbackRoutes)
    check('no session → persisted default workspace', response.json?.root === REGISTRY_CWD, String(response.json?.root))

    response = await call(api('/root'), { headers: { 'x-dsh-session': 'nobody' } }, fallbackRoutes)
    check('unknown session → persisted default workspace', response.json?.root === REGISTRY_CWD, String(response.json?.root))

    response = await call(api('/list'), { query: q(''), headers: { 'x-dsh-session': 'live-1' } }, fallbackRoutes)
    check('listing follows the session workspace', response.status === 200, String(response.status))

    response = await call(api('/read'), { query: q('../README.md'), headers: { 'x-dsh-session': 'live-1' } }, fallbackRoutes)
    check('escape attempt still refused', response.status >= 400, String(response.status))
  }
}
catch (error) {
  failures.push(`unexpected throw: ${error?.stack ?? error}`)
}
finally {
  await fs.rm(path.join(ROOT, WORK), { recursive: true, force: true })
  await fs.rm(path.join(ROOT, 'fake-profile'), { recursive: true, force: true })
  await fs.rm(SESSION_CWD, { recursive: true, force: true })
  await fs.rm(REGISTRY_CWD, { recursive: true, force: true })
  for (const item of created) {
    await fs.rm(item, { force: true, recursive: true }).catch(() => {})
  }
}

console.log(`host smoke: ${passed} passed, ${failures.length} failed`)
for (const failure of failures)
  console.log(`  FAIL ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
