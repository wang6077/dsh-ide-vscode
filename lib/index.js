/**
 * dsh-ide-vscode — host half.
 *
 * Serves the filesystem API the IDE panel needs. The desktop profile's own
 * `workspaceFiles` service is read-only, so editing needs routes of its own.
 *
 * Boundaries:
 *  - every path is relative to that request's workspace root and must resolve inside it;
 *  - loopback + Origin gate on every route (see `rejectReason`);
 *  - delete moves the target into the trash instead of unlinking it, unless
 *    the caller passes `purge: true`.
 */
import { promises as fs, readFileSync, statSync, openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-ide-vscode'
export const inject = ['webServer']

/** Package directory (`lib/..`) — where `dev.log` and the local config live. */
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Candidate locations for the optional local config `{"root": "...", "trash": "..."}`.
 * A `file:`-installed copy is a plain copy, and `ide-root.json` is gitignored, so it
 * never travels with the package — the profile copy (`<.dsh>/profiles/<name>/ide-root.json`)
 * keeps the instance working after a reinstall or a profile wipe.
 */
const LOCAL_CONFIG_PATHS = [
  path.join(PKG_DIR, 'ide-root.json'),
  path.join(PKG_DIR, '..', '..', 'ide-root.json'),
]

/** Optional local config: first readable candidate wins. */
function localConfig() {
  for (const candidate of LOCAL_CONFIG_PATHS) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    }
    catch {
      // try the next candidate
    }
  }
  return {}
}

const LOCAL = localConfig()

/**
 * Explicit override from the environment. It wins over every root the host could
 * discover, which is also what the offline smoke test pins.
 */
const ENV_ROOT = process.env.DSH_IDE_ROOT ? path.resolve(process.env.DSH_IDE_ROOT) : undefined

/** Host context captured by `apply`, so a route can resolve its session's workspace. */
let host

/** The host's live `sessions` service, once the profile composes it. */
let liveSessions

/** DSH's persisted workspace registry — the same file the GUI's workspace list comes from. */
const WORKSPACE_STORE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')

/** Cache for `WORKSPACE_STORE`, invalidated by mtime. */
let storeCache = { mtimeMs: -1, root: undefined }

/**
 * The persistent default workspace. A request whose session cannot be resolved (the very
 * first `/root` of a brand-new tab) still lands on the reader's own workspace instead of
 * the profile directory the host process happens to run in.
 *
 * The registry is rewritten by DSH while it runs, so it is re-read whenever its mtime moves.
 */
function storedWorkspaceRoot() {
  let info
  try {
    info = statSync(WORKSPACE_STORE)
  }
  catch {
    return undefined
  }
  if (info.mtimeMs === storeCache.mtimeMs)
    return storeCache.root
  let root
  try {
    const store = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'))
    const table = store?.tables?.workspaces ?? {}
    const pathOf = id => (id && table[id]?.path ? String(table[id].path) : undefined)
    const ordered = Array.isArray(store?.global?.workspaceIds) ? store.global.workspaceIds : Object.keys(table)
    root = pathOf(store?.global?.defaultWorkspaceId)
      ?? ordered.map(pathOf).find(Boolean)
      ?? Object.values(table).map(entry => (entry?.path ? String(entry.path) : undefined)).find(Boolean)
  }
  catch {
    root = undefined
  }
  storeCache = { mtimeMs: info.mtimeMs, root }
  return root
}

/**
 * One session's workspace root: the live session header first, then the persisted header
 * for a session the host has not paged in. `undefined` when the id is unknown.
 */
async function sessionRoot(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '')
    return undefined
  try {
    const cwd = liveSessions?.get?.(sessionId)?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '')
      return cwd
  }
  catch {}
  try {
    const stored = await host?.get?.('sessionPersistence')?.stat?.(sessionId)
    if (typeof stored?.header?.cwd === 'string' && stored.header.cwd !== '')
      return stored.header.cwd
  }
  catch {}
  return undefined
}

/** The session a request speaks for: header first (POST bodies carry no query), then `?session=`. */
function sessionOf(request) {
  const value = request.headers?.['x-dsh-session']
  if (typeof value === 'string' && value !== '')
    return value
  return paramsOf(request).get('session') ?? ''
}

/** True for a path that exists and is a directory. */
function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  }
  catch {
    return false
  }
}

/**
 * Workspace root for one request: the environment override, then the requesting session's
 * own workspace, then `ide-root.json`, then DSH's persisted default workspace, then the
 * directory the host was started in. The first candidate that is an existing directory
 * wins, so a stale entry can never blank the panel.
 */
async function rootOf(request) {
  const discovered = ENV_ROOT
    ? []
    : [await sessionRoot(sessionOf(request)), LOCAL.root, storedWorkspaceRoot()]
  for (const candidate of [ENV_ROOT, ...discovered, process.cwd()]) {
    if (typeof candidate !== 'string' || candidate === '')
      continue
    const abs = path.resolve(candidate)
    if (isDirectory(abs))
      return abs
  }
  return path.resolve(process.cwd())
}

