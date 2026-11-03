/**
 * @dsh-external/dsh-pet-notepad — host 半区。
 *
 * 职责：记事本内容的唯一权威，落盘到 `$DSH_HOME/pet-notepad/notepad.json`，
 * 通过同源 HTTP 路由对浏览器开放读写。浏览器半区只是视图，刷新/重开/换标签页
 * 数据都还在。
 *
 * 为什么是独立插件而不是改 dsh-pet 源码：dsh-pet 是 profile 的版本依赖
 * （`"@linxin666/dsh-pet": "0.4.2"`），一升级整目录被覆盖。本插件一行都不碰
 * pet，也不 import 它，只依赖 pet 在 DOM 上暴露的 `[data-dsh-pet-root]` 标记
 * （见 client 半区），因此 pet 更新后照常可用。
 *
 * host 半区与 pet 完全无关：它只是一块纯文本的权威存储 + 两个同源路由。
 *
 * 数据模型：单块纯文本。没有卡片、没有标签、没有定时——粘贴即存。
 * @module @dsh-external/dsh-pet-notepad
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 插件 id（与 cordis.patch.yml / package.json 保持一致）。 */
export const name = '@dsh-external/dsh-pet-notepad'

/** 需要的宿主服务：只有 webServer。 */
export const inject = ['webServer']

/** 浏览器侧 API 前缀。 */
const API_PREFIX = '/pet-notepad/api'

/** 文档 schema 版本。 */
const SCHEMA_VERSION = 1

/** 正文上限（字符）。够贴长文，但拦住意外灌入的巨型 payload。 */
const MAX_TEXT = 200_000

/** POST body 上限（字节）。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 数据目录名（`$DSH_HOME/<DIR_NAME>/`）。 */
const DIR_NAME = 'pet-notepad'

/** 数据文件名。 */
const FILE_NAME = 'notepad.json'

/** DSH 主目录：`$DSH_HOME` 优先，缺省 `~/.dsh`。 */
function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return join(homedir(), '.dsh')
}

/** 记事本文件绝对路径。 */
function notepadPath() {
  return join(dshHome(), DIR_NAME, FILE_NAME)
}

/** 空文档。 */
function emptyDoc() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, text: '', updatedAt: 0 }
}

/**
 * 把损坏的文件改名留档，绝不覆盖原字节。
 * @returns {{ doc: object, warning: string }}
 */
function quarantine(file, reason) {
  const target = `${file}.corrupt-${Date.now()}`
  try {
    renameSync(file, target)
    return {
      doc: emptyDoc(),
      warning: `${reason}，原文件已留档为 ${target}，本次以空记事本启动`,
    }
  } catch (error) {
    return {
      doc: emptyDoc(),
      warning: `${reason}，且留档失败（${String(error)}）——为避免覆盖，本次只在内存里用空记事本，未写盘`,
    }
  }
}

/**
 * 读文档。不存在 → 空文档；损坏 / 未知 schema → 改名留档 + 空文档 + warning。
 * @returns {{ doc: object, warning?: string }}
 */
function loadDoc() {
  const file = notepadPath()
  if (!existsSync(file)) return { doc: emptyDoc() }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { doc: emptyDoc(), warning: `记事本读取失败，已以空记事本启动：${String(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return quarantine(file, '记事本不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return quarantine(file, '记事本顶层不是对象')
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return quarantine(file, `未知 schemaVersion=${String(parsed.schemaVersion)}`)
  }
  const doc = emptyDoc()
  doc.revision = Number.isFinite(parsed.revision) ? Math.max(0, Math.trunc(parsed.revision)) : 0
  doc.text = typeof parsed.text === 'string' ? parsed.text.slice(0, MAX_TEXT) : ''
  doc.updatedAt = Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
  return { doc }
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
function saveDoc(doc) {
  const file = notepadPath()
  mkdirSync(join(dshHome(), DIR_NAME), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/** 对外 state。 */
function publicState(doc, warning) {
  return {
    schemaVersion: doc.schemaVersion,
    revision: doc.revision,
    text: doc.text,
    updatedAt: doc.updatedAt,
    maxText: MAX_TEXT,
    storagePath: notepadPath(),
    ...(warning === undefined ? {} : { warning }),
  }
}

/** 写 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

/**
 * 只接受回环 host 的请求（防 DNS rebinding 把本机 API 暴露给外部页面）。
 * `Host` 可能是 `127.0.0.1:3080` / `localhost:3080` / `[::1]:3080`。
 */
function loopbackHostOk(req) {
  const host = String(req.headers.host ?? '')
  if (host === '') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1'
}

/** 同源校验：有 Origin 时必须与 Host 一致（无 Origin 的同源请求放行）。 */
function sameOriginOk(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === String(req.headers.host ?? '')
  } catch {
    return false
  }
}

/** 有界读 body。超限抛错。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body 过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param {any} ctx cordis 上下文（须已 inject webServer）
 */
export function apply(ctx) {
  const loaded = loadDoc()
  let doc = loaded.doc
  let warning = loaded.warning

  async function handleState(res) {
    sendJson(res, 200, { ok: true, state: publicState(doc, warning) })
  }

  async function handleSet(req, res) {
    if (!sameOriginOk(req)) {
      sendJson(res, 403, { ok: false, error: '仅接受同源浏览器请求' })
      return
    }
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.includes('application/json')) {
      sendJson(res, 400, { ok: false, error: 'content-type 必须是 application/json' })
      return
    }
    let text
    try {
      text = await readBody(req)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: String(error) })
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `body 解析失败: ${String(error)}` })
      return
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'body 必须是对象' })
      return
    }
    if (typeof body.text !== 'string') {
      sendJson(res, 400, { ok: false, error: 'text 必须是字符串' })
      return
    }
    if (body.text.length > MAX_TEXT) {
      sendJson(res, 413, { ok: false, error: `正文超过上限 ${MAX_TEXT} 字符` })
      return
    }
    // 乐观并发：带上 baseRevision 时，若服务端已前进（另一个标签页写过），
    // 返回 409 + 当前状态，让前端决定是覆盖还是先看服务端的版本。
    const base = body.baseRevision
    if (typeof base === 'number' && Number.isFinite(base) && Math.trunc(base) !== doc.revision) {
      sendJson(res, 409, { ok: false, error: 'revision 冲突', state: publicState(doc, warning) })
      return
    }
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: doc.revision + 1,
      text: body.text,
      updatedAt: Date.now(),
    }
    try {
      saveDoc(next)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `记事本写入失败，变更未生效: ${String(error)}` })
      return
    }
    doc = next
    warning = undefined
    sendJson(res, 200, { ok: true, state: publicState(doc) })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
          const pathname = url.pathname.replace(/\/+$/, '')
          try {
            if (!loopbackHostOk(req)) {
              sendJson(res, 403, { ok: false, error: '仅接受本机请求' })
              return
            }
            if (req.method === 'GET' && (pathname === `${API_PREFIX}/state` || pathname === API_PREFIX)) {
              await handleState(res)
              return
            }
            if (req.method === 'POST' && pathname === `${API_PREFIX}/set`) {
              await handleSet(req, res)
              return
            }
            sendJson(res, 404, { ok: false, error: `未找到 ${req.method} ${pathname}` })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) })
          }
        },
      }),
    'pet-notepad: host API',
  )
}
