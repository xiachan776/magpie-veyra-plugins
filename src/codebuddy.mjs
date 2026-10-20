/**
 * 腾讯 CodeBuddy 的两个站点（中国版 copilot.tencent.com、国际版 www.codebuddy.ai）。
 *
 * 与已经存在的 `workbuddy` / `workbuddy-ai` 插件是**同一套后端协议、不同的产品身份**：
 * 同一家把它们分成四个独立订阅，magpie 侧只有 workbuddy 那两个有 provider，
 * CodeBuddy 这两个是空白（`internal/provider` 里 grep `codebuddy` 只命中注释）。
 *
 * 两者共用一个实现，差异全在 `SITES`：端点、`X-Product-Code`、UA、模型表。
 * 登录入口是 `platform=ide`（workbuddy 那两个是 `platform=workbuddy`），
 * 这是它们不能复用同一个 provider id 的**唯一硬理由**：同一份 token 只在
 * 签发它的 platform 下有效。
 *
 * 协议来源：Veyra 的 `src/buddy.ts` / `src/buddy-oauth.ts` / `src/product.ts`
 * 与 `src/buddy-adapter.ts`（真实凭据实测），社区 workbuddy 插件的登录与续期
 * 形状完全同源，故这里照抄它的骨架、只换产品字段。
 */

import { hex, kept, explained, envelope, sleep, NPM } from "./kit.mjs"

const APP_VERSION = "2.0.0"
const POLL_MS = 1000
const SIGN_IN_MS = 5 * 60 * 1000
const EARLY_MS = 60 * 1000
const LEAD_MS = 5 * 60 * 1000
const KEEP_RENEWED_MS = 60 * 1000

const STATE_PATH = "/v2/plugin/auth/state"
const TOKEN_PATH = "/v2/plugin/auth/token"
const ACCOUNT_PATH = "/v2/plugin/login/account"
const REFRESH_PATH = "/v2/plugin/auth/token/refresh"
const CONFIG_PATH = "/v3/config"
const METER_PATH = "/v2/billing/meter/get-user-resource"
const CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status"
const CHECKIN_PATH = "/v2/billing/meter/daily-checkin"

const CODE_TOKEN_NOT_READY = 11217
const CODE_ACCOUNT_NOT_READY = 12151
const CODE_ALREADY_CLAIMED = 10001

/** 中国版：`/v3/config` 的 craft agent 白名单，逐个真实请求验证过可用。 */
const CN_MODELS = [
  ["hy4-preview", "Hy4 preview", 1_000_000, ["high"], true, { output: 64_000, defaultEffort: "high" }],
  ["hy3", "Hy3", 192_000, ["low", "high"], true, { output: 64_000, defaultEffort: "high" }],
  ["hy3-x", "Hy3", 192_000, ["low", "high"], true, { output: 64_000, defaultEffort: "high" }],
  ["deepseek-v4.1-flash", "Deepseek-V4.1-Flash", 1_000_000, ["low", "high", "max"], true, { output: 128_000, defaultEffort: "high" }],
  ["deepseek-v4-pro", "Deepseek-V4-Pro", 1_000_000, ["low", "high", "xhigh"], true, { output: 128_000, defaultEffort: "high" }],
  ["deepseek-v4-flash", "Deepseek-V4-Flash", 1_000_000, ["low", "high", "max"], true, { output: 50_000, defaultEffort: "high" }],
  ["glm-5.3", "GLM-5.3", 1_000_000, ["low", "high", "max"], true, { output: 64_000, defaultEffort: "high" }],
  ["glm-5.3-flash", "GLM-5.3-Flash", 1_000_000, ["low", "high", "max"], true, { output: 32_000, defaultEffort: "high" }],
  ["glm-5.2", "GLM-5.2", 1_000_000, ["high", "xhigh"], true, { output: 64_000, defaultEffort: "high" }],
  ["glm-5.1", "GLM-5.1", 200_000, ["medium"], true, { output: 48_000 }],
  ["glm-5v-turbo", "GLM-5V-Turbo", 200_000, ["medium"], true, { output: 64_000 }],
  ["kimi-k3-1", "Kimi-K3-1", 1_000_000, ["medium"], true, { output: 32_000 }],
  ["kimi-k2.8-preview", "Kimi-K2.8-Preview", 1_000_000, ["low", "high", "max"], true, { output: 64_000, defaultEffort: "high" }],
  ["kimi-k2.7", "Kimi-K2.7", 256_000, ["medium"], true, { output: 32_000 }],
  ["kimi-k2.6", "Kimi-K2.6", 256_000, ["medium"], true, { output: 32_000 }],
  ["minimax-m3", "MiniMax-M3", 512_000, ["medium"], true, { output: 64_000 }],
]