/** Last root written to `dev.log`, so switching workspace shows up in the log. */
let loggedRoot

/**
 * The path boundary of one request: every client path is relative to `root` and has to
 * stay inside it, and deletions land in that workspace's own trash.
 */
function scopeOf(root) {
  const trash = process.env.DSH_IDE_TRASH
    ? path.resolve(process.env.DSH_IDE_TRASH)
    : LOCAL.trash
      ? path.resolve(root, String(LOCAL.trash))
      : path.join(root, '.dsh-ide-vscode', 'trash')
  return {
    root,
    trash,
    /** Resolve a client path inside the root, or `undefined` when it escapes. */
    resolve(value) {
      const raw = String(value ?? '')
      // Absolute paths are refused outright instead of being silently re-rooted.
      if (/^[a-zA-Z]:/.test(raw) || /^\\\\/.test(raw))
        return undefined
      const abs = path.resolve(root, normalizeRel(raw))
      if (abs !== root && !abs.startsWith(root + path.sep))
        return undefined
      return abs
    },
    /** Root-relative spelling every response uses (`/` separated). */
    rel(abs) {
      return path.relative(root, abs).split(path.sep).join('/')
    },
    /** True when any path segment is on the skip list (mutations are refused there). */
    skipped(abs) {
      return path.relative(root, abs).split(path.sep).some(segment => SKIP_NAMES.has(segment))
    },
  }
}

/** The scope for one request, noting a workspace switch in `dev.log`. */
async function scopeFor(request) {
  const scope = scopeOf(await rootOf(request))
  if (scope.root !== loggedRoot) {
    loggedRoot = scope.root
    appendLog(`root -> ${scope.root}`)
  }
  return scope
}

const LOG_FILE = path.join(PKG_DIR, 'dev.log')

const API = '/api/ide-vscode'
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 8 * 1024 * 1024
const MAX_LIST_ENTRIES = 5000

const SKIP_NAMES = new Set(['node_modules', '.git', '.pnpm-store', '.dsh-ide-vscode', 'System Volume Information', '$RECYCLE.BIN'])

const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.jsonc', '.md', '.txt', '.log',
  '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.env', '.properties', '.editorconfig',
  '.css', '.scss', '.less', '.html', '.htm', '.vue', '.svelte', '.xml', '.svg',
  '.py', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.cmd', '.bat', '.vbs', '.lua', '.sql',
  '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.po', '.pot',
  '.gitignore', '.npmrc', '.gitattributes',
])

const BAD_NAME_CHARS = /[\\/:*?"<>|]/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Extensions the panel can render as a picture instead of text. */
const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
])

/** Archive kinds `tar` (bsdtar, shipped with Windows 10+) can list and unpack. */
const ARCHIVE_EXT = ['.zip', '.tar', '.tar.gz', '.tgz', '.gz', '.7z', '.rar']

/** Audio the browser can play in place (`<audio src>`), keyed by extension. */
const AUDIO_MIME = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.flac', 'audio/flac'],
  ['.weba', 'audio/webm'],
  ['.wma', 'audio/x-ms-wma'],
  ['.mid', 'audio/midi'],
])

/** Video the browser can play in place (`<video src>`). `.mkv`/`.avi` only play
 *  when the machine has a codec for them, but the tag itself is still correct. */
const VIDEO_MIME = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
])

const MAX_RAW_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 1000
const TAR_TIMEOUT_MS = 5 * 60 * 1000
const MAX_SEARCH_RESULTS = 60
const MAX_SEARCH_VISITS = 4000

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function appendLog(line) {
  try {
    await fs.appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  }
  catch {}
}

/** Normalize a client path: strips drive/leading separators, maps `/` to `\`. */
function normalizeRel(value) {
  return String(value ?? '')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .filter(part => part !== '' && part !== '.')
    .join(path.sep)
}

function paramsOf(request) {
  return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
}

function isTextFile(file) {
  const ext = path.extname(file).toLowerCase()
  return ext === '' || TEXT_EXT.has(ext)
}

/** Lowercase extension, with `.tar.gz` kept whole. */
function extOf(file) {
  const lower = String(file).toLowerCase()
  if (lower.endsWith('.tar.gz'))
    return '.tar.gz'
  return path.extname(lower)
}

function isImageFile(file) {
  return IMAGE_MIME.has(extOf(file))
}

function isArchiveFile(file) {
  return ARCHIVE_EXT.includes(extOf(file))
}

function isAudioFile(file) {
  return AUDIO_MIME.has(extOf(file))
}

function isVideoFile(file) {
  return VIDEO_MIME.has(extOf(file))
}

