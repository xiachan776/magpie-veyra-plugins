/**
 * LobsterAI（有道龙虾）。
 *
 * magpie 里完全没有这家：`internal/provider` 下 grep `lobsterai` / `lobster` /
 * `youdao` 全 0 命中，社区插件仓也没有同名包。它是本插件最干净的一块增量。
 *
 * 协议来源是 Veyra 的 `src/lobsterai*.ts`（真实凭据实测）：
 *
 * | 用途 | 方法与路径 | 额外头 |
 * | --- | --- | --- |
 * | 登录门户 | 浏览器打开 `{portal}/portal#/login?source=electron&redirect_uri=…&state=…` | — |
 * | 换 token | POST `{api}/api/auth/exchange` | 无 `Authorization` |
 * | 续期 | POST `{api}/api/auth/refresh` | 无 `Authorization` |
 * | 模型列表 | GET `{api}/api/models/available` | `X-LobsterAI-Client-*` **必需** |
 * | 对话 | POST `{api}/api/proxy/v1/chat/completions` | `X-LobsterAI-Client-*` |
 * | 积分 | GET `{api}/api/user/profile-summary` | — |
 *
 * 三处与腾讯系**刻意不同**：
 * 1. 不发 `X-Domain` / `X-Product` / `X-IDE-*` —— 这家不认，带上反而可能按错误的
 *    客户端形态归因；
 * 2. 不用轮询式登录，而是本地回调 + `authCode` 换 token；
 * 3. `stream` 恒为 `true` —— 上游只支持 SSE，`stream:false` 直接 500。
 */

import { createServer } from "node:http"
import { randomUUID, createHash } from "node:crypto"

import { NPM, kept, explained, sleep, hex } from "./kit.mjs"

const API_BASE = "https://lobsterai-server.youdao.com"
const PORTAL_BASE = "https://lobsterai.youdao.com"
const VERSION_API = "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update"
const FALLBACK_VERSION = "2026.9.4"
const USER_AGENT = "LobsterAI/0.1.0"
/**
 * 两个 `X-LobsterAI-Client-*` 的取值。
 *
 * `kimi-k3-agentic-v1` 是**模型列表准入**：不带只返 25 个且没有 `kimi-k3`，
 * 带上才 26 个。`thinking-level-control-v1` 是 `reasoning_effort:"off"` 的前提，
 * 不带时服务端直接 500。
 */
const CAPABILITIES = "kimi-k3-agentic-v1,thinking-level-control-v1"

const EXCHANGE_PATH = "/api/auth/exchange"
const REFRESH_PATH = "/api/auth/refresh"
const MODELS_PATH = "/api/models/available"
const CHAT_PATH = "/api/proxy/v1/chat/completions"
const CALLBACK_PATH = "/auth/callback"
const SUMMARY_PATH = "/api/user/profile-summary"
const SLOT_PATH = "/api/client-activities/slot"
const CONTEXT_PATH = "/api/client-activities"

const REQUEST_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const VERSION_TTL_MS = 12 * 60 * 60 * 1000
const EARLY_MS = 60 * 1000
const LEAD_MS = 5 * 60 * 1000

/** `api` 是 magpie 里的上游基址：`/v1` 之前的部分。 */
const api = API_BASE + "/api/proxy/v1"

/**
 * 兜底模型目录（19 个）。
 *
 * 顺序照抄 Veyra 的 `LOBSTERAI_FALLBACK_MODELS` —— 那是从
 * `GET /api/models/available` 实测拉取的返回顺序，重排会让「与上游对比」
 * 这类排查失去可比性。`contextWindow` 全部 131072 是桥接层统一填的值，
 * 不是逐个实测结果，故远端可用时一律以远端为准。
 */
const FALLBACK_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "MiniMax-M3",
  "MiniMax-M2.7",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus-2026-04-20",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
  "doubao-seed-2-1-pro-260628",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-2-0-code-preview-260215",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "glm-5",
].map((id) => [id, id, 131_072, undefined, undefined])

// ---- 客户端版本号 ------------------------------------------------------------

let versionCache = { at: 0, version: FALLBACK_VERSION }