/**
 * 国际版：IDE 本地缓存里的 cli agent 白名单（顺序即 IDE 展示顺序）。
 *
 * ⚠️ 这张表**同时是 `-sg` 变体的唯一档位来源**：国际版 `/v3/config` 对
 * `deepseek-v4.1-flash` 只下发单值 `reasoning.effort:"high"`、不给
 * `supportedEfforts` 数组，照它的表态会退化成「只有 high 一档」。
 * 实测五档全 200 且有真实 `reasoning_content`，拼错的 `banana` 被 400 拒，
 * 故按实测五档写。
 */
const INTL_MODELS = [
  ["default-model", "Auto", 176_000, undefined, true, { output: 24_000 }],
  ["fast-model", "Fast", 200_000, ["medium"], true, { output: 32_000 }],
  ["balanced-model", "Balanced", 256_000, ["medium"], true, { output: 32_000 }],
  ["primary-model", "Primary", 272_000, ["high"], true, { output: 72_000 }],
  ["deep-model", "Deep", 176_000, undefined, true, { output: 24_000 }],
  ["hy4-preview-f", "Hy4 preview", 1_000_000, ["high"], true, { output: 64_000, defaultEffort: "high" }],
  ["hy4-preview", "Hy4 preview", 1_000_000, ["high"], true, { output: 64_000, defaultEffort: "high" }],
  ["hy3", "Hy3", 192_000, ["low", "high"], true, { output: 64_000, defaultEffort: "high" }],
  ["deepseek-v4.1-flash", "Deepseek-V4.1-Flash", 1_000_000, ["low", "medium", "high", "xhigh", "max"], true, { output: 128_000, defaultEffort: "high" }],
  ["deepseek-v4.1-flash-sg", "Deepseek-V4.1-Flash", 1_000_000, ["low", "medium", "high", "xhigh", "max"], true, { output: 128_000, defaultEffort: "high" }],
  ["gpt-6-astra", "GPT-6-Astra", 1_000_000, ["low", "medium", "high", "xhigh", "max"], true, { output: 128_000, defaultEffort: "high" }],
  ["gpt-5.6-sol", "GPT-5.6-Sol", 1_000_000, ["low", "medium", "high", "xhigh", "max"], true, { output: 128_000, defaultEffort: "high" }],
  ["gpt-5.6-terra", "GPT-5.6-Terra", 1_000_000, ["low", "medium", "high", "xhigh", "max"], true, { output: 128_000, defaultEffort: "high" }],
  ["gpt-5.6-luna", "GPT-5.6-Luna", 1_000_000, ["low", "medium", "high", "xhigh", "max"], true, { output: 128_000, defaultEffort: "high" }],
  ["gpt-5.5", "GPT-5.5", 1_000_000, ["low", "medium", "high", "xhigh"], true, { output: 128_000, defaultEffort: "high" }],
  ["gpt-5.4", "GPT-5.4", 272_000, ["low", "medium", "high", "xhigh"], true, { output: 72_000, defaultEffort: "high" }],
  // 远端未下发 maxOutputTokens，故 output 保持 0（交由网关默认），不臆造数值。
  ["gpt-5.3-codex", "GPT-5.3-Codex", 272_000, ["medium"], true, {}],
  ["gemini-3.5-flash", "Gemini-3.5-Flash", 1_000_000, ["medium"], true, { output: 65_536 }],
  ["glm-5.3", "GLM-5.3", 1_000_000, ["low", "high", "max"], true, { output: 48_000, defaultEffort: "high" }],
  ["glm-5.2", "GLM-5.2", 1_000_000, ["high", "xhigh"], true, { output: 48_000, defaultEffort: "high" }],
  ["kimi-k3", "Kimi-K3", 1_000_000, ["medium"], true, { output: 32_000 }],
  ["kimi-k2.8-preview", "Kimi-K2.8-Preview", 1_000_000, ["low", "high", "max"], true, { output: 32_000, defaultEffort: "high" }],
  ["kimi-k2.6", "Kimi-K2.6", 256_000, ["medium"], true, { output: 32_000 }],
]