/** Content type for `/raw`, so `<img>`, `<audio>` and `<video>` all get it right. */
function mimeOf(file) {
  const ext = extOf(file)
  return IMAGE_MIME.get(ext)
    ?? AUDIO_MIME.get(ext)
    ?? VIDEO_MIME.get(ext)
    ?? (isTextFile(file) ? 'text/plain; charset=utf-8' : 'application/octet-stream')
}

/** What the panel should do with a file: edit it, show it, play it, or unpack it. */
function kindOf(file) {
  if (isImageFile(file))
    return 'image'
  if (isAudioFile(file))
    return 'audio'
  if (isVideoFile(file))
    return 'video'
  if (isArchiveFile(file))
    return 'archive'
  return isTextFile(file) ? 'text' : 'binary'
}

function safeClose(fd) {
  try {
    closeSync(fd)
  }
  catch {}
}

/**
 * Run `tar` (bsdtar) without touching pipes: the sandboxed host cannot always
 * open a pipe, so stdout/stderr are redirected into temp files instead.
 */
async function runTar(args, cwd) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const outFile = path.join(os.tmpdir(), `dsh-ide-tar-${stamp}.out`)
  const errFile = path.join(os.tmpdir(), `dsh-ide-tar-${stamp}.err`)
  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  try {
    const code = await new Promise((resolve) => {
      let child
      try {
        child = spawn('tar', args, { cwd, stdio: ['ignore', outFd, errFd], windowsHide: true })
      }
      catch {
        resolve(-1)
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        }
        catch {}
        resolve(-2)
      }, TAR_TIMEOUT_MS)
      child.on('error', () => {
        clearTimeout(timer)
        resolve(-1)
      })
      child.on('close', (value) => {
        clearTimeout(timer)
        resolve(typeof value === 'number' ? value : -1)
      })
    })
    const stdout = await fs.readFile(outFile, 'utf8').catch(() => '')
    const stderr = await fs.readFile(errFile, 'utf8').catch(() => '')
    return { code, stdout, stderr: stderr.trim() }
  }
  finally {
    safeClose(outFd)
    safeClose(errFd)
    await fs.rm(outFile, { force: true }).catch(() => {})
    await fs.rm(errFile, { force: true }).catch(() => {})
  }
}

function tarError(result) {
  if (result.code === -1)
    return '系统里没有 tar 命令（Windows 10 以上自带 tar.exe）'
  if (result.code === -2)
    return 'tar 执行超时'
  const detail = result.stderr.split('\n').map(line => line.trim()).filter(Boolean).slice(-2).join(' ')
  return (detail || `tar 退出码 ${result.code}`).slice(0, 300)
}

/** `probe.zip` → `probe`; used as the default unpack folder. */
function stemOf(name) {
  return String(name).replace(/\.(tar\.gz|tgz|zip|tar|gz|7z|rar)$/i, '')
}

/** First free path: `dir`, then `dir-2`, `dir-3`… */
async function freePath(target) {
  for (let index = 1; index < 200; index += 1) {
    const candidate = index === 1 ? target : `${target}-${index}`
    if (await fs.stat(candidate).then(() => false, () => true))
      return candidate
  }
  throw new Error('同名目录太多，先清理一下')
}

/** Validate one file or folder name supplied by the client. */
function nameError(name) {
  const value = String(name ?? '')
  if (value === '')
    return '名称不能为空'
  if (value === '.' || value === '..')
    return '名称不能是 . 或 ..'
  if (value.length > 200)
    return '名称过长'
  if (BAD_NAME_CHARS.test(value))
    return '名称不能包含 \\ / : * ? " < > |'
  if (value !== value.trim() || value.endsWith('.'))
    return '名称不能以空格或点结尾'
  if (WINDOWS_RESERVED.test(value))
    return '该名称是 Windows 保留名'
  return undefined
}

async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit)
      throw new Error(`request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function jsonBody(request, limit = 256 * 1024) {
  const raw = await readBody(request, limit)
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** Move a path into the trash folder, returning its new location. */
async function moveToTrash(ws, abs) {
  await fs.mkdir(ws.trash, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const base = path.basename(abs)
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`
    const target = path.join(ws.trash, `${stamp}-${base}${suffix}`)
    try {
      await fs.access(target)
    }
    catch {
      await fs.rename(abs, target)
      return target
    }
  }
  throw new Error('回收站命名冲突')
}

/**
 * File-type icons for the tree. Windows only: the shell itself draws the icon for
 * an extension (`SHGetFileInfo` with `SHGFI_USEFILEATTRIBUTES`), so the panel shows
 * exactly what Explorer shows — Notepad's page for `.txt`, the gear window for
 * `.bat`, the compressed folder for `.zip`, the generic page for anything the system
 * does not associate. Windows only, on purpose: macOS and Linux get `{}` without any
 * PowerShell run or Win32 call — there is no native extractor here, and none is written
 * without a machine to verify one on, so those platforms keep the client's drawn icons.
 */