/**
 * 客户端版本号。
 *
 * 它是聊天与模型列表两个请求的必填头，且**会被服务端核对**，故不能写死。
 * 拉不到就用兜底值 —— 一次网络抖动不该让整个 provider 不可用。
 * 正则取自 Veyra 的 `parseClientVersion`：主干点分数字 + 可选预发布后缀。
 */
async function clientVersion() {
  if (Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.version
  try {
    const res = await fetch(VERSION_API, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.ok) {
      const body = await res.json()
      // 更新接口**不走**统一信封：`code`/`msg` 在外层、载荷在 `data.value`。
      const raw = body?.data?.value?.version
      const trimmed = typeof raw === "string" ? raw.trim() : ""
      if (/^(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) {
        versionCache = { at: Date.now(), version: trimmed }
        return trimmed
      }
    }
  } catch {}
  // 刻意不缓存兜底值：缓存会让一次瞬时故障在整个 TTL 内持续生效。
  return FALLBACK_VERSION
}

// ---- 请求头 ------------------------------------------------------------------

/** 四个基础头。这家不认腾讯系归属头，发了反而可能被归因到别的客户端。 */
const authHeaders = (access, accept = "application/json") => ({
  Authorization: "Bearer " + access,
  Accept: accept,
  "Content-Type": "application/json",
  "User-Agent": USER_AGENT,
})

/** 换 token / 续期：此时还没有（或不需要）`Authorization`。 */
const anonymousHeaders = () => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": USER_AGENT,
})

/** 对话与模型列表共用：两个 `X-LobsterAI-Client-*` 头不能省。 */
const clientHeaders = (access, version, accept) => ({
  ...authHeaders(access, accept),
  "X-LobsterAI-Client-Capabilities": CAPABILITIES,
  "X-LobsterAI-Client-Version": version,
})

// ---- 凭据 --------------------------------------------------------------------

/**
 * 凭据是一整个 JSON 对象，而不是一枚 token。
 *
 * magpie 的 oauth 登录态只有 `access` / `refresh` / `expires` 三个约定字段，
 * 故把整份凭据序列化进 `access`（Veyra 也是这么存的），`refresh` 单独放一份
 * 让 magpie 知道这个账号可以静默续期。
 */
const pack = (cred) => JSON.stringify(cred)

function unpack(access) {
  if (typeof access !== "string" || !access.trim()) return null
  try {
    const cred = JSON.parse(access)
    return cred && typeof cred.access_token === "string" && cred.access_token ? cred : null
  } catch {
    return null
  }
}

/**
 * access token 的过期时刻。
 *
 * 三级回退，与 Veyra 的 `lobsteraiCredentialExpiresAtMs` 一致：`expires_at`
 * 纯数字（`>1e12` 当毫秒、否则当秒）→ `Date.parse` → JWT 的 `exp`。
 * 都拿不到时返回 0（「有效期未知」），**不**判定为已过期。
 */
function expiresAtOf(cred) {
  const raw = cred?.expires_at
  if (typeof raw === "string" && raw) {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw)
      return n > 1_000_000_000_000 ? n : n * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  const parts = String(cred?.access_token ?? "").split(".")
  if (parts.length >= 2) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
      if (typeof payload?.exp === "number" && payload.exp > 0) return payload.exp * 1000
    } catch {}
  }
  return 0
}

/**
 * `keyfrom` 身份载荷。
 *
 * 三个字段贯穿 exchange / refresh / models 三个端点。`firstKeyfrom` 与
 * `latestKeyfrom` 都用**凭据里存的原值**，不取当前时刻 —— 上游的参考实现
 * 续期时从不更新 `latestKeyfrom`，自作聪明地更新会让续期失败，而这一点
 * 无法从代码推导，需要实测支撑。
 */
function keyfrom(cred, version) {
  const out = {
    firstKeyfrom: cred?.first_keyfrom ?? "",
    latestKeyfrom: cred?.latest_keyfrom ?? "",
    version,
  }
  // 空串**删键**而不是写空值：上游的 `if x != ""` 语义是「有才带」。
  if (cred?.uuid) out.uuid = cred.uuid
  if (cred?.user_id) out.userId = cred.user_id
  return out
}