const UA_CN = "CodeBuddyIDE/1.106.1"
const UA_INTL = "WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2"
const UA_INTL_CNLINE = "WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2"

/** 国际版按模型族分档：国际系模型线发国际形态，国内系发国内形态。 */
const INTL_UA_FAMILIES = [
  { match: "gpt-", ua: UA_INTL },
  { match: "gemini-", ua: UA_INTL },
  { match: "claude-", ua: UA_INTL },
  { match: "glm-", ua: UA_INTL_CNLINE },
  { match: "hy", ua: UA_INTL_CNLINE },
  { match: "kimi-", ua: UA_INTL_CNLINE },
  { match: "minimax-", ua: UA_INTL_CNLINE },
]

const SITES = [
  {
    id: "codebuddy",
    name: "CodeBuddy",
    // 登录用的 platform：与 workbuddy 的 `workbuddy` / `workbuddy-ai` 并列的第四个值。
    platform: "ide",
    endpoint: "https://copilot.tencent.com",
    apiDomain: "copilot.tencent.com",
    productCode: "codebuddy",
    attribution: "CodeBuddy",
    clientVersion: "1.106.1",
    userAgent: UA_CN,
    families: [],
    models: CN_MODELS,
    checkin: true,
  },
  {
    id: "codebuddy-intl",
    name: "CodeBuddy Intl",
    platform: "ide",
    endpoint: "https://www.codebuddy.ai",
    apiDomain: "www.codebuddy.ai",
    productCode: "codebuddy",
    attribution: "CodeBuddy",
    clientVersion: "1.106.1",
    userAgent: UA_CN,
    families: [],
    models: INTL_MODELS,
    checkin: false,
  },
]

const api = (site) => site.endpoint + "/v2"

const uaOf = (site, model) => {
  for (const rule of site.families) if (String(model ?? "").startsWith(rule.match)) return rule.ua
  return site.userAgent
}

const domainOf = (site, a) => a.domain || site.apiDomain

const enterpriseHeaders = (a) =>
  a.enterpriseId ? { "X-Enterprise-Id": a.enterpriseId, "X-Tenant-Id": a.enterpriseId } : {}

/** 一次管理面调用（登录/续期/用量），`{code,msg,data}` 信封。 */
const call = (site, method, path, headers = {}, body) =>
  envelope(site.endpoint, method, path, {
    headers: { "User-Agent": uaOf(site, "") + "", ...headers },
    body,
    who: site.name,
  })

// ---- 登录 ------------------------------------------------------------------

/**
 * 浏览器登录：要一个 state，用户在浏览器里登录，再轮询直到 token 与账号出来。
 *
 * 三处 `X-No-*: true` 是必须的 —— 这是未登录请求，带上任何身份头会被
 * 网关当成「身份不明」而不是「还没登录」。
 */
