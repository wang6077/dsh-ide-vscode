/**
 * Offline smoke test for the host half. Exercises every route against a real
 * temporary directory (the system temp dir, or DSH_IDE_ROOT if you set one),
 * then cleans up.
 *
 * Run: node test/host-smoke.mjs
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The host half reads its root at import time, so pin it to a throwaway sandbox
// before importing (ESM imports are hoisted — hence the dynamic import).
const SANDBOX = path.resolve(process.env.DSH_IDE_ROOT || path.join(os.tmpdir(), 'dsh-ide-vscode-smoke'))
process.env.DSH_IDE_ROOT = SANDBOX
await fs.mkdir(path.join(SANDBOX, 'workspace', 'tmp'), { recursive: true })
await fs.writeFile(path.join(SANDBOX, 'README.md'), '# sandbox\n', 'utf8')
const { routes, apply } = await import('../lib/index.js')

const ROOT = SANDBOX
const WORK = 'workspace/tmp/ide-smoke'

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
  }
}

async function call(routePath, options) {
  const route = routes.find(item => item.path === routePath)
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

const created = []

try {
  // 0. route + mount surface
  check('8 routes exported', routes.length === 8, String(routes.length))
  const registered = []
  apply({
    effect(callback, label) {
      registered.push(label)
      callback()
      return () => {}
    },
    webServer: { register: () => () => {} },
  })
  check('apply registers every route', registered.length === 8, registered.join(', '))

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
  check('delete reports trash path', typeof response.json?.trash === 'string' && response.json.trash.includes('ide-trash'), String(response.json?.trash))
  check('deleted file gone', !(await exists(path.join(ROOT, WORK, 'hello2.md'))))
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

  // 10. gates
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
}
catch (error) {
  failures.push(`unexpected throw: ${error?.stack ?? error}`)
}
finally {
  await fs.rm(path.join(ROOT, WORK), { recursive: true, force: true })
  for (const item of created) {
    await fs.rm(item, { force: true, recursive: true }).catch(() => {})
  }
}

console.log(`host smoke: ${passed} passed, ${failures.length} failed`)
for (const failure of failures)
  console.log(`  FAIL ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
