/**
 * 华为云 CodeArts（`codearts`）：magpie 里完全没有的一家。
 *
 * 与前面四家的根本差异：**认证不是 Bearer token，而是华为云 SDK-HMAC-SHA256
 * 请求签名**。登录走 IAM 的 PKCE + DPoP（ES256）OAuth，签出来的是
 * `access_key_id` / `secret_access_key` / `security_token` 三件套，每个请求都要
 * 现算一次签名。故本文件的一半篇幅是签名与 OAuth，而不是聊天协议。
 *
 * 协议来源：Veyra 的 `src/oauth.ts`（PKCE/DPoP/STS）、`src/login.ts`（portal
 * 登录与回调）、`src/sign.ts`（签名）、`src/models.ts`（两个模型源）、
 * `src/codearts-credits.ts`（积分与签到）、`src/llm-adapter.ts`（请求体）。
 * 那些结论都是拿真实凭据抓包得到的，这里照抄而不重新推断。
 *
 * 三处**不可想当然**的硬约束（违反会得到极难定位的失败）：
 * 1. `Agent-Type` / `X-Language` 这两个头必须**签名之后**追加。把它们放进
 *    canonical request 会让服务端回 `401 APIG.0301 ... verify ak sk signature fail`。
 * 2. 思考档位只有「开/关」，且唯一生效的控制是顶层 `thinking.type` ——
 *    `reasoning_effort` 无论填什么都被接受但**完全没有效果**。
 * 3. benefit（免费额度）模型必须带 `maas_type: benefit`，而该头**参与签名**；
 *    非 benefit 模型带上它反而回 `unsupported model`。
 */

import { createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign as signRaw, randomUUID } from "node:crypto"
import { createServer } from "node:http"

import { hex, kept, explained, sleep, NPM } from "./kit.mjs"
import { CODEARTS_ICON } from "./icons.mjs"

// ---- 常量 --------------------------------------------------------------------

const CHAT_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2"
const SNAP_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com"
const GATEWAY_CONFIG_URL = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config"
const BUILTIN_MODELS_URL = "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin"
const STS_ENDPOINT = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens"
const PORTAL_AUTHORIZE = "https://codearts.huaweicloud.com/portal/authorize"
const PORTAL_LOGIN = "https://codearts.huaweicloud.com/portal/login"
const TICKET_ENDPOINT = "https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket"

const CLIENT_ID = "codearts-agent"
const REDIRECT_PATH = "/oauth/callback"
const LOGIN_PLUGIN_NAME = "snap_AIIDE"
const LOGIN_PLUGIN_VERSION = "5.2.0"

const PACKAGE_INFO_PATH = "/snap-manager/v1/statistics/plugin"
const OPS_DELIVERY_PATH = "/v1/ops/delivery"
const OPS_CLAIM_PATH = "/v1/ops/claim"
const OPS_CONFIRM_PATH = "/v1/ops/confirm"
const OPS_CHANNEL = "IDE"
const DAILY_LOGIN_TYPE = "USER_LOGIN"
const CLAIMED_STATUSES = ["CLAIMED", "CONFIRMED", "CONSUMED"]

const LEAD_MS = 5 * 60 * 1000
const EARLY_MS = 60 * 1000
const LOGIN_TIMEOUT_MS = 180 * 1000
const MIN_CALLBACK_PORT = 10_000
const REQUEST_TIMEOUT_MS = 30 * 1000

/** 全 provider 统一输出上限：65536 实测可用，131072 会触发空流。 */
const MAX_OUTPUT_TOKENS = 65_536

/**
 * 所有 snap-access 请求共用的附加头 —— **签名后追加，不参与签名**。
 *
 * `Agent-Type` 本身仍是服务端路由所需（`/v1/model/builtin` 靠它选响应形态），
 * 只是不该被签进去。见文件头第 1 条硬约束。
 */
const SNAP_EXTRA_HEADERS = { "Agent-Type": "PromptCenter", "X-Language": "zh-cn" }

/** 参与签名的 benefit 头：与 Rust 参考实现一致，先并入再算 canonical。 */
const BENEFIT_HEADERS = { maas_type: "benefit" }

/**
 * benefit 模型兜底集合。权威来源是 `gateway/config`，但首次启动/未登录时拿不到。
 *
 * ⚠️ `deepseek-v4-flash` / `deepseek-v4-pro`（无日期后缀）**不在**此集合：
 * gateway 下发的是它们的 `-0731` 形态，归一化后才落到这两个 id，绝不能连带
 * 标成 benefit —— 带上 `maas_type` 会回 `unsupported model`。
 */
const BENEFIT_FALLBACK = ["glm-5.3-flash", "deepseek-v4.1-flash"]