/**
 * 从一次签发响应里读出令牌。
 *
 * `expiresIn` 缺失时用 access token 的 JWT `exp` 兜底；基准取**当前时刻**
 * （这家与腾讯系不同，腾讯系用 `iat`）。
 */
function credentialFrom(data, extra) {
  const accessToken = typeof data?.accessToken === "string" ? data.accessToken : ""
  const refreshToken = typeof data?.refreshToken === "string" ? data.refreshToken : ""
  if (!accessToken) return null
  const user = data?.user && typeof data.user === "object" ? data.user : {}
  const expiresIn = typeof data?.expiresIn === "number" ? data.expiresIn : undefined
  const cred = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: "",
    uid: "",
    user_id: "",
    nickname: typeof user.nickname === "string" ? user.nickname : "",
    ...extra,
  }
  cred.expires_at =
    expiresIn !== undefined && expiresIn > 0
      ? String(Date.now() + expiresIn * 1000)
      : String(expiresAtOf(cred) || "")
  // 账号唯一 id 四级回退：`user.id` → `user.userId` → `user.yid` → 哈希前 16 位。
  // 末级哈希兜底保证任何账号都能得到稳定 id —— 空 uid 会让账号池里多条互相覆盖。
  const candidates = [user.id, user.userId, user.yid]
  cred.uid = candidates.find((v) => typeof v === "string" && v) ?? ""
  if (!cred.uid) cred.uid = createHash("sha256").update(accessToken).digest("hex").slice(0, 16)
  cred.user_id = typeof user.userId === "string" && user.userId ? user.userId : (user.yid ?? "")
  return cred
}

// ---- 一次厂商调用 ------------------------------------------------------------

/** 拆 `{code,message,data}` 信封；`code` 非 0 一律当失败。 */
async function call(url, { method = "GET", headers, body, who = "LobsterAI" } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {}
  const code = Number(env?.code)
  if (!res.ok || (code && code !== 0)) {
    const said = String(env?.message ?? env?.msg ?? text.slice(0, 200) ?? "")
    const e = new Error(`${who}: ${said || `HTTP ${res.status}`}${code ? ` (${code})` : ""}`)
    e.code = code || undefined
    e.status = res.status
    throw e
  }
  return env?.data
}

// ---- 登录 --------------------------------------------------------------------

/** 登录 URL：`source=electron` 声明桌面客户端，`redirect_uri` 必须是回环地址。 */
const loginUrl = (port, state) => {
  const q = new URLSearchParams({
    source: "electron",
    redirect_uri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    state,
  })
  // hash 段不能走 `URL.searchParams`（那是 query），故显式拼装。
  return `${PORTAL_BASE}/portal#/login?${q.toString()}`
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    // 只绑回环：回调只可能来自本机浏览器，没有理由对外暴露监听面。
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      if (!port) return reject(new Error("LobsterAI could not get a callback port"))
      resolve(port)
    })
  })
}

/**
 * 浏览器登录：起本地回调服务器 → 用户授权 → 拿 `code` → 当场换 token。
 *
 * 与腾讯系的轮询式登录不同，这里回调与换 token 在同一个 Promise 里闭环，
 * 不落任何临时文件（上游参考实现靠跨进程状态文件，那是它最脆弱的一环）。
 */