async function browserSignIn(site) {
  const state = await call(site, "POST", `${STATE_PATH}?platform=${encodeURIComponent(site.platform)}`, {
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  }, {})
  const url = state?.authUrl
  const id = state?.state
  if (!url || !id) throw new Error(`${site.name} gave no sign-in page`)
  const page = new URL(url)
  if (page.protocol !== "https:") throw new Error(`${site.name} gave a sign-in page that isn't https`)
  page.searchParams.set("version", APP_VERSION)
  page.searchParams.set("loginSessionId", hex())
  return {
    url: page.toString(),
    instructions: `Sign in to ${site.name} in the browser that opened, then come back here.`,
    method: "auto",
    async callback() {
      try {
        const token = await poll(site, `${TOKEN_PATH}?state=${encodeURIComponent(id)}`, {}, [CODE_TOKEN_NOT_READY])
        if (!token?.accessToken) return { type: "failed", error: `${site.name} gave no token` }
        const a = merge({}, token)
        const who = await poll(
          site,
          `${ACCOUNT_PATH}?state=${encodeURIComponent(id)}`,
          {
            Authorization: "Bearer " + a.access,
            "X-Domain": domainOf(site, a),
            "X-No-User-Id": "true",
            "X-No-Enterprise-Id": "true",
          },
          [CODE_ACCOUNT_NOT_READY],
        )
        a.uid = who?.uid ?? ""
        a.enterpriseId = typeof who?.enterpriseId === "string" ? who.enterpriseId.trim() : ""
        return success(site, a, who?.nickname || who?.phoneNumber || who?.uid)
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      }
    },
  }
}

/**
 * 轮询一个还没就绪的登录步骤。
 *
 * 两个「还没好」的码要区别对待：`11217`（token 未签发）与 `12151`（账号信息
 * 未就绪）都是**继续等**，而不是失败；超时才是失败。空 `data` 也算未就绪
 * —— 实测该接口在就绪前会回 HTTP 200 + `data: null`。
 */
async function poll(site, path, headers, retry) {
  const deadline = Date.now() + SIGN_IN_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`${site.name} sign-in timed out`)
    await sleep(POLL_MS)
    try {
      const data = await call(site, "GET", path, { "User-Agent": uaOf(site, "") + "", ...headers })
      if (data && Object.keys(data).length > 0) return data
    } catch (e) {
      const code = Number(e?.code)
      const transient = retry.includes(code) || e?.status === 408 || e?.status === 429
      if (!transient) throw e
    }
  }
}

const TOKEN_FIELDS = ["access", "refresh", "expires", "refreshExpiresAt", "domain", "tokenType"]

/** token 应答 → 登录态：时间是绝对/相对两种形态，都要收。 */
function merge(a, got) {
  const now = Date.now()
  const out = { ...a }
  if (typeof got.accessToken === "string" && got.accessToken) out.access = got.accessToken
  if (typeof got.refreshToken === "string" && got.refreshToken) out.refresh = got.refreshToken
  out.expires = got.expiresAt > 0 ? got.expiresAt : got.expiresIn > 0 ? now + got.expiresIn * 1000 : (a.expires ?? 0)
  out.refreshExpiresAt = got.refreshExpiresAt > 0
    ? got.refreshExpiresAt
    : got.refreshExpiresIn > 0
      ? now + got.refreshExpiresIn * 1000
      : (a.refreshExpiresAt ?? 0)
  if (typeof got.domain === "string" && got.domain) out.domain = got.domain
  if (typeof got.tokenType === "string" && got.tokenType) out.tokenType = got.tokenType
  return out
}

const success = (site, a, name) => ({
  type: "success",
  refresh: a.refresh ?? "",
  access: a.access,
  expires: a.expires ?? 0,
  accountId: name || site.name,
  uid: a.uid ?? "",
  domain: a.domain ?? "",
  ...(a.enterpriseId ? { enterpriseId: a.enterpriseId } : {}),
  ...(a.refreshExpiresAt > 0 ? { refreshExpiresAt: a.refreshExpiresAt } : {}),
  ...(a.tokenType ? { tokenType: a.tokenType } : {}),
})

// ---- 续期 ------------------------------------------------------------------

