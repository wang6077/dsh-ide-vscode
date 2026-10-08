/**
 * dsh-ide-vscode — host half.
 *
 * Serves the filesystem API the IDE panel needs. The desktop profile's own
 * `workspaceFiles` service is read-only, so editing needs routes of its own.
 *
 * Boundaries:
 *  - every path is relative to ROOT and must resolve inside it;
 *  - loopback + Origin gate on every route (see `rejectReason`);
 *  - delete moves the target into the trash instead of unlinking it, unless
 *    the caller passes `purge: true`.
 */
import { promises as fs, readFileSync, openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-ide-vscode'
export const inject = ['webServer']

/** Package directory (`lib/..`) — where `dev.log` and the local config live. */
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Optional local config next to the package: `{"root": "...", "trash": "..."}`. */
function localConfig() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(PKG_DIR, 'ide-root.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    return {}
  }
}

const LOCAL = localConfig()

/**
 * Workspace root. `DSH_IDE_ROOT` wins, then `root` in `ide-root.json`, then the
 * directory the host process was started in.
 */
const ROOT = path.resolve(process.env.DSH_IDE_ROOT || LOCAL.root || process.cwd())

/** Trash directory: `DSH_IDE_TRASH` / `trash` (relative to ROOT) / default below ROOT. */
const TRASH_DIR = process.env.DSH_IDE_TRASH
  ? path.resolve(process.env.DSH_IDE_TRASH)
  : LOCAL.trash
    ? path.resolve(ROOT, LOCAL.trash)
    : path.join(ROOT, '.dsh-ide-vscode', 'trash')

const LOG_FILE = path.join(PKG_DIR, 'dev.log')

const API = '/api/ide-vscode'
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 8 * 1024 * 1024
const MAX_LIST_ENTRIES = 5000

const SKIP_NAMES = new Set(['node_modules', '.git', '.pnpm-store', 'System Volume Information', '$RECYCLE.BIN'])

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

const MAX_RAW_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 1000
const TAR_TIMEOUT_MS = 5 * 60 * 1000

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

/** Resolve a client path inside ROOT, or `undefined` when it escapes. */
function resolveInRoot(value) {
  const raw = String(value ?? '')
  // Absolute paths are refused outright instead of being silently re-rooted.
  if (/^[a-zA-Z]:/.test(raw) || /^\\\\/.test(raw))
    return undefined
  const rel = normalizeRel(raw)
  const abs = path.resolve(ROOT, rel)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep))
    return undefined
  return abs
}

function toRel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/')
}