const ICON_SCRIPT = path.join(PKG_DIR, 'lib', 'win-icons.ps1')
const ICON_TIMEOUT_MS = 30 * 1000
const MAX_ICON_EXTS = 80

/** `".TXT"` → `".txt"`; anything that is not a plain extension → `''`. */
export function extKeyOf(value) {
  const ext = String(value ?? '').trim().toLowerCase()
  return /^\.[a-z0-9][a-z0-9+_-]{0,11}$/.test(ext) ? ext : ''
}

/** `"notes.TXT"` → `".txt"`; anything that is not a plain extension → `''`. */
export function iconKeyFor(name) {
  const base = path.basename(String(name ?? '')).toLowerCase()
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1)
    return ''
  return extKeyOf(base.slice(dot))
}

/** Parse the extractor's `<ext>\t<base64 png>` lines into data URLs. */
export function parseIconDump(text) {
  const icons = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab <= 0)
      continue
    const ext = line.slice(0, tab).trim().toLowerCase()
    const data = line.slice(tab + 1).trim()
    if (iconKeyFor(`x${ext}`) !== ext || data.length < 64)
      continue
    icons[ext] = `data:image/png;base64,${data}`
  }
  return icons
}

/** `ext → data URL`, with `null` for "the shell had nothing for this one". */
const iconCache = new Map()

/** Run the PowerShell extractor with stdio redirected to temp files (no pipes). */
async function extractIcons(exts) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const outFile = path.join(os.tmpdir(), `dsh-ide-icons-${stamp}.out`)
  const errFile = path.join(os.tmpdir(), `dsh-ide-icons-${stamp}.err`)
  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  try {
    const code = await new Promise((resolve) => {
      let child
      try {
        child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', ICON_SCRIPT, '-Exts', exts.join(','),
        ], { stdio: ['ignore', outFd, errFd], windowsHide: true })
      }
      catch {
        resolve(-1)
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        }
        catch {}
      }, ICON_TIMEOUT_MS)
      child.on('error', () => {
        clearTimeout(timer)
        resolve(-1)
      })
      child.on('close', (value) => {
        clearTimeout(timer)
        resolve(value ?? -1)
      })
    })
    if (code !== 0) {
      appendLog(`icons failed: exit ${code}`)
      return {}
    }
    return parseIconDump(readFileSync(outFile, 'utf8'))
  }
  catch (error) {
    appendLog(`icons failed: ${error?.message ?? error}`)
    return {}
  }
  finally {
    safeClose(outFd)
    safeClose(errFd)
    await fs.rm(outFile, { force: true }).catch(() => {})
    await fs.rm(errFile, { force: true }).catch(() => {})
  }
}

/**
 * Cached shell icons for a list of extensions, extracted on first use.
 *
 * Windows only, by design: off Windows this returns `{}` *before* the extractor is even
 * considered, so no PowerShell process is spawned and no Win32-only code runs. There is
 * no macOS/Linux extractor here and none is attempted — without a machine to verify one
 * on it would just be untestable code. The `platform` argument exists so the smoke test
 * can exercise that guard on any host.
 */
export async function systemIcons(exts, platform = process.platform) {
  if (platform !== 'win32')
    return {}
  const wanted = exts.filter(ext => !iconCache.has(ext)).slice(0, MAX_ICON_EXTS)
  if (wanted.length) {
    const found = await extractIcons(wanted)
    for (const ext of wanted)
      iconCache.set(ext, found[ext] ?? null)
  }
  const icons = {}
  for (const ext of exts) {
    const url = iconCache.get(ext)
    if (url)
      icons[ext] = url
  }
  return icons
}

/** The real shell icons for the extensions a listing mentions. */
async function handleIcons(request, response, ws) {
  const raw = paramsOf(request).get('ext') ?? ''
  const exts = [...new Set(raw.split(',').map(extKeyOf).filter(Boolean))].slice(0, MAX_ICON_EXTS)
  if (!exts.length)
    return send(response, 200, { platform: process.platform, icons: {} })
  const icons = await systemIcons(exts)
  send(response, 200, { platform: process.platform, icons })
}

async function handleRoot(request, response, ws) {
  send(response, 200, { root: ws.root, api: API, trash: ws.rel(ws.trash) })
}

