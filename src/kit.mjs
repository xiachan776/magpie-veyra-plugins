/**
 * 五个 provider 共用的最小工具层。
 *
 * 这里**只**放真正被两个以上插件用到、且与厂商无关的东西：信封解析、错误形状、
 * `X-Magpie-Sign-In` 应答头。任何与某一家协议有关的取值都不进本文件 —— 否则
 * 「三家共用一份常量」会在某一家的口径变化时静默污染另两家。
 *
 * 刻意**不**在这里做「万能版」的 token 合并、续期去重、模型条目构造：四家的
 * 凭据形状差得太远（腾讯系是扁平 `access/refresh`，CodeArts 是
 * `credentials.{access_key_id,secret_access_key,security_token}` + DPoP 私钥，
 * Loomy 干脆没有续期），抽成通用器后每次改动都要在运行时判断「这家是哪种形状」，
 * 而各写一份本地实现只需读一个文件。共用层越薄，改错的影响面越小。
 */

import { randomBytes } from "node:crypto"

/** magpie 的 provider 条目与 AI SDK 适配器：四家都是 OpenAI Chat 协议。 */
export const NPM = "@ai-sdk/openai-compatible"

export const hex = () => randomBytes(16).toString("hex")
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一次厂商 API 调用失败。`code` 是厂商自己的业务码（若有）。 */
export class ApiError extends Error {
  constructor(message, code, status, said) {
    super(message)
    this.code = code
    this.status = status
    this.said = said
  }
}

/**
 * 发一次「`{code,msg,data}` 信封」请求：腾讯系的管理面端点都是这个形状。
 *
 * 业务码非 0 也视为失败 —— 腾讯系把「凭据过期」这类错误藏在 200 的
 * `{code:11128}` 里，只看 HTTP 状态码会漏判。
 */
export async function envelope(base, method, path, { headers = {}, body, timeout = 30000, who = "" } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {}
  const code = Number.parseInt(env?.code, 10) || 0
  if (!res.ok) {
    const why = env?.msg || env?.message || env?.error?.message || text.slice(0, 200) || res.statusText
    throw new ApiError(`${who}: ${why} (HTTP ${res.status}${env?.code ? ", code " + env.code : ""})`, env?.code, res.status, why)
  }
  if (code) {
    throw new ApiError(`${who}: ${env?.msg || "error"} (${code})`, code, res.status, env?.msg || `error ${code}`)
  }
  return env?.data
}

// ---- magpie 的 sign-in 应答头 ----------------------------------------------

/**
 * `X-Magpie-Sign-In: kept` —— 让 magpie 别把这次失败算成「登录态失效」。
 *
 * 用途：厂商回了 4xx 但语义是「这次请求不合规」（参数、内容策略、限流），
 * 不是凭据过期。不打这个头，magpie 会把账号标成失效并要求用户重新登录。
 */
export function kept(res) {
  // `new Response(body)` 会按 UTF-8 重新编码，但**不沿用**原来头里的
  // `content-encoding`/`content-length`：上游若发过 `gzip`，这两个头留着就会让
  // 客户端去解一段已经解好的明文（表现为「invalid gzip header」）。故先删掉，
  // 长度交给 undici 自己算。
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  out.headers.set("X-Magpie-Sign-In", "kept")
  return out
}

/**
 * 给一个失败响应补一句人话，并标 `kept`。
 *
 * 只改 body、只加头；状态码原样保留 —— magpie 与客户端都还按状态码分流。
 */
export async function explained(res, message) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("X-Magpie-Sign-In", "kept")
  headers.set("Content-Type", "application/json")
  let body = message
  try {
    const text = await res.text()
    if (text) body = `${message}\n\n${text.slice(0, 2000)}`
  } catch {}
  return new Response(JSON.stringify({ error: { message: body, type: "upstream_error", code: res.status } }), {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}