/** 上下文窗口（Veyra 实测；缺省的不臆造，交后端）。 */
const CONTEXT_WINDOWS = {
  "GLM-5.2": 202_752,
  "glm-5.3-flash": 1_048_576,
  "deepseek-v4-flash": 1_048_576,
  "deepseek-v4-pro": 1_048_576,
  "deepseek-v4.1-flash": 1_000_000,
}

/**
 * 兜底模型表：`[id, name, context]`。
 *
 * 顺序即 Veyra 的展示顺序。`variants` 在 `modelEntry` 里统一给 —— 见
 * `EFFORT_VARIANTS`。
 */
const FALLBACK_MODELS = [
  ["GLM-5.2", "GLM-5.2", 202_752],
  ["GLM-5.1", "GLM-5.1", 0],
  ["GLM-5", "GLM-5", 0],
  ["glm-5.3-flash", "GLM-5.3-Flash", 1_048_576],
  ["openpangu-2.0-flash", "openPangu 2.0 Flash", 0],
  ["openpangu-2.0-pro", "openPangu 2.0 Pro", 0],
  ["deepseek-v4-flash", "DeepSeek-V4-Flash", 1_048_576],
  ["deepseek-v4-pro", "DeepSeek-V4-Pro", 1_048_576],
  ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", 1_000_000],
]

/**
 * 思考档位：只有「关 / 开」两档，映射到 magpie 的 `none` / `high`。
 *
 * 为什么要借 `high` 而不是自造一个 `on`：magpie 的档位词表是固定的
 * （`catalog.EffortRank`），自造词会被 `NearestEffort` 当成未知档位而原样透传，
 * 客户端看到的就是一个它不认识的档位名。`high` 是「开」在词表里最近的锚点：
 * 客户端要 `low`/`medium` 时 NearestEffort 会落到 `high`（平局取更强），
 * 要 `none` 才是关。默认 `high`（= 开），与服务端默认一致。
 */
const EFFORT_VARIANTS = ["none", "high"]

// ---- 小工具 ------------------------------------------------------------------

const b64u = (buf) => Buffer.from(buf).toString("base64url")
const sha256 = (data) => createHash("sha256").update(data).digest()
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

const str = (v) => (typeof v === "string" ? v : "")

/** 标识符字段：华为对同一语义字段的类型并不一致（`campaignId` 实测是数字）。 */
const ident = (v) => {
  if (typeof v === "string") return v
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  return ""
}

const record = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {})

/** 去掉模型 id 末尾的 `-NNNN` 日期后缀：chat 端点只认不带后缀的 id。 */
function normalizeModelId(id) {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith("-") && /^\d{4}$/.test(suffix.slice(1))) return id.slice(0, -5)
  }
  return id
}

// ---- 华为云 SDK-HMAC-SHA256 签名 ---------------------------------------------

/**
 * 签名一个华为请求，返回需要随请求发送的头。
 *
 * canonical request 七段：`method\nuri\nquery\nheaderLines\n\nsignedHeaders\npayloadHash`。
 * `uri` 不以 `/` 结尾时**必须补上** —— 服务端按补过的形态重算，不补就 401。
 */
function signRequest(ak, sk, st, method, urlStr, bodyBytes, extra) {
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith("/")) uri += "/"
  const query = url.search.slice(1)
  const dateStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  const payloadHash = sha256(bodyBytes).toString("hex")

  const headers = new Map()
  headers.set("host", url.host)
  headers.set("x-sdk-date", dateStamp)
  headers.set("x-sdk-content-sha256", payloadHash)
  headers.set("x-security-token", st)
  for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v)
  if (method.toUpperCase() !== "GET") headers.set("content-type", "application/json")

  const signed = [...headers.keys()].sort()
  const headerLines = signed.map((k) => `${k}:${headers.get(k)}`)
  const canonical = [method, uri, query, headerLines.join("\n"), "", signed.join(";"), payloadHash].join("\n")
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${sha256(canonical).toString("hex")}`
  const signature = createHmac("sha256", sk).update(stringToSign, "utf8").digest("hex")
  headers.set("Authorization", `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signed.join(";")},Signature=${signature}`)
  return headers
}

/**
 * 发一次已签名的 snap-access 请求。
 *
 * 返回 `{ok, data}` 或 `{ok:false, message}`：调用方需要如实呈现「为什么查不到」，
 * 所以错误里保留服务端的 `error_code` / `error_msg`（例如 401 时的
 * `APIG.0301 ... verify ak sk signature fail` 就是「签名头放错位置」的唯一线索）。
 */
async function signedFetch(c, method, url, bodyText, extraSigned) {
  if (!c?.ak || !c?.sk) return { ok: false, message: "凭据缺少 AK/SK" }
  const payload = bodyText === undefined ? new Uint8Array() : new TextEncoder().encode(bodyText)
  const signed = signRequest(c.ak, c.sk, c.st, method, url, payload, extraSigned)
  const headers = new Headers()
  // `host` 由运行时按实际连接目标生成，手工设置会被 fetch 拒绝。
  for (const [k, v] of signed) if (k !== "host") headers.set(k, v)
  for (const [k, v] of Object.entries(SNAP_EXTRA_HEADERS)) headers.set(k, v)
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(bodyText === undefined ? {} : { body: bodyText }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, message: e?.message ?? String(e) }
  }
  const text = await res.text()
  if (!res.ok) {
    let why = text.trim().slice(0, 200)
    try {
      const p = JSON.parse(text)
      const parts = [str(p?.error_code), str(p?.error_msg)].filter(Boolean)
      if (parts.length) why = parts.join(" ")
    } catch {}
    return { ok: false, message: `HTTP ${res.status}${why ? "：" + why : ""}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: "响应无法解析" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "响应无法解析" }
  }
  // 两种信封：`ops/*` 是 `{code,message,data}`，`statistics/plugin` 是裸对象。
  if (typeof parsed.code === "number") {
    if (parsed.code !== 0) {
      return { ok: false, message: str(parsed.message) || str(parsed.msg) || `业务码 ${parsed.code}` }
    }
    const data = parsed.data
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? { ok: true, data }
      : { ok: false, message: "响应缺少 data 字段" }
  }
  return { ok: true, data: parsed }
}