/**
 * 刷新 access token。
 *
 * 401/403、或消息里含 expired / invalid 是**终态**（refresh token 已作废），
 * 必须抛带 `signIn: "expired"` 的错误让 magpie 要求重新登录；别的失败
 * （网络、5xx）是可重试的。这个区分来自 Veyra `buddy-oauth.ts` 的实测：
 * 把可重试错误也当终态会让一次网络抖动废掉整个账号。
 */
async function renewal(site, a) {
  if (!a.refresh) {
    const e = new Error(`${site.name} gave no refresh token; sign in again`)
    e.signIn = "expired"
    throw e
  }
  const res = await fetch(site.endpoint + REFRESH_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": uaOf(site, ""),
      Authorization: "Bearer " + a.access,
      "X-Refresh-Token": a.refresh,
      "X-Auth-Refresh-Source": "plugin",
      "X-Domain": domainOf(site, a),
      ...enterpriseHeaders(a),
    },
    body: "{}",
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const code = Number(env?.code)
    const said = String(env?.msg ?? env?.message ?? "")
    const expired = res.status === 401 || res.status === 403 || code === 401 || code === 403
      || said.includes("expired") || said.includes("invalid")
    const e = new Error(`${site.name}: ${said || `HTTP ${res.status}`}`)
    e.signIn = expired ? "expired" : "kept"
    throw e
  }
  const code = Number(env?.code)
  if (code) throw new Error(`${site.name}: ${env?.msg ?? "error"} (${code})`)
  if (!env?.data?.accessToken) throw new Error(`${site.name} gave no token to renew with`)
  return merge(a, env.data)
}

/** 续期去重：同一 refresh token 只换一次，两个并发触发的后来者拿同一个结果。 */
function renewerFor(site) {
  const running = new Map()
  const done = new Map()
  const merged = (a, next) => {
    const out = { ...a }
    for (const k of TOKEN_FIELDS) if (k in next) out[k] = next[k]
    return out
  }
  return async (a, persist) => {
    const key = a.refresh
    const hit = done.get(key)
    if (hit && Date.now() - hit.at < KEEP_RENEWED_MS) return merged(a, hit.next)
    let p = running.get(key)
    if (!p) {
      p = (async () => {
        const next = await renewal(site, a)
        done.set(key, { next, at: Date.now() })
        await persist?.(next)
        return next
      })().finally(() => running.delete(key))
      running.set(key, p)
    }
    return merged(a, await p)
  }
}

const stale = (a) => !!a.expires && Date.now() >= a.expires - EARLY_MS

// ---- 请求头 ----------------------------------------------------------------

/**
 * 挂上 CodeBuddy 的全部身份头。
 *
 * 为什么不能只发 `Authorization`：这套后端按**头**判身份，缺 `X-Domain`
 * 与 `X-Product-Code` 会被当成别的产品甚至被拒。三枚 `X-Conversation-*`
 * 在多数账号上不是必需，但在**特定账号**上是硬性准入（实测 2/5 与 3/5），
 * 且判据只是「三枚同时存在且非空」、不校验值；不带会得到
 * `11128 conversation id missing`。故一律带上。
 */
function sign(site, a, headers, model) {
  headers.delete("authorization")
  headers.delete("x-api-key")
  headers.set("Authorization", "Bearer " + a.access)
  headers.set("Accept", "text/event-stream")
  headers.set("Content-Type", "application/json")
  // `||` 而非 `??`：凭据里的 domain 缺失时是空串，`??` 不会回退。
  headers.set("X-Domain", site.apiDomain || a.domain || "")
  headers.set("X-Product-Code", site.productCode)
  headers.set("X-Agent-Purpose", "conversation")
  headers.set("X-IDE-Name", site.attribution)
  headers.set("X-IDE-Type", site.attribution)
  headers.set("X-IDE-Version", site.clientVersion)
  headers.set("X-Product", site.attribution)
  headers.set("User-Agent", uaOf(site, model))
  if (a.uid) headers.set("X-User-Id", a.uid)
  for (const [k, v] of Object.entries(enterpriseHeaders(a))) headers.set(k, v)
  const conv = hex()
  headers.set("X-Conversation-ID", conv)
  headers.set("X-Conversation-Request-ID", conv)
  headers.set("X-Conversation-Message-ID", conv)
}