/** True when any path segment is on the skip list (mutations are refused there). */
function inSkippedTree(abs) {
  return toRel(abs).split('/').some(segment => SKIP_NAMES.has(segment))
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

/** What the panel should do with a file: edit it, show it, or unpack it. */
function kindOf(file) {
  if (isImageFile(file))
    return 'image'
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
async function moveToTrash(abs) {
  await fs.mkdir(TRASH_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const base = path.basename(abs)
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`
    const target = path.join(TRASH_DIR, `${stamp}-${base}${suffix}`)
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

async function handleRoot(request, response) {
  send(response, 200, { root: ROOT, api: API, trash: toRel(TRASH_DIR) })
}

async function handleList(request, response) {
  try {
    const rel = paramsOf(request).get('path') ?? ''
    const abs = resolveInRoot(rel)
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
        rel: toRel(full),
      })
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    send(response, 200, { root: ROOT, path: toRel(abs), entries })
  }
  catch (error) {
    appendLog(`list failed: ${error?.message ?? error}`)
    send(response, 500, { error: String(error?.message ?? error) })
  }
}

async function handleRead(request, response) {
  try {
    const rel = paramsOf(request).get('path') ?? ''
    const abs = resolveInRoot(rel)
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
    send(response, 200, { path: toRel(abs), name: path.basename(abs), content, size: info.size, mtimeMs: info.mtimeMs })
  }
  catch (error) {
    appendLog(`read failed: ${error?.message ?? error}`)
    send(response, 500, { error: String(error?.message ?? error) })
  }
}

async function handleWrite(request, response) {
  try {
    const payload = await jsonBody(request, MAX_WRITE_BYTES)
    const abs = resolveInRoot(payload.path)
    if (!abs)
      return send(response, 403, { error: '路径越出工作区' })
    if (abs === ROOT || inSkippedTree(abs))
      return send(response, 403, { error: '这个位置不允许写入' })
    const content = String(payload.content ?? '')
    const existed = await fs.stat(abs).then(() => true, () => false)
    if (!existed && payload.create !== true)
      return send(response, 404, { error: '文件不存在' })
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
    const info = await fs.stat(abs)
    appendLog(`write ok ${toRel(abs)} ${info.size} bytes`)
    send(response, 200, { ok: true, path: toRel(abs), size: info.size, mtimeMs: info.mtimeMs })
  }
  catch (error) {
    appendLog(`write failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

async function handleCreate(request, response) {
  try {
    const payload = await jsonBody(request)
    const parentAbs = resolveInRoot(payload.dir)
    if (!parentAbs)
      return send(response, 403, { error: '路径越出工作区' })
    if (inSkippedTree(parentAbs))
      return send(response, 403, { error: '这个位置不允许新建' })
    const bad = nameError(payload.name)
    if (bad)
      return send(response, 400, { error: bad })
    const target = path.join(parentAbs, String(payload.name))
    if (target !== ROOT && !target.startsWith(ROOT + path.sep))
      return send(response, 403, { error: '路径越出工作区' })
    if (payload.folder === true) {
      await fs.mkdir(target)
      appendLog(`mkdir ok ${toRel(target)}`)
      return send(response, 200, { ok: true, path: toRel(target), dir: true })
    }
    await fs.mkdir(parentAbs, { recursive: true })
    await fs.writeFile(target, String(payload.content ?? ''), { encoding: 'utf8', flag: 'wx' })
    appendLog(`create ok ${toRel(target)}`)
    send(response, 200, { ok: true, path: toRel(target), dir: false, text: isTextFile(target) })
  }
  catch (error) {
    const code = error?.code === 'EEXIST' ? 409 : 400
    appendLog(`create failed: ${error?.message ?? error}`)
    send(response, code, { error: error?.code === 'EEXIST' ? '同名文件或文件夹已存在' : String(error?.message ?? error) })
  }
}

async function handleRename(request, response) {
  try {
    const payload = await jsonBody(request)
    const abs = resolveInRoot(payload.path)
    if (!abs || abs === ROOT)
      return send(response, 403, { error: '不能改名这个位置' })
    if (inSkippedTree(abs))
      return send(response, 403, { error: '这个位置不允许改名' })
    const bad = nameError(payload.name)
    if (bad)
      return send(response, 400, { error: bad })
    const target = path.join(path.dirname(abs), String(payload.name))
    if (!target.startsWith(ROOT + path.sep))
      return send(response, 403, { error: '路径越出工作区' })
    if (await fs.stat(abs).then(() => false, () => true))
      return send(response, 404, { error: '目标不存在' })
    if (await fs.stat(target).then(() => true, () => false))
      return send(response, 409, { error: '同名文件或文件夹已存在' })
    await fs.rename(abs, target)
    appendLog(`rename ok ${toRel(abs)} -> ${toRel(target)}`)
    send(response, 200, { ok: true, from: toRel(abs), path: toRel(target) })
  }
  catch (error) {
    appendLog(`rename failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

async function handleDelete(request, response) {
  try {
    const payload = await jsonBody(request)
    const abs = resolveInRoot(payload.path)
    if (!abs || abs === ROOT)
      return send(response, 403, { error: '不能删除工作区根目录' })
    if (inSkippedTree(abs))
      return send(response, 403, { error: '这个位置不允许删除' })
    const info = await fs.stat(abs).catch(() => undefined)
    if (!info)
      return send(response, 404, { error: '目标不存在' })
    if (payload.purge === true) {
      await fs.rm(abs, { recursive: true, force: false })
      appendLog(`purge ok ${toRel(abs)}`)
      return send(response, 200, { ok: true, purged: true, path: toRel(abs) })
    }
    const trash = await moveToTrash(abs)
    appendLog(`trash ok ${toRel(abs)} -> ${trash}`)
    send(response, 200, { ok: true, purged: false, path: toRel(abs), trash: toRel(trash) })
  }
  catch (error) {
    appendLog(`delete failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

/** `stat` with the same boundary rules as `read`; returns `{abs, info}` or `{code}`. */
async function statInRoot(rel) {
  const abs = resolveInRoot(rel)
  if (!abs)
    return { code: 403, message: '路径越出工作区' }
  const info = await fs.stat(abs).catch(() => undefined)
  if (!info)
    return { code: 404, message: '文件不存在' }
  return { abs, info }
}

async function handleStat(request, response) {
  try {
    const found = await statInRoot(paramsOf(request).get('path') ?? '')
    if (found.code)
      return send(response, found.code, { error: found.message })
    send(response, 200, {
      path: toRel(found.abs),
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

/** Raw bytes — used by the picture preview (`<img src>`). */
async function handleRaw(request, response) {
  try {
    const found = await statInRoot(paramsOf(request).get('path') ?? '')
    if (found.code)
      return send(response, found.code, { error: found.message })
    if (found.info.isDirectory())
      return send(response, 400, { error: '目标不是文件' })
    if (found.info.size > MAX_RAW_BYTES)
      return send(response, 413, { error: `文件超过 ${Math.round(MAX_RAW_BYTES / 1024 / 1024)} MB，不预览` })
    const data = await fs.readFile(found.abs)
    response.writeHead(200, {
      'content-type': IMAGE_MIME.get(extOf(found.abs)) ?? (isTextFile(found.abs) ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
      'content-length': data.length,
      'cache-control': 'no-store',
      'content-disposition': 'inline',
    })
    response.end(data)
  }
  catch (error) {
    appendLog(`raw failed: ${error?.message ?? error}`)
    send(response, 500, { error: String(error?.message ?? error) })
  }
}

/** List an archive's members (names only) so the panel can show what is inside. */
async function handleArchive(request, response) {
  try {
    const found = await statInRoot(paramsOf(request).get('path') ?? '')
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
      path: toRel(found.abs),
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
async function handleExtract(request, response) {
  try {
    const payload = await jsonBody(request)
    const abs = resolveInRoot(payload.path)
    if (!abs || abs === ROOT)
      return send(response, 403, { error: '不能解压这个位置' })
    if (inSkippedTree(abs))
      return send(response, 403, { error: '这个位置不允许解压' })
    const info = await fs.stat(abs).catch(() => undefined)
    if (!info || info.isDirectory())
      return send(response, 404, { error: '压缩包不存在' })
    if (!isArchiveFile(abs))
      return send(response, 415, { error: '这个后缀不是压缩包' })
    let dest
    if (typeof payload.dest === 'string' && payload.dest !== '') {
      const wanted = resolveInRoot(payload.dest)
      if (!wanted)
        return send(response, 403, { error: '路径越出工作区' })
      if (inSkippedTree(wanted))
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
    appendLog(`extract ok ${toRel(abs)} -> ${toRel(dest)}`)
    send(response, 200, { ok: true, path: toRel(abs), dest: toRel(dest) })
  }
  catch (error) {
    appendLog(`extract failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

/** Zip a file or folder next to itself (`<name>.zip`). */
async function handleCompress(request, response) {
  try {
    const payload = await jsonBody(request)
    const abs = resolveInRoot(payload.path)
    if (!abs || abs === ROOT)
      return send(response, 403, { error: '不能打包工作区根目录' })
    if (inSkippedTree(abs))
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
    if (!target.startsWith(ROOT + path.sep))
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
    appendLog(`zip ok ${toRel(abs)} -> ${toRel(target)} ${out.size} bytes`)
    send(response, 200, { ok: true, path: toRel(target), size: out.size })
  }
  catch (error) {
    appendLog(`zip failed: ${error?.message ?? error}`)
    send(response, 400, { error: String(error?.message ?? error) })
  }
}

async function handleLog(request, response) {
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
    return handler(request, response)
  }
}

export const routes = [
  { kind: 'exact', path: `${API}/root`, handler: guarded(handleRoot) },
  { kind: 'exact', path: `${API}/list`, handler: guarded(handleList) },
  { kind: 'exact', path: `${API}/read`, handler: guarded(handleRead) },
  { kind: 'exact', path: `${API}/stat`, handler: guarded(handleStat) },
  { kind: 'exact', path: `${API}/raw`, handler: guarded(handleRaw) },
  { kind: 'exact', path: `${API}/archive`, handler: guarded(handleArchive) },
  { kind: 'exact', path: `${API}/extract`, handler: guarded(handleExtract) },
  { kind: 'exact', path: `${API}/compress`, handler: guarded(handleCompress) },
  { kind: 'exact', path: `${API}/write`, handler: guarded(handleWrite) },
  { kind: 'exact', path: `${API}/create`, handler: guarded(handleCreate) },
  { kind: 'exact', path: `${API}/rename`, handler: guarded(handleRename) },
  { kind: 'exact', path: `${API}/delete`, handler: guarded(handleDelete) },
  { kind: 'exact', path: `${API}/log`, handler: guarded(handleLog) },
]

export function apply(ctx) {
  for (const route of routes)
    ctx.effect(() => ctx.webServer.register(route), `dsh-ide-vscode: ${route.path}`)
  appendLog(`host half mounted root=${ROOT}`)
}