// ---- OAuth：PKCE + DPoP ------------------------------------------------------

function dpopKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  return { publicJwk: publicKey.export({ format: "jwk" }), privateJwk: privateKey.export({ format: "jwk" }) }
}

/** 从存下来的私钥 JWK 还原「私钥 + 只能有 kty/crv/x/y 的公钥」。 */
function keysFromJwk(privateJwk) {
  return {
    privateJwk,
    publicJwk: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y },
  }
}

/**
 * 签一张 DPoP proof。
 *
 * ES256 的 JWS 签名是 **R||S 定长拼接**，不是 DER —— Node 默认给 DER，必须
 * 指定 `dsaEncoding: "ieee-p1363"`，否则服务端一律判 `InvalidDPoPHeader`。
 * 该错误在 Veyra 里**刻意不算终态**：时钟偏差、重放、网关抖动都只表现为它，
 * 当终态会把材料完好的账号一步标死。
 */
function dpopJws(keys, htm, htu) {
  const head = b64u(JSON.stringify({ alg: "ES256", typ: "dpop+jwt", jwk: keys.publicJwk }))
  const body = b64u(JSON.stringify({ htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomBytes(32).toString("hex") }))
  const key = createPrivateKey({ key: keys.privateJwk, format: "jwk" })
  const sig = signRaw("sha256", Buffer.from(`${head}.${body}`, "utf8"), { key, dsaEncoding: "ieee-p1363" })
  return `${head}.${body}.${b64u(sig)}`
}

class TokenExpired extends Error {}

/** 换 token：`authorization_code` 与 `refresh_token` 共用这一个端点。 */
async function tokenRequest(body, keys) {
  const dpop = dpopJws(keys, "POST", STS_ENDPOINT)
  let res
  try {
    res = await fetch(STS_ENDPOINT, {
      method: "POST",
      headers: { DPoP: dpop, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (e) {
    throw new Error(`CodeArts token request network error: ${e?.message ?? e}`)
  }
  const text = await res.text()
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {}
  if (!res.ok || !data?.credentials) {
    // 只有这两种是**终态**（refresh token 已作废）。`InvalidDPoPHeader` 不算：
    // 它是一次请求层的拒绝，不代表材料坏了。
    const fatal =
      data?.error === "invalid_grant" ||
      String(data?.error_code ?? "").includes("ExpiredRefreshToken")
    const said = `${res.status} ${text.slice(0, 300)}`
    if (fatal) throw new TokenExpired(`CodeArts token request failed: ${said}`)
    throw new Error(`CodeArts token request failed: ${said}`)
  }
  return data
}

/** token 响应 → 存进 magpie 的登录态。refresh token 落 `refresh`，其余打包进 `access`。 */
function credentialFromToken(token, { verifier, keys, refreshFallback }) {
  const c = token.credentials
  const expires = Number.isFinite(Date.parse(c.expiration)) ? Date.parse(c.expiration) : Date.now() + 2 * 3600_000
  return {
    c: {
      ak: c.access_key_id,
      sk: c.secret_access_key,
      st: c.security_token,
      expires,
      verifier,
      jwk: keys.privateJwk,
    },
    refresh: str(token.refresh_token) || refreshFallback || "",
    expires,
  }
}

const pack = (c) => JSON.stringify(c)
const unpack = (s) => {
  try {
    const c = JSON.parse(String(s ?? ""))
    return c && typeof c === "object" ? c : null
  } catch {
    return null
  }
}

// ---- 登录：portal authorize → 本地回调 ---------------------------------------

function listenAt(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    // portal 拒绝 <10000 的回调端口，故先试 0，不够就换随机高档位。
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0
      if (port >= MIN_CALLBACK_PORT) return resolve(port)
      server.close(() => {
        const retry = MIN_CALLBACK_PORT + Math.floor(Math.random() * (65_535 - MIN_CALLBACK_PORT))
        server.once("error", reject)
        server.listen(retry, "127.0.0.1", () => {
          const a = server.address()
          resolve(typeof a === "object" && a !== null ? a.port : 0)
        })
      })
    })
  })
}