// ---- 模型 ------------------------------------------------------------------

/** `/v3/config` 的一条模型记录 → 本插件的模型形状；不认识的字段一律不猜。 */
function parsed(record) {
  const id = String(record?.id ?? "").trim()
  if (!id) return null
  const efforts = Array.isArray(record?.reasoning?.supportedEfforts)
    ? record.reasoning.supportedEfforts.filter((e) => typeof e === "string" && e)
    : []
  return {
    id,
    name: String(record?.name ?? id),
    context: Number(record?.maxInputTokens) || 0,
    output: Number(record?.maxOutputTokens) || 0,
    images: record?.supportsImages === true,
    efforts,
    defaultEffort: typeof record?.reasoning?.defaultEffort === "string" ? record.reasoning.defaultEffort : undefined,
  }
}

/** 只收文本对话模型：`/v3/config` 里混着补全、行内建议、生图等非对话条目。 */
function chatModel(id) {
  if (/^(nes|completion|codewise)-/.test(id)) return false
  return id !== "auto" && id !== "default"
}

/**
 * 拉账号自己的模型清单。
 *
 * 只取 `agents[].name === "cli"` 的白名单：`/v3/config` 的 `data.models` 里
 * 有一批模型当前套餐调不通（`11102 service info not found`），列进选择器
 * 只会让用户选中后报错。白名单顺序就是 IDE 展示顺序。
 */