async function browserSignIn() {
  const version = await clientVersion()
  const state = randomUUID()
  const firstKeyfrom = String(Date.now())
  const uuid = randomUUID()

  let settle
  const done = new Promise((resolve) => (settle = resolve))
  // 回调可能在「Promise 建好」与「被 await」之间就落定；先挂空处理器避免
  // 进程把它记成未处理拒绝。
  done.catch(() => {})

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort}`)
    if (!url.pathname.startsWith(CALLBACK_PATH)) {
      response.writeHead(404).end("Not found")
      return
    }
    const code = url.searchParams.get("code")
    // `state` 不匹配说明这次回调不是本流程发起的（或为伪造），直接拒绝并在
    // 浏览器里给出明确反馈，而不是静默忽略。
    if (!code || url.searchParams.get("state") !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad callback")
      return
    }
    const body = {
      authCode: code,
      firstKeyfrom,
      latestKeyfrom: String(Date.now()),
      uuid,
      version,
    }
    void call(`${API_BASE}${EXCHANGE_PATH}`, { method: "POST", headers: anonymousHeaders(), body })
      .then((data) => {
        const cred = credentialFrom(data, { uuid, first_keyfrom: firstKeyfrom, latest_keyfrom: body.latestKeyfrom })
        if (!cred) throw new Error("LobsterAI gave no access token")
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end("<html><body><h2>Signed in. You can close this window.</h2></body></html>")
        settle({
          type: "success",
          access: pack(cred),
          refresh: cred.refresh_token,
          expires: expiresAtOf(cred),
          accountId: cred.nickname || cred.user_id || cred.uid,
          ...(cred.nickname ? { nickname: cred.nickname } : {}),
        })
      })
      .catch((error) => {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("LobsterAI exchange failed")
        settle({ type: "failed", error: error?.message ?? String(error) })
      })
  })

  const port = await listen(server)
  const close = () => new Promise((resolve) => server.close(() => resolve()))
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ type: "failed", error: "LobsterAI sign-in timed out" }), LOGIN_TIMEOUT_MS).unref?.()
  })

  return {
    url: loginUrl(port, state),
    instructions: "Sign in to LobsterAI in the browser that opened, then come back here.",
    method: "auto",
    async callback() {
      try {
        return await Promise.race([done, timeout])
      } finally {
        await close()
      }
    },
  }
}

// ---- 续期 --------------------------------------------------------------------

/**
 * 续期。
 *
 * 服务端只认请求体里的 `refreshToken`（不带 `Authorization`），且**可能不回**
 * 新的 refresh token —— 那种情况必须沿用旧值，覆盖成空串会让下一次续期必失败。
 */
async function renewal(a) {
  const cred = unpack(a?.access)
  if (!cred) {
    const e = new Error("LobsterAI isn't signed in; sign in again")
    e.signIn = "expired"
    throw e
  }
  if (!cred.refresh_token) {
    const e = new Error("LobsterAI gave no refresh token; sign in again")
    e.signIn = "expired"
    throw e
  }
  const version = await clientVersion()
  let data
  try {
    data = await call(`${API_BASE}${REFRESH_PATH}`, {
      method: "POST",
      headers: anonymousHeaders(),
      body: { ...keyfrom(cred, version), refreshToken: cred.refresh_token },
    })
  } catch (e) {
    // 401/403 是终态（refresh token 已作废）；其余（网络、5xx）可重试。
    // 把可重试错误也当终态，会让一次抖动废掉整个账号。
    e.signIn = e.status === 401 || e.status === 403 ? "expired" : "kept"
    throw e
  }
  const next = credentialFrom(data ?? {}, {
    uuid: cred.uuid,
    first_keyfrom: cred.first_keyfrom,
    // 刻意不更新：上游参考实现续期时原样回发登录时的那一刻。
    latest_keyfrom: cred.latest_keyfrom,
    uid: cred.uid,
    user_id: cred.user_id,
    nickname: cred.nickname,
  })
  if (!next) throw new Error("LobsterAI gave no token to renew with")
  if (!next.refresh_token) next.refresh_token = cred.refresh_token
  return {
    access: pack(next),
    refresh: next.refresh_token,
    expires: expiresAtOf(next),
  }
}

const merged = (a, next) => ({
  ...a,
  access: next.access ?? a.access,
  refresh: next.refresh ?? a.refresh,
  expires: next.expires ?? a.expires,
})

const stale = (a) => !!a?.expires && Date.now() >= a.expires - EARLY_MS

/** 同一份 refresh token 只花一次；并发触发的后来者拿先到者的结果。 */
function renewer() {
  const running = new Map()
  const done = new Map()
  return async (a, persist) => {
    const key = a.refresh
    const hit = done.get(key)
    if (hit && Date.now() - hit.at < 60_000) return merged(a, hit.next)
    let p = running.get(key)
    if (!p) {
      p = (async () => {
        const next = await renewal(a)
        done.set(key, { next, at: Date.now() })
        await persist?.(next)
        return next
      })().finally(() => running.delete(key))
      running.set(key, p)
    }
    return merged(a, await p)
  }
}

// ---- 模型 --------------------------------------------------------------------

/**
 * 一条远端模型 → 本插件的模型形状。
 *
 * 可选字段缺失一律留 `undefined`，**绝不填 false 之类的假值**：
 * 「远端说不支持图片」与「远端没说」是两回事，前者可据此拒绝图片输入，
 * 后者只能保守按不支持处理 —— 填 false 会让将来新增的视觉模型被静默误判。
 */
function parsed(record) {
  const id = typeof record?.modelId === "string" ? record.modelId.trim() : ""
  if (!id) return null
  const name = typeof record?.modelName === "string" && record.modelName ? record.modelName : id
  const out = { id, name }
  if (typeof record?.contextWindow === "number" && record.contextWindow > 0) out.context = record.contextWindow
  if (typeof record?.maxTokens === "number" && record.maxTokens > 0) out.output = record.maxTokens
  if (typeof record?.supportsImage === "boolean") out.images = record.supportsImage
  if (typeof record?.costMultiplier === "number" && record.costMultiplier > 0) {
    out.rate = record.costMultiplier
  }
  const cfg = thinkingOf(record?.thinkingConfig)
  if (cfg) {
    out.efforts = cfg.options.map((o) => o.level)
    out.wire = Object.fromEntries(cfg.options.map((o) => [o.level, o.openclawLevel]))
    out.defaultEffort = cfg.defaultLevel
  }
  return out
}

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
/** wire 侧**没有 `max`**：远端把 `level:"max"` 映射到 `openclawLevel:"xhigh"`。 */
const WIRE_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])

/**
 * 思考档位。
 *
 * `level` 是产品侧档位名（UI 展示、`defaultLevel` 引用它），`openclawLevel`
 * 才是发给服务端的 `reasoning_effort` 取值。直接发 `max` 与不带参数无差异，
 * 发 `xhigh` 才真正触发最高档 —— 故 `variants` 的键用 `level`、值用 wire。
 *
 * 结构不合规时整块丢弃而不是解析出半截：`defaultLevel` 落不进 `options` 时
 * 让 DSH 去请求一个不存在的档位，比不声明更糟。
 */
function thinkingOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value.options
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const options = []
  const seenLevel = new Set()
  const seenWire = new Set()
  for (const item of raw) {
    if (!item || typeof item !== "object") return undefined
    const level = typeof item.level === "string" ? item.level : ""
    const wire = typeof item.openclawLevel === "string" ? item.openclawLevel : ""
    if (!LEVELS.has(level) || !WIRE_LEVELS.has(wire)) return undefined
    if (seenLevel.has(level) || seenWire.has(wire)) return undefined
    if ((level === "off") !== (wire === "off")) return undefined
    seenLevel.add(level)
    seenWire.add(wire)
    options.push({ level, openclawLevel: wire })
  }
  // 只有 `off` 一档等于没有可选档位。
  if (options.length === 1 && options[0].level === "off") return undefined
  const defaultLevel = typeof value.defaultLevel === "string" ? value.defaultLevel : ""
  if (!seenLevel.has(defaultLevel)) return undefined
  return { options, defaultLevel }
}

/**
 * 远端模型清单。
 *
 * 响应有**两种**形状，都必须认（真实服务端两种都出现过）：`data` 直接是数组，
 * 或 `data.data` 是数组。只认一种会让整个列表恒为空、再静默退回兜底表，
 * 症状是「上游已上线的新模型在面板里看不到」且不报任何错。
 */
async function liveModels(cred) {
  const version = await clientVersion()
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(keyfrom(cred, version))) {
    if (typeof v === "string" && v) query.set(k, v)
  }
  const url = `${API_BASE}${MODELS_PATH}?${query.toString()}`
  const res = await fetch(url, {
    headers: clientHeaders(cred.access_token, version, "application/json"),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || Number(body?.code) !== 0) return []
  const list = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.data?.data)
      ? body.data.data
      : []
  const out = []
  for (const item of list) {
    const m = parsed(item)
    if (m) out.push(m)
  }
  return out
}

/** `provider.models()` 的完整条目。 */
function modelEntry(m) {
  const variants = m.efforts?.length
    ? Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: m.wire?.[e] ?? e }]))
    : undefined
  const images = m.images === true
  return {
    id: m.id,
    providerID: PROVIDER,
    name: m.name,
    api: { id: m.id, url: api, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: !!variants,
      attachment: images,
      toolcall: true,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    ...(variants ? { variants } : {}),
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    free: false,
    rate: m.rate ?? 0,
    rateWas: 0,
  }
}

// ---- 用量与签到 --------------------------------------------------------------

const num = (v) => {
  if (v === null || v === undefined || v === "") return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

/**
 * 积分余额。
 *
 * 端点必须用 `profile-summary` 而不是 `quota`：后者只给 `freeCreditsTotal=300`，
 * **不含活动积分**（实测同一账号 profile-summary 有 5297.72、quota 只有 300）。
 */
async function usageOf(cred) {
  const data = await call(`${API_BASE}${SUMMARY_PATH}`, { headers: authHeaders(cred.access_token) })
  const items = Array.isArray(data?.creditItems) ? data.creditItems : []
  let remaining = 0
  let total = 0
  let soonest = 0
  const now = Date.now()
  const free = []
  for (const item of items) {
    const left = num(item?.creditsRemaining)
    const expires = typeof item?.expiresAt === "string" && item.expiresAt ? item.expiresAt : ""
    const at = expires ? Date.parse(expires.replace(" ", "T")) : Number.NaN
    const alive = !(Number.isFinite(at) && now >= at)
    if (!alive) continue
    remaining += left
    // 这里只下发剩余量、不给周期总额。用 remaining 当 total 会让「剩余/总额」
    // 显示成 1:1，故如实置 0，UI 对 0 会显示 `?` 而不是误导。
    if (Number.isFinite(at) && (soonest === 0 || at < soonest)) soonest = at
    const label = typeof item?.label === "string" ? item.label : ""
    const type = typeof item?.type === "string" ? item.type : ""
    if (label || type) free.push(label || type)
  }
  void total
  if (!items.length) return { windows: [] }
  return {
    plan: "LobsterAI",
    windows: [
      {
        name: "Credits",
        // 没有周期总额可算百分比；用 0 表示「不适用」而不是编一个。
        used: 0,
        display: compact(remaining),
        amount: remaining,
        unit: "credits",
        ...(soonest > 0 ? { runsOutAt: new Date(soonest).toISOString() } : {}),
      },
    ],
  }
}

/**
 * 每日签到（三步：查槽位 → 查上下文 → 领取 → 复核）。
 *
 * 判定顺序把「业务正常状态」与「真失败」严格分开：今天已领是 `done`，
 * 活动不存在是 `inactive`，两者都不该报错。
 *
 * 领取后**再拉一次 context 复核**（照 `L0NE-6/LobsterAI-AutoCheckin` 的做法）：
 * 领取接口可能回 200 但什么都没发（幂等命中、活动已改配置）。不复核就会把
 * 「其实没领到」报成 claimed，用户看到积分没变而面板说成功。复核只认
 * `state.claimedToday === true`；拉不到就退回「领取接口成功即 claimed」。
 */
async function checkin(cred) {
  const version = await clientVersion()
  const query = new URLSearchParams({
    placement: "desktop_sidebar",
    clientVersion: version,
    containerApiVersion: "2",
    platform: "win32",
  })
  let slot
  try {
    slot = await call(`${API_BASE}${SLOT_PATH}?${query.toString()}`, {
      headers: authHeaders(cred.access_token),
    })
  } catch (e) {
    return { outcome: "failed", message: e?.message ?? String(e) }
  }
  const code = typeof slot?.activity?.activityCode === "string" ? slot.activity.activityCode : ""
  if (slot?.slotState !== "available" || !code) {
    return { outcome: "inactive", message: `no check-in available (slotState=${slot?.slotState ?? "?"})` }
  }
  const revision = num(slot?.activity?.configRevision)
  const base = `${API_BASE}${CONTEXT_PATH}/${encodeURIComponent(code)}`
  let ctx
  try {
    ctx = await call(`${base}/context?configRevision=${revision}`, { headers: authHeaders(cred.access_token) })
  } catch (e) {
    return { outcome: "failed", message: e?.message ?? String(e) }
  }
  if (ctx?.state?.claimedToday === true) return { outcome: "done", message: "already checked in today" }
  const actions = Array.isArray(ctx?.actions) ? ctx.actions : []
  if (!actions.includes("check_in")) return { outcome: "inactive", message: "check-in is not open now" }
  let got
  try {
    got = await call(`${base}/actions/check_in`, {
      method: "POST",
      headers: authHeaders(cred.access_token),
      body: { configRevision: revision, idempotencyKey: randomUUID(), payload: {} },
    })
  } catch (e) {
    return { outcome: "failed", message: e?.message ?? String(e) }
  }
  // 积分字段三级回退：不同活动/版本用不同字段名。
  const result = got?.result && typeof got.result === "object" ? got.result : {}
  const credit = ["creditsGranted", "rewardCredits", "credits"]
    .map((k) => result[k])
    .find((v) => typeof v === "number" && Number.isFinite(v)) ?? 0
  // 复核：再拉一次 context，只有 `claimedToday` 真的变成 true 才算领到。
  // 拉不到（网络抖动、活动刚结束）就退回领取接口的结果，不因为复核失败而
  // 把一次可能成功的签到报成 failed —— 那会让用户反复重试。
  let confirmed = null
  try {
    const after = await call(`${base}/context?configRevision=${revision}`, { headers: authHeaders(cred.access_token) })
    confirmed = after?.state?.claimedToday === true
  } catch {}
  if (confirmed === false) {
    // 领取接口说成功、复核说没签上：多半是活动状态未推进，如实报 inactive
    // 并带上原文，用户看到的是「没领到」，不会以为积分少了。
    return {
      outcome: "inactive",
      message: `the check-in went through but today is still marked unchecked${credit > 0 ? ` (said +${compact(credit)})` : ""}`,
    }
  }
  return {
    outcome: "claimed",
    message: `claimed ${compact(credit)} credits`,
    ...(credit > 0 ? { credit } : {}),
  }
}

// ---- SSE → JSON --------------------------------------------------------------

/**
 * 把上游的 SSE 流折叠成一条非流式 `chat.completion`。
 *
 * 上游 `stream:false` 直接 500，所以请求侧只能恒发 `true`；但客户端的
 * 非流式请求必须回一份完整的 JSON，否则它拿到的是一串裸 SSE 帧。
 */
async function unstream(res, model) {
  const text = await res.text()
  let content = ""
  let reasoning = ""
  let finish = "stop"
  let id = ""
  let usage
  const calls = []
  for (const line of text.split("\n")) {
    const m = /^data:\s?(.*)$/.exec(line)
    if (!m) continue
    const payload = m[1].trim()
    if (!payload || payload === "[DONE]") continue
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      continue
    }
    if (frame?.error) {
      const why = frame.error?.message ?? "upstream error"
      return new Response(JSON.stringify({ error: { message: why, type: "upstream_error" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    }
    id = frame?.id || id
    if (frame?.usage) usage = frame.usage
    const choice = frame?.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finish = choice.finish_reason
    const delta = choice.delta ?? choice.message ?? {}
    if (typeof delta.content === "string") content += delta.content
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const i = num(tc.index)
      calls[i] ??= { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } }
      if (tc.id) calls[i].id = tc.id
      if (tc.function?.name) calls[i].function.name += tc.function.name
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments
    }
  }
  const message = { role: "assistant", content }
  if (reasoning) message.reasoning_content = reasoning
  const toolCalls = calls.filter(Boolean)
  if (toolCalls.length) message.tool_calls = toolCalls
  return new Response(
    JSON.stringify({
      id: id || "chatcmpl-" + hex(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

// ---- 插件 --------------------------------------------------------------------

export const PROVIDER = "lobsterai"

export default async function LobsterAIPlugin() {
  const renew = renewer()

  return {
    /**
     * 设置面板里的模型清单。
     *
     * 用户在 `settings.json` 里自己写的模型优先 —— 远端清单是「建议」，
     * 用户填的是「事实」。
     */
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {}
      const p = config.provider[PROVIDER]
      p.name ??= "LobsterAI"
      p.npm ??= NPM
      p.api ??= api
      const models = {}
      for (const [id, name, context] of FALLBACK_MODELS) {
        models[id] = { name, limit: { context, output: 0 }, tool_call: true, attachment: false }
      }
      p.models = { ...models, ...(p.models ?? {}) }
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth }) {
        if (auth?.type !== "oauth") return provider.models
        try {
          const cred = unpack(auth.access)
          if (!cred) return provider.models
          const fresh = stale(auth) ? unpack((await renew(auth)).access) : cred
          const list = await liveModels(fresh)
          if (!list.length) return provider.models
          return Object.fromEntries(list.map((m) => [m.id, modelEntry(m)]))
        } catch {
          // 远端不可用时回退到 `config` 给的那张表，而不是报错 ——
          // 一个空的模型列表会让这个 provider 在 magpie 里彻底不可用。
          return provider.models
        }
      },
    },

    auth: {
      provider: PROVIDER,
      refreshLead: LEAD_MS,
      refresh: (auth) => renewal(auth),
      methods: [
        { type: "oauth", label: "LobsterAI account (browser)", authorize: () => browserSignIn() },
      ],

      /**
       * 出站请求改写：补身份头、把 `stream` 强制成 `true`、必要时把 SSE 折回 JSON。
       *
       * magpie 给插件的 `baseURL` 是 `…/api/proxy/v1`，请求路径是 `/chat/completions`，
       * 拼起来正好是上游要的 `…/api/proxy/v1/chat/completions`。
       */
      async loader(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth") return {}
        return {
          baseURL: api,
          apiKey: "",
          async fetch(input, init) {
            let auth = await getAuth()
            if (auth?.type !== "oauth") throw new Error("LobsterAI isn't signed in")
            if (stale(auth)) auth = await renew(auth)
            const cred = unpack(auth.access)
            if (!cred) throw new Error("LobsterAI credential is unreadable; sign in again")

            const req = input instanceof Request ? input : null
            const raw = init?.body ?? (req ? await req.clone().text() : undefined)
            let body = raw
            let model = ""
            let wantsStream = true
            try {
              const parsed = JSON.parse(String(raw ?? "{}"))
              model = String(parsed.model ?? "")
              wantsStream = parsed.stream !== false
              // 上游只支持 SSE：`stream:false` 回 500，故请求侧恒发 true。
              parsed.stream = true
              body = JSON.stringify(parsed)
            } catch {}

            const version = await clientVersion()
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("authorization")
            headers.delete("x-api-key")
            headers.delete("content-length")
            for (const [k, v] of Object.entries(clientHeaders(cred.access_token, version, "text/event-stream, application/json"))) {
              headers.set(k, v)
            }

            const res = await fetch(req ? req.url : input, {
              ...init,
              method: init?.method ?? req?.method,
              headers,
              body,
            })
            // 401/403 是凭据问题，原样放行让 magpie 标记失效；其余 4xx 是
            // 「这次请求不合规」，打 kept 免得账号被误标成过期。
            if (res.status === 401 || res.status === 403) return res
            if (res.status >= 400) return explained(res, "LobsterAI refused this request")
            const out = wantsStream ? res : await unstream(res, model)
            return kept(out)
          },
        }
      },

      usage: async (getAuth) => {
        const a = await getAuth()
        if (a?.type !== "oauth") return { error: "not signed in", signIn: "kept" }
        try {
          const fresh = stale(a) ? await renew(a) : a
          const cred = unpack(fresh.access)
          if (!cred) return { error: "credential is unreadable", signIn: "kept" }
          return { ...(await usageOf(cred)), signIn: "kept" }
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },

      checkin: async (getAuth) => {
        const a = await getAuth()
        if (a?.type !== "oauth") return { outcome: "inactive", message: "not signed in" }
        try {
          const fresh = stale(a) ? await renew(a) : a
          const cred = unpack(fresh.access)
          if (!cred) return { outcome: "inactive", message: "credential is unreadable" }
          return await checkin(cred)
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e) }
        }
      },
    },
  }
}

export const _internal = {
  PROVIDER,
  api,
  FALLBACK_MODELS,
  CHAT_PATH,
  pack,
  unpack,
  expiresAtOf,
  keyfrom,
  credentialFrom,
  thinkingOf,
  parsed,
  clientHeaders,
  browserSignIn,
  usageOf,
  checkin,
  unstream,
  loginUrl,
}