async function handleList(request, response, ws) {
  try {
    const rel = paramsOf(request).get('path') ?? ''
    const abs = ws.resolve(rel)
    if (!abs)
      return send(response, 403, { error: '路径越出工作区' })
    const info = await fs.stat(abs).catch(() => undefined)
    if (!info)
      return send(response, 404, { error: '目录不存在' })
    if (!info.isDirectory())
      return send(response, 400, { error: '目标不是目录' })
    const items = await fs.readdir(abs, { withFileTypes: true })
    const entries = []
    for (const item of items.slice(0, MAX_LIST_ENTRIES)) {
      if (SKIP_NAMES.has(item.name))
        continue
      const full = path.join(abs, item.name)
      let size = 0
      let mtimeMs = 0
      try {
        const stat = await fs.stat(full)
        size = stat.isDirectory() ? 0 : stat.size
        mtimeMs = stat.mtimeMs
      }
      catch {}
      entries.push({
        name: item.name,
        dir: item.isDirectory(),
        size,
        mtimeMs,
        text: item.isDirectory() ? false : isTextFile(item.name),
        kind: item.isDirectory() ? 'dir' : kindOf(item.name),
        rel: ws.rel(full),
      })
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    send(response, 200, { root: ws.root, path: ws.rel(abs), entries })
  }
  catch (error) {
    appendLog(`list failed: ${error?.message ?? error}`)
    send(response, 500, { error: String(error?.message ?? error) })
  }
}

async function handleRead(request, response, ws) {
  try {
    const rel = paramsOf(request).get('path') ?? ''
    const abs = ws.resolve(rel)
    if (!abs)
      return send(response, 403, { error: '路径越出工作区' })
    const info = await fs.stat(abs).catch(() => undefined)
    if (!info)
      return send(response, 404, { error: '文件不存在' })
    if (info.isDirectory())
      return send(response, 400, { error: '目标不是文件' })
    if (info.size > MAX_READ_BYTES)
      return send(response, 413, { error: `文件超过 ${Math.round(MAX_READ_BYTES / 1024)} KB，编辑器不打开` })
    if (!isTextFile(abs))
      return send(response, 415, { error: '这个后缀不是文本文件，不能当文本编辑' })
    const content = await fs.readFile(abs, 'utf8')
    send(response, 200, { path: ws.rel(abs), name: path.basename(abs), content, size: info.size, mtimeMs: info.mtimeMs })
  }
  catch (error) {
    appendLog(`read failed: ${error?.message ?? error}`)
    send(response, 500, { error: String(error?.message ?? error) })
  }
}

async function handleWrite(request, response, ws) {
  try {
    const payload = await jsonBody(request, MAX_WRITE_BYTES)
    const abs = ws.resolve(payload.path)
    if (!abs)
      return send(response, 403, { error: '路径越出工作区' })
    if (abs === ws.root || ws.skipped(abs))
      return send(response, 403, { error: '这个位置不允许写入' })
    const content = String(payload.content ?? '')
    const existed = await fs.stat(abs).then(() => true, () => false)
    if (!existed && payload.create !== true)
      return send(response, 404, { error: '文件不存在' })
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    const info = await fs.stat(abs)
    appendLog(`write ok ${ws.rel(abs)} ${info.size} bytes`)
    send(response, 200, { ok: true, path: ws.rel(abs), size: info.size, mtimeMs: info.mtimeMs })
  }
  catch (error) {
    appendLog(`write failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

async function handleCreate(request, response, ws) {
  try {
    const payload = await jsonBody(request)
    const parentAbs = ws.resolve(payload.dir)
    if (!parentAbs)
      return send(response, 403, { error: '路径越出工作区' })
    if (ws.skipped(parentAbs))
      return send(response, 403, { error: '这个位置不允许新建' })
    const bad = nameError(payload.name)
    if (bad)
      return send(response, 400, { error: bad })
    const target = path.join(parentAbs, String(payload.name))
    if (target !== ws.root && !target.startsWith(ws.root + path.sep))
      return send(response, 403, { error: '路径越出工作区' })
    if (payload.folder === true) {
      await fs.mkdir(target)
      appendLog(`mkdir ok ${ws.rel(target)}`)
      return send(response, 200, { ok: true, path: ws.rel(target), dir: true })
    }
    await fs.mkdir(parentAbs, { recursive: true })
    await fs.writeFile(target, String(payload.content ?? ''), { encoding: 'utf8', flag: 'wx' })
    appendLog(`create ok ${ws.rel(target)}`)
    send(response, 200, { ok: true, path: ws.rel(target), dir: false, text: isTextFile(target) })
  }
  catch (error) {
    const code = error?.code === 'EEXIST' ? 409 : 400
    appendLog(`create failed: ${error?.message ?? error}`)
    send(response, code, { error: error?.code === 'EEXIST' ? '同名文件或文件夹已存在' : String(error?.message ?? error) })
  }
}

async function handleRename(request, response, ws) {
  try {
    const payload = await jsonBody(request)
    const abs = ws.resolve(payload.path)
    if (!abs || abs === ws.root)
      return send(response, 403, { error: '不能改名这个位置' })
    if (ws.skipped(abs))
      return send(response, 403, { error: '这个位置不允许改名' })
    const bad = nameError(payload.name)
    if (bad)
      return send(response, 400, { error: bad })
    const target = path.join(path.dirname(abs), String(payload.name))
    if (!target.startsWith(ws.root + path.sep))
      return send(response, 403, { error: '路径越出工作区' })
    if (await fs.stat(abs).then(() => false, () => true))
      return send(response, 404, { error: '目标不存在' })
    if (await fs.stat(target).then(() => true, () => false))
      return send(response, 409, { error: '同名文件或文件夹已存在' })
    await fs.rename(abs, target)
    appendLog(`rename ok ${ws.rel(abs)} -> ${ws.rel(target)}`)
    send(response, 200, { ok: true, from: ws.rel(abs), path: ws.rel(target) })
  }
  catch (error) {
    appendLog(`rename failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

async function handleDelete(request, response, ws) {
  try {
    const payload = await jsonBody(request)
    const abs = ws.resolve(payload.path)
    if (!abs || abs === ws.root)
      return send(response, 403, { error: '不能删除工作区根目录' })
    if (ws.skipped(abs))
      return send(response, 403, { error: '这个位置不允许删除' })
    const info = await fs.stat(abs).catch(() => undefined)
    if (!info)
      return send(response, 404, { error: '目标不存在' })
    if (payload.purge === true) {
      await fs.rm(abs, { recursive: true, force: false })
      appendLog(`purge ok ${ws.rel(abs)}`)
      return send(response, 200, { ok: true, purged: true, path: ws.rel(abs) })
    }
    const trash = await moveToTrash(ws, abs)
    appendLog(`trash ok ${ws.rel(abs)} -> ${trash}`)
    send(response, 200, { ok: true, purged: false, path: ws.rel(abs), trash: ws.rel(trash) })
  }
  catch (error) {
    appendLog(`delete failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

/** `stat` with the same boundary rules as `read`; returns `{abs, info}` or `{code}`. */
async function statInRoot(ws, rel) {
  const abs = ws.resolve(rel)
  if (!abs)
    return { code: 403, message: '路径越出工作区' }
  const info = await fs.stat(abs).catch(() => undefined)
  if (!info)
    return { code: 404, message: '文件不存在' }
  return { abs, info }
}

async function handleStat(request, response, ws) {
  try {
    const found = await statInRoot(ws, paramsOf(request).get('path') ?? '')
    if (found.code)
      return send(response, found.code, { error: found.message })
    send(response, 200, {
      path: ws.rel(found.abs),
      name: path.basename(found.abs),
      dir: found.info.isDirectory(),
      size: found.info.isDirectory() ? 0 : found.info.size,
      mtimeMs: found.info.mtimeMs,
      kind: found.info.isDirectory() ? 'dir' : kindOf(found.abs),
      text: found.info.isDirectory() ? false : isTextFile(found.abs),
    })
  }
  catch (error) {
    appendLog(`stat failed: ${error?.message ?? error}`)
    send(response, 500, { error: String(error?.message ?? error) })
  }
}

/** Raw bytes — used by the picture preview (`<img src>`) and the audio/video players. */
async function handleRaw(request, response, ws) {
  try {
    const found = await statInRoot(ws, paramsOf(request).get('path') ?? '')
    if (found.code)
      return send(response, found.code, { error: found.message })
    if (found.info.isDirectory())
      return send(response, 400, { error: '目标不是文件' })
    const size = found.info.size
    if (size > MAX_RAW_BYTES)
      return send(response, 413, { error: `文件超过 ${Math.round(MAX_RAW_BYTES / 1024 / 1024)} MB，不预览` })
    const headers = {
      'content-type': mimeOf(found.abs),
      'cache-control': 'no-store',
      'content-disposition': 'inline',
      'accept-ranges': 'bytes',
    }
    // `<video>` / `<audio>` seek by asking for byte ranges; everything else gets the whole file.
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers?.range ?? '').trim())
    if (match) {
      const total = size
      const start = match[1] === '' ? Math.max(0, total - Number(match[2] || 0)) : Number(match[1])
      let end = match[1] === '' || match[2] === '' ? total - 1 : Number(match[2])
      if (!Number.isFinite(start) || start < 0 || start >= total || !Number.isFinite(end) || end < start) {
        response.writeHead(416, { 'content-range': `bytes */${total}` })
        return response.end()
      }
      end = Math.min(end, total - 1, start + MAX_RAW_BYTES - 1)
      const length = end - start + 1
      const handle = await fs.open(found.abs, 'r')
      try {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, start)
        response.writeHead(206, {
          ...headers,
          'content-length': length,
          'content-range': `bytes ${start}-${end}/${total}`,
        })
        return response.end(buffer)
      }
      finally {
        await handle.close().catch(() => {})
      }
    }
    const data = await fs.readFile(found.abs)
    response.writeHead(200, { ...headers, 'content-length': data.length })
    response.end(data)
  }
  catch (error) {
    appendLog(`raw failed: ${error?.message ?? error}`)
    send(response, 500, { error: String(error?.message ?? error) })
  }
}

/** Name search under the root — powers the panel's 搜索框. */
async function handleSearch(request, response, ws) {
  try {
    const query = String(paramsOf(request).get('q') ?? '').trim()
    if (!query)
      return send(response, 400, { error: '缺少搜索词' })
    const needle = query.toLowerCase()
    const results = []
    const queue = ['']
    let visited = 0
    let truncated = false
    while (queue.length) {
      const rel = queue.shift()
      let items
      try {
        items = await fs.readdir(path.join(ws.root, rel), { withFileTypes: true })
      }
      catch {
        continue
      }
      for (const item of items) {
        if (SKIP_NAMES.has(item.name))
          continue
        visited += 1
        if (visited > MAX_SEARCH_VISITS) {
          truncated = true
          break
        }
        const child = rel ? `${rel}/${item.name}` : item.name
        const dir = item.isDirectory()
        if (dir)
          queue.push(child)
        if (item.name.toLowerCase().includes(needle)) {
          results.push({ path: child, name: item.name, dir })
          if (results.length >= MAX_SEARCH_RESULTS) {
            truncated = true
            break
          }
        }
      }
      if (truncated)
        break
    }
    return send(response, 200, { query, count: results.length, truncated, results })
  }
  catch (error) {
    appendLog(`search failed: ${error?.message ?? error}`)
    return send(response, 500, { error: String(error?.message ?? error) })
  }
}

/** List an archive's members (names only) so the panel can show what is inside. */
async function handleArchive(request, response, ws) {
  try {
    const found = await statInRoot(ws, paramsOf(request).get('path') ?? '')
    if (found.code)
      return send(response, found.code, { error: found.message })
    if (found.info.isDirectory())
      return send(response, 400, { error: '目标不是压缩包' })
    if (!isArchiveFile(found.abs))
      return send(response, 415, { error: '这个后缀不是压缩包' })
    const result = await runTar(['-tf', found.abs])
    if (result.code !== 0) {
      appendLog(`archive failed: ${result.stderr.slice(0, 200)}`)
      return send(response, 400, { error: tarError(result) })
    }
    const names = result.stdout.split(/\r?\n/).filter(line => line !== '')
    const entries = names.slice(0, MAX_ARCHIVE_ENTRIES).map((name) => ({
      name: name.replace(/\/+$/, ''),
      dir: name.endsWith('/'),
      depth: Math.max(0, name.split('/').filter(Boolean).length - 1),
    }))
    send(response, 200, {
      path: ws.rel(found.abs),
      name: path.basename(found.abs),
      size: found.info.size,
      count: names.length,
      truncated: names.length > MAX_ARCHIVE_ENTRIES,
      entries,
    })
  }
  catch (error) {
    appendLog(`archive failed: ${error?.message ?? error}`)
    send(response, 500, { error: String(error?.message ?? error) })
  }
}

/** Unpack an archive next to itself (or into `dest`). */
async function handleExtract(request, response, ws) {
  try {
    const payload = await jsonBody(request)
    const abs = ws.resolve(payload.path)
    if (!abs || abs === ws.root)
      return send(response, 403, { error: '不能解压这个位置' })
    if (ws.skipped(abs))
      return send(response, 403, { error: '这个位置不允许解压' })
    const info = await fs.stat(abs).catch(() => undefined)
    if (!info || info.isDirectory())
      return send(response, 404, { error: '压缩包不存在' })
    if (!isArchiveFile(abs))
      return send(response, 415, { error: '这个后缀不是压缩包' })
    let dest
    if (typeof payload.dest === 'string' && payload.dest !== '') {
      const wanted = ws.resolve(payload.dest)
      if (!wanted)
        return send(response, 403, { error: '路径越出工作区' })
      if (ws.skipped(wanted))
        return send(response, 403, { error: '这个位置不允许解压' })
      if (await fs.stat(wanted).then(() => true, () => false))
        return send(response, 409, { error: '目标目录已存在' })
      dest = wanted
    }
    else {
      dest = await freePath(path.join(path.dirname(abs), stemOf(path.basename(abs)) || `${path.basename(abs)}-解压`))
    }
    await fs.mkdir(dest, { recursive: true })
    const result = await runTar(['-xf', abs, '-C', dest])
    if (result.code !== 0) {
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
      appendLog(`extract failed: ${result.stderr.slice(0, 200)}`)
      return send(response, 400, { error: tarError(result) })
    }
    appendLog(`extract ok ${ws.rel(abs)} -> ${ws.rel(dest)}`)
    send(response, 200, { ok: true, path: ws.rel(abs), dest: ws.rel(dest) })
  }
  catch (error) {
    appendLog(`extract failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

/** Zip a file or folder next to itself (`<name>.zip`). */
async function handleCompress(request, response, ws) {
  try {
    const payload = await jsonBody(request)
    const abs = ws.resolve(payload.path)
    if (!abs || abs === ws.root)
      return send(response, 403, { error: '不能打包工作区根目录' })
    if (ws.skipped(abs))
      return send(response, 403, { error: '这个位置不允许打包' })
    const info = await fs.stat(abs).catch(() => undefined)
    if (!info)
      return send(response, 404, { error: '目标不存在' })
    const parent = path.dirname(abs)
    const wanted = String(payload.name ?? '') || `${path.basename(abs)}.zip`
    if (!wanted.toLowerCase().endsWith('.zip'))
      return send(response, 400, { error: '打包文件名要以 .zip 结尾' })
    const bad = nameError(wanted)
    if (bad)
      return send(response, 400, { error: bad })
    const target = path.join(parent, wanted)
    if (!target.startsWith(ws.root + path.sep))
      return send(response, 403, { error: '路径越出工作区' })
    const exists = await fs.stat(target).then(() => true, () => false)
    if (exists && payload.overwrite !== true)
      return send(response, 409, { error: '同名压缩包已存在' })
    if (exists)
      await fs.rm(target, { force: true })
    const result = await runTar(['-a', '-cf', target, '-C', parent, path.basename(abs)])
    if (result.code !== 0) {
      appendLog(`zip failed: ${result.stderr.slice(0, 200)}`)
      return send(response, 400, { error: tarError(result) })
    }
    const out = await fs.stat(target)
    appendLog(`zip ok ${ws.rel(abs)} -> ${ws.rel(target)} ${out.size} bytes`)
    send(response, 200, { ok: true, path: ws.rel(target), size: out.size })
  }
  catch (error) {
    appendLog(`zip failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

async function handleLog(request, response, ws) {
  try {
    const payload = await jsonBody(request)
    appendLog(`[client] ${String(payload.message ?? '')}`)
    send(response, 200, { ok: true })
  }
  catch (error) {
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Loopback + Origin gate: blocks CSRF / DNS-rebinding writes from a third-party
 * page running in the same local browser.
 */
export function rejectReason(request) {
  const address = request.socket?.remoteAddress ?? ''
  if (address && !isLoopback(address))
    return 403
  if (!MUTATING.has(String(request.method ?? 'GET').toUpperCase()))
    return undefined
  const origin = request.headers?.origin
  const host = request.headers?.host
  if (origin === undefined || host === undefined)
    return undefined
  try {
    return new URL(origin).host === host ? undefined : 403
  }
  catch {
    return 403
  }
}

function guarded(handler) {
  return async (request, response) => {
    const reason = rejectReason(request)
    if (reason !== undefined)
      return send(response, reason, { error: 'forbidden' })
    return handler(request, response, await scopeFor(request))
  }
}

export const routes = [
  { kind: 'exact', path: `${API}/root`, handler: guarded(handleRoot) },
  { kind: 'exact', path: `${API}/list`, handler: guarded(handleList) },
  { kind: 'exact', path: `${API}/read`, handler: guarded(handleRead) },
  { kind: 'exact', path: `${API}/stat`, handler: guarded(handleStat) },
  { kind: 'exact', path: `${API}/raw`, handler: guarded(handleRaw) },
  { kind: 'exact', path: `${API}/archive`, handler: guarded(handleArchive) },
  { kind: 'exact', path: `${API}/search`, handler: guarded(handleSearch) },
  { kind: 'exact', path: `${API}/extract`, handler: guarded(handleExtract) },
  { kind: 'exact', path: `${API}/compress`, handler: guarded(handleCompress) },
  { kind: 'exact', path: `${API}/write`, handler: guarded(handleWrite) },
  { kind: 'exact', path: `${API}/create`, handler: guarded(handleCreate) },
  { kind: 'exact', path: `${API}/rename`, handler: guarded(handleRename) },
  { kind: 'exact', path: `${API}/delete`, handler: guarded(handleDelete) },
  { kind: 'exact', path: `${API}/log`, handler: guarded(handleLog) },
  { kind: 'exact', path: `${API}/icons`, handler: guarded(handleIcons) },
]

export function apply(ctx) {
  host = ctx
  // The panel follows the session's workspace, so the host's session registry is the
  // lookup that matters. It is optional: without it a request still falls back to
  // `ide-root.json`, the persisted default workspace, then the process directory.
  ctx.inject(['sessions'], (scope) => {
    liveSessions = scope.sessions
    return () => {
      liveSessions = undefined
    }
  })
  for (const route of routes)
    ctx.effect(() => ctx.webServer.register(route), `dsh-ide-vscode: ${route.path}`)
  appendLog(`host half mounted (env root=${ENV_ROOT ?? '(unset)'})`)
}