async function liveModels(site, a) {
  const headers = {
    Authorization: "Bearer " + a.access,
    Accept: "application/json",
    "User-Agent": `CLI/${APP_VERSION} ${uaOf(site, "")}`,
    "X-Domain": domainOf(site, a),
    "X-Product": site.attribution,
    "X-Product-Code": site.productCode,
    ...(a.uid ? { "X-User-Id": a.uid } : {}),
    ...enterpriseHeaders(a),
  }
  const res = await fetch(site.endpoint + CONFIG_PATH, {
    headers,
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`${site.name}: HTTP ${res.status}`)
  const env = await res.json()
  if (Number(env?.code)) throw new Error(`${site.name}: ${env?.msg ?? "error"} (${env.code})`)
  const cfg = env?.data ?? {}
  const detail = new Map()
  for (const m of Array.isArray(cfg.models) ? cfg.models : []) {
    const p = parsed(m)
    if (p) detail.set(p.id, p)
  }
  const out = []
  const seen = new Set()
  for (const agent of Array.isArray(cfg.agents) ? cfg.agents : []) {
    if (agent?.name !== "cli") continue
    for (const m of Array.isArray(agent.models) ? agent.models : []) {
      const id = String(m?.id ?? "").trim()
      if (!id || seen.has(id) || !chatModel(id)) continue
      seen.add(id)
      const d = detail.get(id)
      out.push({
        id,
        name: String(d?.name ?? m?.name ?? id),
        context: d?.context || Number(m?.maxInputTokens) || 0,
        output: d?.output || Number(m?.maxOutputTokens) || 0,
        images: d?.images ?? m?.supportsImages === true,
        efforts: d?.efforts?.length ? d.efforts : (Array.isArray(m?.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts : []),
        defaultEffort: d?.defaultEffort ?? m?.reasoning?.defaultEffort,
      })
    }
  }
  // 同名去重：`deepseek-v4.1-flash` 与 `-sg` 都叫 Deepseek-V4.1-Flash，
  // 选择器里两个同名条目无法区分，给后出现的加区域后缀。
  const taken = new Map()
  for (const m of out) {
    const n = taken.get(m.name)
    if (n === undefined) taken.set(m.name, 1)
    else {
      taken.set(m.name, n + 1)
      m.name = `${m.name} (${m.id.includes("-sg") ? "SG" : n + 1})`
    }
  }
  return out
}

// ---- 用量 ------------------------------------------------------------------

const capacity = (v) => {
  if (v == null || v === "") return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

/**
 * 账号的积分窗口。
 *
 * 口径取**本周期**（`CycleCapacity*`）而不是终身（`Capacity*`）：IDE 顶部
 * 显示的 "Credits Balance" 就是周期口径，用终身会让数字凭空多出上百
 * （实测同一账号 655.67 vs 155.67，差额正是那个本周期已耗尽的体验包）。
 *
 * 失效包（`Status === 3`、或 `ExpiredTime`/`DeductionEndTime` 已过）不计入。
 */
function usageOf(site, a, data) {
  const accounts = data?.Response?.Data?.Accounts
  if (!Array.isArray(accounts)) return { windows: [] }
  let total = 0
  let used = 0
  let soonest = 0
  const now = Date.now()
  for (const p of accounts) {
    if (Number(p?.Status) === 3) continue
    const end = capacity(p?.DeductionEndTime)
    if (end > 0 && now >= end) continue
    const t = capacity(p?.CycleCapacitySize)
    if (!(t > 0)) continue
    total += t
    used += capacity(p?.CycleCapacityUsed)
    if (end > now && (soonest === 0 || end < soonest)) soonest = end
  }
  if (!(total > 0)) return { windows: [] }
  return {
    plan: "CodeBuddy",
    windows: [
      {
        name: "Credits",
        used: (100 * used) / total,
        display: `${compact(used)} / ${compact(total)}`,
        amount: used,
        limit: total,
        unit: "credits",
        ...(soonest > 0 ? { runsOutAt: new Date(soonest).toISOString() } : {}),
      },
    ],
  }
}

const meter = async (site, a, path) => {
  const res = await fetch(site.endpoint + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": uaOf(site, ""),
      Authorization: "Bearer " + a.access,
      "X-Domain": domainOf(site, a),
      "X-Product": site.attribution,
      "X-Product-Code": site.productCode,
      ...(a.uid ? { "X-User-Id": a.uid } : {}),
      ...enterpriseHeaders(a),
    },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  })
  const env = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(env?.msg || `HTTP ${res.status}`)
  if (Number(env?.code)) throw new Error(env?.msg || `error ${env.code}`)
  return env?.data ?? null
}

// ---- 签到 ------------------------------------------------------------------

/**
 * 每日签到（只有中国版有）。
 *
 * 必须用 `checkin-activity-status`，不能用 `checkin-status`：后者返回占位
 * 数据（`active:false`、`checkin_dates:null`），会让人误判成「活动没开」。
 * 重复领取回 HTTP 400 + `code 10001`「今天已签到」，按已领取处理而不是失败。
 */
async function checkin(site, a) {
  if (!site.checkin) return { outcome: "ineligible", message: `${site.name} has no daily check-in` }
  let status
  try {
    status = await meter(site, a, CHECKIN_STATUS_PATH)
  } catch (e) {
    return { outcome: "failed", message: e?.message ?? String(e) }
  }
  if (!status?.active) return { outcome: "inactive", message: status?.activity_name ?? `${site.name} has no check-in running` }
  if (status.today_checked_in) return { outcome: "done", message: "already checked in today" }
  try {
    const got = await meter(site, a, CHECKIN_PATH)
    const n = capacity(got?.credit)
    return { outcome: "claimed", message: `claimed ${compact(n)} credits`, ...(n > 0 ? { credit: n } : {}) }
  } catch (e) {
    if (Number(e?.code) === CODE_ALREADY_CLAIMED || /already|已签到/.test(String(e?.message))) {
      return { outcome: "done", message: "already checked in today" }
    }
    return { outcome: "failed", message: e?.message ?? String(e) }
  }
}

// ---- 插件 ------------------------------------------------------------------

function makePlugin(site) {
  const renew = renewerFor(site)
  const tokens = (a) => {
    const out = { ...a }
    delete out.type
    return out
  }
  return async () => ({
    config: async (config) => {
      config.provider ??= {}
      config.provider[site.id] ??= {}
      const p = config.provider[site.id]
      p.name ??= site.name
      p.npm ??= NPM
      p.api ??= api(site)
      const models = {}
      for (const [id, name, context, efforts, images, extra] of site.models) {
        models[id] = { name, limit: { context, output: 0 }, tool_call: true, attachment: !!images }
        if (efforts?.length) {
          models[id].reasoning = true
          models[id].variants = Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }]))
        }
        void extra
      }
      p.models = { ...models, ...(p.models ?? {}) }
    },
    provider: {
      id: site.id,
      async models(provider, { auth }) {
        if (auth?.type !== "oauth" || !auth.access) return provider.models
        try {
          const fresh = stale(auth) ? await renew(tokens(auth)) : tokens(auth)
          const ms = await liveModels(site, fresh)
          if (!ms.length) return provider.models
          return Object.fromEntries(
            ms.map((m) => [
              m.id,
              {
                id: m.id,
                providerID: site.id,
                name: m.name,
                api: { id: m.id, url: api(site), npm: NPM },
                status: "active",
                headers: {},
                options: {},
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: m.context || 0, output: m.output || 0 },
                capabilities: {
                  temperature: true,
                  reasoning: !!m.efforts?.length,
                  attachment: !!m.images,
                  toolcall: true,
                  input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
                  output: { text: true, image: false, audio: false, video: false, pdf: false },
                  interleaved: false,
                },
                release_date: "",
                ...(m.efforts?.length
                  ? { variants: Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }])) }
                  : {}),
                ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
                free: false,
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
      provider: site.id,
      refreshLead: LEAD_MS,
      refresh: (auth) => renew(tokens(auth)),
      async loader(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth") return {}
        return {
          baseURL: api(site),
          apiKey: "",
          async fetch(input, init) {
            let cred = await getAuth()
            if (cred?.type !== "oauth") throw new Error(`${site.name} isn't signed in`)
            const req = input instanceof Request ? input : null
            const body = init?.body ?? (req ? await req.clone().text() : undefined)
            let model
            try {
              model = JSON.parse(String(body ?? "")).model
            } catch {}
            if (stale(cred)) cred = { ...cred, ...(await renew(tokens(cred))) }
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("content-length")
            sign(site, cred, headers, model)
            const res = await fetch(req ? req.url : input, {
              ...init,
              method: init?.method ?? req?.method,
              headers,
              body,
            })
            // 4xx 里既有「凭据过期」也有「这次请求不合规」。后者打 kept，
            // 否则 magpie 会把账号标成失效并要求重新登录。
            if (res.status === 401 || res.status === 403) return res
            if (res.status >= 400) return explained(res, `${site.name} refused this request`)
            return kept(res)
          },
        }
      },
      methods: [{ type: "oauth", label: `${site.name} account (browser)`, authorize: () => browserSignIn(site) }],
      usage: async (getAuth) => {
        const a = await getAuth()
        if (a?.type !== "oauth" || !a.access) return { error: "not signed in", signIn: "kept" }
        try {
          const fresh = stale(a) ? await renew(tokens(a)) : tokens(a)
          return { ...usageOf(site, fresh, await meter(site, fresh, METER_PATH)), signIn: "kept" }
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },
      ...(site.checkin
        ? {
            checkin: async (getAuth) => {
              const a = await getAuth()
              if (a?.type !== "oauth" || !a.access) return { outcome: "inactive", message: "not signed in" }
              try {
                const fresh = stale(a) ? await renew(tokens(a)) : tokens(a)
                return await checkin(site, fresh)
              } catch (e) {
                return { outcome: "failed", message: e?.message ?? String(e) }
              }
            },
          }
        : {}),
    },
  })
}

export const CodeBuddyPlugin = makePlugin(SITES[0])
export const CodeBuddyIntlPlugin = makePlugin(SITES[1])

export const _internal = {
  SITES,
  CN_MODELS,
  INTL_MODELS,
  api,
  uaOf,
  merge,
  success,
  usageOf,
  parsed,
  chatModel,
  makePlugin,
  browserSignIn,
}