/**
 * 登录 URL。
 *
 * 两条硬约束：**不能加 `auth_callback_url`**（加了 portal 会回退旧 ticket
 * 流程，`?code=` 再也不来），`code_challenge_method` 必须是 `SHA-256`
 * 而不是 `S256`。
 */
function loginUrl(port, challenge, ticketId) {
  const q = new URLSearchParams({
    theme: "2",
    locale: "zh-cn",
    uri_scheme: CLIENT_ID,
    client_id: CLIENT_ID,
    port: String(port),
    code_challenge: challenge,
    code_challenge_method: "SHA-256",
    ticket_id: ticketId,
    "plugin-name": LOGIN_PLUGIN_NAME,
    "plugin-version": LOGIN_PLUGIN_VERSION,
  })
  return `${PORTAL_AUTHORIZE}?${q.toString()}`
}

const resultUrl = (ok) =>
  `${PORTAL_LOGIN}?login_succeed=${ok}&uri_scheme=${CLIENT_ID}&locale=zh-cn`

/** 旧 ticket 流程：拿 `secret` 去换凭据（portal 回退时才会走到）。 */
async function pollTicket(ticketId, secret) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error("CodeArts login timed out")
    const url = `${TICKET_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "plugin-name": LOGIN_PLUGIN_NAME,
        "plugin-version": LOGIN_PLUGIN_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null)
    if (res?.ok) {
      const body = await res.json().catch(() => null)
      const found = parseTicket(body)
      if (found) return found
    }
    await sleep(1000)
  }
}

/** ticket 响应认两种形状（旧 IDE 与 portal 各一套字段名）。 */
function parseTicket(body) {
  const env = record(record(body).data)
  const a = record(env.credential ?? env.result)
  const ak = str(a.access ?? a.accessKeyId)
  const sk = str(a.secret ?? a.secretAccessKey)
  const st = str(a.securitytoken ?? a.securityToken)
  if (!ak || !sk || !st) return null
  const raw = str(a.expires_at ?? a.expiresAt ?? a.expiration)
  return { ak, sk, st, expires: Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : Date.now() + 86_400_000 }
}

/**
 * 浏览器登录：起本地回调 → 用户在 portal 登录 → 拿 `code` → 当场换 token。
 *
 * 回调落定与换 token 在同一个 Promise 里闭环，不落任何临时文件。
 */
async function browserSignIn() {
  const verifier = randomBytes(48).toString("base64url")
  const challenge = b64u(sha256(verifier))
  const keys = dpopKeyPair()
  const ticketId = randomBytes(16).toString("hex")

  let settle
  const done = new Promise((resolve) => (settle = resolve))
  // 回调可能在「Promise 建好」与「被 await」之间落定；先挂空处理器。
  done.catch(() => {})

  const server = createServer((request, response) => {
    const port = request.socket.localPort
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
    if (!url.pathname.startsWith(REDIRECT_PATH)) {
      response.writeHead(404).end("Not found")
      return
    }
    const code = url.searchParams.get("code")
    const secret = url.searchParams.get("secret")
    if (!code && !secret) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad callback")
      return
    }
    const finish = (ok) => {
      response.writeHead(307, { Location: resultUrl(ok) }).end()
    }
    if (secret) {
      void pollTicket(ticketId, secret)
        .then((found) => {
          finish(true)
          settle(successOf(found, verifier, keys, ""))
        })
        .catch((e) => {
          finish(false)
          settle({ type: "failed", error: e?.message ?? String(e) })
        })
      return
    }
    void tokenRequest(
      {
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: `http://127.0.0.1:${port}${REDIRECT_PATH}`,
      },
      keys,
    )
      .then((token) => {
        const { c, refresh, expires } = credentialFromToken(token, { verifier, keys })
        finish(true)
        settle({
          type: "success",
          access: pack(c),
          refresh,
          expires,
          accountId: c.ak,
        })
      })
      .catch((e) => {
        finish(false)
        settle({ type: "failed", error: e?.message ?? String(e) })
      })
  })

  const port = await listenAt(server)
  const close = () => new Promise((resolve) => server.close(() => resolve()))
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ type: "failed", error: "CodeArts sign-in timed out" }), LOGIN_TIMEOUT_MS).unref?.()
  })

  return {
    url: loginUrl(port, challenge, ticketId),
    instructions: "Sign in to CodeArts in the browser that opened, then come back here.",
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

function successOf(found, verifier, keys, refresh) {
  const c = { ak: found.ak, sk: found.sk, st: found.st, expires: found.expires, verifier, jwk: keys.privateJwk }
  return { type: "success", access: pack(c), refresh: refresh ?? "", expires: found.expires, accountId: found.ak }
}

// ---- 续期 --------------------------------------------------------------------

async function renewal(a) {
  const c = unpack(a?.access)
  if (!c) {
    const e = new Error("CodeArts isn't signed in; sign in again")
    e.signIn = "expired"
    throw e
  }
  if (!a.refresh || !c.verifier || !c.jwk) {
    const e = new Error("CodeArts has no refresh material; sign in again")
    e.signIn = "expired"
    throw e
  }
  const keys = keysFromJwk(c.jwk)
  try {
    const token = await tokenRequest(
      { client_id: CLIENT_ID, code_verifier: c.verifier, grant_type: "refresh_token", refresh_token: a.refresh },
      keys,
    )
    const next = credentialFromToken(token, { verifier: c.verifier, keys, refreshFallback: a.refresh })
    return { access: pack(next.c), refresh: next.refresh, expires: next.expires }
  } catch (e) {
    if (e instanceof TokenExpired) e.signIn = "expired"
    throw e
  }
}

// ---- 模型 --------------------------------------------------------------------

/** 沿路径指针取数组。 */
function arrayAt(text, path) {
  try {
    let v = JSON.parse(text)
    for (const k of path) {
      if (typeof v !== "object" || v === null) return undefined
      v = v[k]
    }
    return Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

async function signedGet(c, url, extraSigned) {
  const got = await signedFetch(c, "GET", url, undefined, extraSigned)
  return got.ok ? got.data : undefined
}

/**
 * 两个模型源合并：`gateway/config` 给 benefit 模型、`/v1/model/builtin` 给常规模型。
 *
 * 顺手更新 `benefitIds`：只有**归一化未改写**的 id 才算 benefit —— 被改写过的
 * 那个 id 我们根本不发送，它也无从决定我们发送的 id 的 benefit 属性。
 */
async function liveModels(c) {
  const out = []
  const seen = new Set()
  const push = (rawId, rawName) => {
    const id = normalizeModelId(rawId)
    // 视觉模型上下文小、不支持工具调用，不适合当 agent 主模型，从列表隐藏。
    if (id.includes("-VL-") || id.endsWith("-VL")) return
    if (seen.has(id)) return
    seen.add(id)
    const name = rawName ? normalizeModelId(rawName) : id
    out.push({ id, name, context: CONTEXT_WINDOWS[id] ?? CONTEXT_WINDOWS[name] ?? 0 })
  }

  const gw = await fetchSignedText(c, GATEWAY_CONFIG_URL)
  const gatewayArr = gw === undefined ? undefined : arrayAt(gw, ["result", "models"])
  if (gatewayArr !== undefined) {
    const benefits = []
    for (const item of gatewayArr) {
      const e = record(item)
      const rawId = str(e.model_id)
      if (!rawId) continue
      push(rawId, str(e.model_name))
      if (normalizeModelId(rawId) === rawId) benefits.push(normalizeModelId(rawId))
    }
    if (benefits.length) benefitIds = new Set(benefits)
  }

  const snap = await fetchSignedText(c, BUILTIN_MODELS_URL, { "Content-Type": "application/json", ...SNAP_EXTRA_HEADERS })
  const snapArr = snap === undefined ? undefined : arrayAt(snap, ["builtinModels"])
  if (snapArr !== undefined) {
    for (const item of snapArr) {
      const e = record(item)
      const rawId = str(e.model_id)
      if (rawId) push(rawId, str(e.model_name))
    }
  }

  return out
}

/** 已签名 GET，返回文本；失败返回 undefined（不阻断调用方）。 */
async function fetchSignedText(c, url, extraUnsigned) {
  if (!c?.ak || !c?.sk) return undefined
  const signed = signRequest(c.ak, c.sk, c.st, "GET", url, new Uint8Array())
  const headers = new Headers()
  for (const [k, v] of signed) if (k !== "host") headers.set(k, v)
  for (const [k, v] of Object.entries(extraUnsigned ?? {})) headers.set(k, v)
  try {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(10_000) })
    return res.ok ? await res.text() : undefined
  } catch {
    return undefined
  }
}

/** 当前已知的 benefit 模型集合，聊天请求据此决定是否带 `maas_type`。 */
let benefitIds = new Set(BENEFIT_FALLBACK)

// ---- 积分 --------------------------------------------------------------------

/** `metrics[]` → 积分窗口。总额取 `usageTotalPackageCredit`，**不累加分类**。 */
function usageOf(metrics) {
  if (!Array.isArray(metrics)) return { windows: [] }
  let total
  let remain
  for (const item of metrics) {
    const e = record(item)
    if (str(e.name) !== "usageTotalPackageCredit") continue
    total = num(e.package_credit_amount)
    remain = num(e.package_credit_remain)
  }
  if (total === undefined) return { windows: [] }
  const used = Math.max(0, total - remain)
  if (!(total > 0)) return { windows: [] }
  return {
    plan: "CodeArts",
    windows: [
      {
        name: "Credits",
        used: (100 * used) / total,
        display: `${compact(remain)} / ${compact(total)}`,
        amount: used,
        limit: total,
        unit: "credit",
      },
    ],
  }
}

async function accountInfo(c) {
  const url = `${SNAP_BASE}${PACKAGE_INFO_PATH}`
  const got = await signedFetch(c, "GET", url, undefined)
  if (!got.ok) throw new Error(got.message)
  const pkg = record(got.data.package)
  return {
    isCredit: pkg.is_credit_package === true || String(pkg.is_credit_package).toLowerCase() === "true",
    isToken: pkg.is_token_package === true || String(pkg.is_token_package).toLowerCase() === "true",
    credit: usageOf(got.data.metrics),
  }
}

/**
 * 每日签到。
 *
 * 步骤与判定顺序每一步都对应一个**对用户含义不同**的结果：查询失败是
 * `failed`（该排查），非积分账户与「今天已领」都是 `inactive`/`done`
 * （不该被报成失败）。
 */
async function checkin(site, c) {
  let info
  try {
    info = await accountInfo(c)
  } catch (e) {
    return { outcome: "failed", message: `账户信息查询失败：${e?.message ?? e}` }
  }
  if (!info.isCredit) {
    return {
      outcome: "ineligible",
      message: info.isToken ? "Token 计费账户，不在积分活动范围" : "非积分计费账户，不在积分活动范围",
    }
  }

  const delivery = await signedFetch(c, "GET", `${SNAP_BASE}${OPS_DELIVERY_PATH}?channel=${OPS_CHANNEL}`, undefined)
  if (!delivery.ok) return { outcome: "failed", message: `活动列表查询失败：${delivery.message}` }
  const items = delivery.data.items
  if (!Array.isArray(items)) return { outcome: "failed", message: "活动列表缺少 items" }
  const activity = items.map(record).find((a) => str(a.type) === DAILY_LOGIN_TYPE)
  if (!activity) return { outcome: "inactive", message: "未找到每日签到活动" }

  const claimable = activity.claimable === true || String(activity.claimable).toLowerCase() === "true"
  const status = str(activity.status)
  if (!claimable) {
    return CLAIMED_STATUSES.includes(status)
      ? { outcome: "done", message: "今天已领取" }
      : { outcome: "inactive", message: `当前不可领取（status=${status || "未知"}）` }
  }
  const campaignId = ident(activity.campaignId)
  if (!campaignId) return { outcome: "failed", message: "活动缺少 campaignId，无法领取" }

  const claim = await signedFetch(
    c,
    "POST",
    `${SNAP_BASE}${OPS_CLAIM_PATH}`,
    JSON.stringify({ campaignId, channel: OPS_CHANNEL }),
  )
  if (!claim.ok) return { outcome: "failed", message: claim.message }

  // 服务端要求确认时才补 confirm：漏掉会让积分停在待确认。confirm 失败**不**把
  // 整体判失败 —— 积分已进入待确认态，报 failed 会让用户重复点击。
  const benefitId = claim.data.id
  if (benefitId !== null && benefitId !== undefined) {
    await signedFetch(c, "POST", `${SNAP_BASE}${OPS_CONFIRM_PATH}`, JSON.stringify({ campaignId }))
  }

  const credited =
    num(claim.data.benefitAmount) || num(claim.data.credit) || num(claim.data.credits) ||
    num(claim.data.creditAmount) || num(claim.data.amount) || num(activity.benefitAmount)
  return { outcome: "claimed", message: `claimed ${compact(credited)} credits`, ...(credited > 0 ? { credit: credited } : {}) }
}

// ---- 请求体改造 --------------------------------------------------------------

/**
 * 把客户端发来的 Chat 请求体改成 CodeArts 认的形态。
 *
 * - `stream` 恒 true（上游按流式实现，非流式未验证），非流式客户端由
 *   `unstream` 折回一个 JSON。
 * - `max_tokens` 压到 65536：超大的值会让上游直接 4xx `The request param is invalid`。
 * - `reasoning_effort` **删掉**：它无论填什么都被接受但完全无效果，留着只会让
 *   人以为调过档了。唯一生效的是顶层 `thinking.type`。
 * - 思考关闭（`none`）时补 `thinking: {type: "disabled"}`。
 */
function shape(bodyText, sessionId) {
  let b
  try {
    b = JSON.parse(bodyText)
  } catch {
    return { text: bodyText, model: "", stream: true }
  }
  if (!b || typeof b !== "object") return { text: bodyText, model: "", stream: true }
  const wantsStream = b.stream !== false
  const off = typeof b.reasoning_effort === "string" && b.reasoning_effort.trim().toLowerCase() === "none"
  delete b.reasoning_effort
  b.stream = true
  b.prompt_cache_key = sessionId || b.prompt_cache_key
  if (typeof b.max_tokens !== "number" || !(b.max_tokens > 0) || b.max_tokens > MAX_OUTPUT_TOKENS) {
    b.max_tokens = MAX_OUTPUT_TOKENS
  }
  if (off) b.thinking = { type: "disabled" }
  return { text: JSON.stringify(b), model: str(b.model), stream: wantsStream }
}

/** 把一段标准 SSE 折成一个 `chat.completion`。 */
async function unstream(res, model) {
  const chunks = []
  for await (const part of res.body) chunks.push(part)
  const text = Buffer.concat(chunks).toString("utf8")
  let id = ""
  let created = Math.floor(Date.now() / 1000)
  let content = ""
  let reasoning = ""
  let finish = ""
  let usage
  const tools = new Map()
  for (const line of text.split("\n")) {
    const m = /^data:\s?(.*)$/.exec(line.trim())
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
      return new Response(JSON.stringify({ error: { message: str(frame.error?.message) || "upstream error", type: "upstream_error" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (typeof frame?.id === "string" && frame.id) id = frame.id
    if (Number.isFinite(frame?.created)) created = frame.created
    if (frame?.usage) usage = frame.usage
    const choice = frame?.choices?.[0]
    if (!choice) continue
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason
    const d = choice.delta ?? choice.message ?? {}
    if (typeof d.content === "string") content += d.content
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const i = Number.isInteger(tc?.index) ? tc.index : 0
      const cur = tools.get(i) ?? { id: "", type: "function", function: { name: "", arguments: "" } }
      if (typeof tc?.id === "string" && tc.id) cur.id = tc.id
      if (typeof tc?.function?.name === "string") cur.function.name += tc.function.name
      if (typeof tc?.function?.arguments === "string") cur.function.arguments += tc.function.arguments
      tools.set(i, cur)
    }
  }
  const message = { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) }
  if (tools.size) message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
  return new Response(
    JSON.stringify({
      id: id || `chatcmpl-${hex()}`,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finish || "stop" }],
      ...(usage ? { usage } : {}),
    }),
    { status: res.status, headers: { "Content-Type": "application/json" } },
  )
}

// ---- 插件 --------------------------------------------------------------------

export const PROVIDER = "codearts"

export default async function CodeArtsPlugin() {
  const runs = new Map()
  const done = new Map()

  /** 续期去重：同一份 refresh token 只花一次（两处会同时触发续期）。 */
  async function renew(a) {
    const key = String(a?.refresh ?? "")
    const hit = done.get(key)
    if (hit && Date.now() - hit.at < 60_000) return { ...a, ...hit.next }
    let p = runs.get(key)
    if (!p) {
      p = renewal(a)
        .then((next) => {
          done.set(key, { next, at: Date.now() })
          return next
        })
        .finally(() => runs.delete(key))
      runs.set(key, p)
    }
    return { ...a, ...(await p) }
  }

  const need = (a, early = EARLY_MS) => !!a.expires && Date.now() >= a.expires - early

  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {}
      const p = config.provider[PROVIDER]
      p.name ??= "CodeArts"
      p.npm ??= NPM
      p.api ??= CHAT_BASE
      const models = {}
      for (const [id, name, context] of FALLBACK_MODELS) {
        models[id] = {
          name,
          limit: { context: context || 0, output: 0 },
          tool_call: true,
          attachment: false,
          reasoning: true,
          variants: Object.fromEntries(EFFORT_VARIANTS.map((e) => [e, { reasoningEffort: e }])),
        }
      }
      // 用户自己的配置优先。
      p.models = { ...models, ...(p.models ?? {}) }
    },

    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER || !input?.sessionID) return
      output.headers["x-magpie-codearts-session"] = String(input.sessionID).slice(0, 128)
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth }) {
        const c = unpack(auth?.access)
        if (auth?.type !== "oauth" || !c?.ak) return provider.models
        try {
          const fresh = need(auth) ? unpack((await renew(auth)).access) : c
          const list = await liveModels(fresh)
          if (!list.length) return provider.models
          return Object.fromEntries(
            list.map((m) => [
              m.id,
              {
                id: m.id,
                providerID: PROVIDER,
                name: m.name,
                api: { id: m.id, url: CHAT_BASE, npm: NPM },
                status: "active",
                headers: {},
                options: {},
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                // CodeArts 只有「开/关」两档，故所有模型都给同一组档位。
                limit: { context: m.context || 0, output: MAX_OUTPUT_TOKENS },
                capabilities: {
                  temperature: true,
                  reasoning: true,
                  attachment: false,
                  toolcall: true,
                  input: { text: true, image: false, audio: false, video: false, pdf: false },
                  output: { text: true, image: false, audio: false, video: false, pdf: false },
                  interleaved: false,
                },
                release_date: "",
                variants: Object.fromEntries(EFFORT_VARIANTS.map((e) => [e, { reasoningEffort: e }])),
                defaultEffort: "high",
                free: benefitIds.has(m.id),
                rate: 0,
                rateWas: 0,
              },
            ]),
          )
        } catch {
          return provider.models
        }
      },
    },

    auth: {
      provider: PROVIDER,
      /** Providers 页这一行的图标；缺了会回落到 Veyra 的蓝 V。见 `icons/codearts.svg`。 */
      icon: CODEARTS_ICON,
      refreshLead: LEAD_MS,
      refresh: (auth) => renew(auth),

      async loader(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth") return {}
        return {
          baseURL: CHAT_BASE,
          apiKey: "",
          async fetch(input, init) {
            let auth = await getAuth()
            if (auth?.type !== "oauth") throw new Error("CodeArts isn't signed in")
            if (need(auth)) auth = await renew(auth)
            let c = unpack(auth.access)
            if (!c?.ak) throw new Error("CodeArts has no credential; sign in again")

            const req = input instanceof Request ? input : null
            const headers = new Headers(init?.headers ?? req?.headers)
            const sessionId = String(headers.get("x-magpie-codearts-session") ?? "").trim()
            headers.delete("x-magpie-codearts-session")
            headers.delete("content-length")
            headers.delete("authorization")

            const raw = init?.body ?? (req ? await req.clone().text() : "")
            const shaped = shape(raw, sessionId)
            const url = `${CHAT_BASE}/chat/completions`
            const payload = new TextEncoder().encode(shaped.text)

            /** 发一次；`benefit` 决定 maas_type 是否参与签名。 */
            const send = async (benefit) => {
              const signed = signRequest(c.ak, c.sk, c.st, "POST", url, payload, benefit ? BENEFIT_HEADERS : undefined)
              const out = new Headers()
              // `host` 由运行时给；`content-type` 单独设，值与被签进去的相同。
              for (const [k, v] of signed) if (k !== "host" && k !== "content-type") out.set(k, v)
              out.set("Content-Type", "application/json")
              out.set("Accept", shaped.stream ? "text/event-stream" : "application/json")
              out.set("lang", "en")
              if (sessionId) {
                out.set("Chat-Id", sessionId)
                out.set("Session-Id", sessionId)
              }
              return fetch(url, { method: "POST", headers: out, body: payload, signal: init?.signal })
            }

            let res = await send(benefitIds.has(shaped.model))
            // benefit 判定可能与账号实际套餐不符（账号没买 benefit 包）。上游对这种
            // 情况回 4xx 且带 `unsupported model`，去掉该头重发一次即可。
            if (res.status >= 400 && !res.ok) {
              const peek = await res.clone().text().catch(() => "")
              if (/unsupported model/i.test(peek)) res = await send(false)
            }
            if (res.status === 401 || res.status === 403) return res
            if (res.status >= 400) return explained(res, "CodeArts refused this request")
            const out = shaped.stream ? res : await unstream(res, shaped.model)
            return kept(out)
          },
        }
      },

      methods: [{ type: "oauth", label: "CodeArts account (browser)", authorize: () => browserSignIn() }],

      usage: async (getAuth) => {
        const a = await getAuth()
        if (a?.type !== "oauth") return { error: "not signed in", signIn: "kept" }
        try {
          const auth = need(a) ? await renew(a) : a
          const c = unpack(auth.access)
          const info = await accountInfo(c)
          return { ...info.credit, signIn: "kept" }
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },

      checkin: async (getAuth) => {
        const a = await getAuth()
        if (a?.type !== "oauth") return { outcome: "inactive", message: "not signed in" }
        try {
          const auth = need(a) ? await renew(a) : a
          return await checkin(PROVIDER, unpack(auth.access))
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e) }
        }
      },
    },
  }
}

export const _internal = {
  CHAT_BASE,
  MAX_OUTPUT_TOKENS,
  EFFORT_VARIANTS,
  FALLBACK_MODELS,
  normalizeModelId,
  signRequest,
  dpopJws,
  dpopKeyPair,
  keysFromJwk,
  shape,
  unstream,
  usageOf,
  loginUrl,
  arrayAt,
  pack,
  unpack,
  benefitIds: () => benefitIds,
  setId: (id) => { benefitIds = new Set(id) },
  randomUUID,
}
