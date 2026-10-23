/**
 * 讯飞 Loomy（`loomy`）：magpie 里完全没有的一家。
 *
 * 会话协议是标准 OpenAI Chat（SSE 直接可用 `@ai-sdk/openai-compatible`），
 * 复杂的是它之外的三件事 —— 而这三件恰好都是「看起来能猜、实际一猜就错」的：
 *
 * 1. **两套认证头**：`/chat/completions` 只认 `Authorization: Bearer`，
 *    `/models`、`/points/*`、`/onboarding/*` 只认小写 `token`。带错不是 401，
 *    而是 **HTTP 200 + `{"code":"100002","desc":"缺少 token"}`** —— 所以业务
 *    端点永远先看 body 的 `code`，状态码只用来区分网络层。
 * 2. **登录是短信两步**，没有 refresh 端点。凭据就是那次登录给的 session
 *    （声明 14 天），故本 provider **不声明 `refresh`**：诚实标记成「不可续期」，
 *    而不是挂一个永远失败的续期函数。
 * 3. **积分是两个池**：永久池与每日赠送池。每日额度靠 `POST /points/first-login`
 *    「重置」，语义不是「+5000」，重复调用返回 `alreadyProcessed: true`。
 *
 * 协议来源：Veyra 的 `src/loomy.ts`（信封/头/模型过滤）、`src/loomy-sign.ts`
 * （HMAC-SHA1）、`src/loomy-oauth.ts`（短信两步）、`src/loomy-product.ts`
 * （模型表与两张能力覆盖表）、`src/loomy-credits.ts`（两个池与签到）。
 */

import { createHash, createHmac, randomUUID } from "node:crypto"

import { kept, explained, NPM } from "./kit.mjs"
import { LOOMY_ICON } from "./icons.mjs"

// ---- 常量 --------------------------------------------------------------------

const API_BASE = "https://loomyad.xunfei.cn/api/v1"
const ACCOUNT_BASE = "https://account.xfinfr.com"

/** 账号端点的签名材料（取自官方客户端打包的 `.env.prod`）。 */
const ACCESS_KEY_ID = "2thryby66wxi53sk"
const ACCESS_KEY_SECRET = "zsak6eadrbawz683wf5r3m2snrwj868r"
const APP_ID = "GM3LOOMY"

const OK_CODE = "000000"
const REQUEST_TIMEOUT_MS = 60_000
const SMS_TTL_SECONDS = 300
const SESSION_TTL_SECONDS = 1_209_600

/** 思考档位（远端 `reasoning_efforts` 实测就是这五档，**含 `none`**）。 */
const EFFORTS = ["none", "low", "medium", "high", "xhigh"]
const DEFAULT_EFFORT = "high"

const MAX_OUTPUT_TOKENS = 65_536

/**
 * 兜底模型表：`[id, name, context, images]`。
 *
 * 名字里的倍率用 `· x` 分隔（与 Veyra 的规范化形态一致），`nameOf` 会把它
 * 拼成展示名 —— composer 的模型菜单只渲染 `name`，倍率放 `description` 看不见。
 */
const FALLBACK_MODELS = [
  ["deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731", 1_048_576, false, "x3.0"],
  ["MiniMax-M3", "MiniMax M3", 1_048_576, false, "x4.0"],
  ["Kimi-k2.6", "Kimi k2.6", 262_144, true, "x6.5"],
  ["qwen-3.8-max", "Qwen 3.8 Max", 1_000_000, true, "x12.0"],
  ["GLM-5.3-Flash", "GLM 5.3 Flash", 1_048_576, true, "x0.8"],
  ["qwen3.8-flash", "qwen 3.8 flash", 1_000_000, true, "x0.8"],
  ["spark-x", "Spark X2.5", 262_144, false, "x0.1"],
  ["mimo-v2.5", "MiMo V2.5", 1_048_576, true, "x3.3"],
]

/**
 * 上下文窗口覆盖：`spark-x` 远端虚报 1_048_576，官方客户端本地表与上游墙位
 * 都是 262_144。键必须**小写** —— 查表走 `catalogKey()` 归一。
 */
const CONTEXT_OVERRIDES = { "spark-x": 262_144 }

/**
 * 图片能力覆盖：远端对 `qwen-3.8-max` 报 `input_modalities = ['text']`，
 * 但实测能读图（随机纯色 PNG 判据，两轮 4/5 命中，含 RGB 三元组）。
 *
 * ⚠️ 只登记**实测确认**的个案。绝不改成「该家恒支持图片」：将来上架纯文本
 * 模型时恒 true 会把图放行，让上游回一个更晚、更难懂的 400。
 * ⚠️ 反向也刻意不动：`MiniMax-M3` 声明 image 但 4/4 未命中（疑似在编），
 * 单账号证据不足以降级一个已声明能力，按已知缺陷记录在案。
 */
const IMAGE_OVERRIDES = new Set(["qwen-3.8-max"])

// ---- 小工具 ------------------------------------------------------------------

const catalogKey = (id) => String(id ?? "").trim().toLowerCase()
const isImage = (id, declared) => IMAGE_OVERRIDES.has(catalogKey(id)) || declared
const windowOf = (id, declared) => CONTEXT_OVERRIDES[catalogKey(id)] ?? declared

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

/**
 * 从展示名里剥出末尾倍率，认三种写法（远端全角半角混用）。
 *
 * 只认**末尾**的倍率 —— 名字中间括号是模型名的一部分。
 */
function splitRate(raw) {
  const original = String(raw ?? "").trim()
  if (!original) return { name: "", rate: "" }
  for (const re of [/^(.*?)\s*[（(]\s*(x\s*[\d.]+)\s*[)）]\s*$/i, /^(.*?)\s*·\s*(x\s*[\d.]+)\s*$/i]) {
    const m = re.exec(original)
    if (!m) continue
    const name = String(m[1] ?? "").trim()
    if (name) return { name, rate: String(m[2]).replace(/\s+/g, "").toLowerCase() }
  }
  return { name: original, rate: "" }
}

/** 展示名：`MiniMax M3 · x4.0`；无倍率时不追加孤立分隔符。 */
const displayName = (raw) => {
  const { name, rate } = splitRate(raw)
  return rate ? `${name} · ${rate}` : name
}

// ---- 账号端点：HMAC-SHA1 签名 ------------------------------------------------

/**
 * 讯飞账号（CAccount）签名，逐字节复刻官方客户端 `electron/xfyun/sign.js`。
 *
 * 待签串九段，**后两段恒为空**（我们不发 `x-*` 头）⇒ 最终字符串以 `\n\n`
 * 结尾。这是 `join('\n')` 在九个元素上的自然结果，**不要顺手去掉尾随换行**：
 * 去掉会让签名不匹配，而失败形态是「鉴权失败」而非格式错误。
 *
 * ⚠️ 认证前缀是 `account`，不是 `Bearer`。
 * ⚠️ body 必须**序列化一次**，签名与发送共用同一字符串 —— 二次序列化改变
 * 键序/空格即改变字节，签名随即失效。
 */
function accountHeaders(path, bodyText) {
  const escape = (v) =>
    encodeURIComponent(v)
      .replace(/!/g, "%21")
      .replace(/'/g, "%27")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\*/g, "%2A")

  let clean = path.startsWith("/") ? path : `/${path}`
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1)
  const escapedPath = clean.split("/").map((seg) => (seg ? escape(seg) : "")).join("/")

  const md5 = bodyText.length ? createHash("md5").update(bodyText, "utf8").digest("base64") : ""
  const date = new Date().toUTCString()
  const nonce = randomUUID()
  const contentType = "application/json"

  const stringToSign = ["POST", escapedPath, "", md5, contentType, date, nonce, "", ""].join("\n")
  const signature = createHmac("sha1", ACCESS_KEY_SECRET).update(stringToSign, "utf8").digest("base64")

  const headers = {
    Authorization: `account ${ACCESS_KEY_ID}:${signature}`,
    Date: date,
    Nonce: nonce,
    "Content-Type": contentType,
  }
  if (md5) headers["Content-MD5"] = md5
  return headers
}

/**
 * 拆业务信封。
 *
 * ⚠️ 业务失败**恒返回 HTTP 200**，成败只读 body 的 `code`。只看状态码会把
 * 「登录已失效」误判成成功。
 */
function envelopeOf(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, message: "响应不是 JSON 对象" }
  }
  const code = typeof payload.code === "string" ? payload.code : ""
  const message =
    typeof payload.desc === "string" && payload.desc ? payload.desc
      : typeof payload.message === "string" ? payload.message : ""
  if (code !== OK_CODE) {
    return { ok: false, code, message: message || `业务错误 ${code || "(缺少 code)"}` }
  }
  return { ok: true, data: payload.data }
}

/**
 * 账号端点：`{appid, modelid, version, devid, ua, traceid}` 的信封。
 *
 * ⚠️ `ua` 硬编码 `macOS`：官方客户端在 Windows 上发的也是这个值，照抄不要改。
 */
const accountBody = (param) => ({
  base: {
    appid: APP_ID,
    modelid: "Web",
    version: "1.0.0",
    devid: "web",
    ua: "Loomy|Desktop|Electron|macOS",
    traceid: randomUUID().replace(/-/g, ""),
  },
  param,
})

async function postAccount(path, param) {
  const body = JSON.stringify(accountBody(param))
  let res
  try {
    res = await fetch(`${ACCOUNT_BASE}${path}`, {
      method: "POST",
      headers: accountHeaders(path, body),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`讯飞账号请求失败（${path}）：${e?.message ?? e}`)
  }
  let parsed
  try {
    parsed = await res.json()
  } catch {
    throw new Error(`讯飞账号响应不是 JSON（${path}，HTTP ${res.status}）`)
  }
  const env = envelopeOf(parsed)
  if (!env.ok) throw new Error(env.message)
  return env.data ?? {}
}

// ---- 业务端点：`token` 头 ----------------------------------------------------

/** 业务端点请求头：**只认小写 `token`**，带 `Authorization: Bearer` 会被判「缺少 token」。 */
const businessHeaders = (token) => ({ Accept: "application/json", token })

/** chat 端点请求头：`Authorization: Bearer` 必需（**前缀必需**，无前缀同样 100002），两个都发。 */
const chatHeaders = (token) => ({
  Accept: "text/event-stream",
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
  token,
})

/**
 * 发一次业务请求。
 *
 * 返回 `{ok, data}` 或 `{ok:false, message}`：调用方要如实呈现失败原因，
 * 故错误里保留服务端的 `desc`（例如凭据失效就是 `100002 缺少 token`）。
 */
async function call(token, path, { method = "GET", body } = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body)
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: businessHeaders(token),
      ...(text === undefined ? {} : { body: text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, message: e?.message ?? String(e) }
  }
  let parsed
  try {
    parsed = await res.json()
  } catch {
    return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` }
  }
  const env = envelopeOf(parsed)
  if (!env.ok) return { ok: false, message: env.message }
  return { ok: true, data: env.data }
}

// ---- 登录：短信两步 ----------------------------------------------------------

/** 手机号 → 上一次下发验证码拿到的 `msgid`（进程内缓存，不落盘）。 */
const msgids = new Map()

async function sendCode(phone) {
  const data = await postAccount("/login/phone/sendMsgCode", { ccode: "86", phone, expire: SMS_TTL_SECONDS })
  const msgid = typeof data?.msgid === "string" ? data.msgid : ""
  // 不返回空串：上层会拿它去登录，服务端必然报「msgid 无效」，用户看到的将是
  // 一个与真实原因（发码失败）无关的错误。
  if (!msgid) throw new Error("短信验证码响应缺少 msgid")
  msgids.set(phone, msgid)
  return msgid
}

async function loginByCode(phone, code, msgid) {
  const data = await postAccount("/login/phone/checkCode", {
    ccode: "86",
    phone,
    mcode: code,
    msgid,
    expire: SESSION_TTL_SECONDS,
  })
  const session = typeof data?.session === "string" ? data.session : ""
  const userid = typeof data?.userid === "string" ? data.userid : ""
  if (!session) throw new Error("登录响应缺少 session")
  if (!userid) throw new Error("登录响应缺少 userid")
  return { session, userid }
}

// ---- 凭据 --------------------------------------------------------------------

const pack = (c) => JSON.stringify(c)

const unpack = (s) => {
  try {
    const c = JSON.parse(String(s ?? ""))
    return c && typeof c === "object" ? c : null
  } catch {
    return null
  }
}

const tokenOf = (a) => {
  const c = unpack(a?.access)
  return typeof c?.session === "string" ? c.session : ""
}

// ---- 模型 --------------------------------------------------------------------

/**
 * 拉远端模型目录。
 *
 * 判据是 `type === 'chat'` —— **不要**改用 `output_modalities`：实测 5 个 chat
 * 模型的 `input_modalities` 含 `image`（能看图），那是输入多模态，与「是不是
 * 生图模型」无关。
 */
async function liveModels(token) {
  const got = await call(token, "/models")
  if (!got.ok) return []
  const list = Array.isArray(got.data) ? got.data : Array.isArray(got.data?.data) ? got.data.data : null
  if (!list) return []
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue
    const id = typeof item.id === "string" ? item.id.trim() : ""
    if (!id || item.type !== "chat" || seen.has(id)) continue
    seen.add(id)
    const declared = Array.isArray(item.capabilities?.input_modalities)
      ? item.capabilities.input_modalities.some((m) => String(m).toLowerCase() === "image")
      : false
    const efforts = Array.isArray(item.reasoning_efforts) && item.reasoning_efforts.length
      ? item.reasoning_efforts.filter((e) => typeof e === "string")
      : item.capabilities?.reasoning === true
        ? [...EFFORTS]
        : []
    out.push({
      id,
      name: displayName(typeof item.name === "string" && item.name ? item.name : id),
      context: windowOf(id, num(item.context_length) ?? 0),
      images: isImage(id, declared),
      efforts,
      // 远端声明的 `default_reasoning_effort` 实测是 `low`，而产品实际按 `high`
      // 起步；Veyra 也刻意不采信它，这里保持一致。
      defaultEffort: efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : efforts[0],
    })
  }
  return out
}

// ---- 用量与签到 --------------------------------------------------------------

/** 两个池各一个窗口：`availableBalance` 是两者之和，权限归零时不重复计。 */
function usageOf(data) {
  if (!data || typeof data !== "object") return { windows: [] }
  const permanent = num(data.balance)
  const daily = num(data.dailyBalance) ?? 0
  const available = num(data.availableBalance)
  // 两个池**都读不到**才算查询失败；只缺一个时按 0 宽容处理（选号口径会看
  // daily，若因缺 balance 就判失败，一个今日额度可用的号会被静默踢出候选）。
  if (permanent === undefined && num(data.dailyBalance) === undefined) return { windows: [] }
  const windows = [
    { name: "Daily credits", used: 0, display: `${compact(daily)} credits`, amount: daily, unit: "credit" },
  ]
  if (permanent !== undefined) {
    windows.unshift({
      name: "Permanent credits",
      used: 0,
      display: `${compact(permanent)} credits`,
      amount: permanent,
      unit: "credit",
    })
  }
  const total = available ?? (permanent ?? 0) + daily
  return { plan: "Loomy", windows, ...(total > 0 ? { balance: total } : {}) }
}

// ---- 请求体改造 --------------------------------------------------------------

/**
 * 把 Chat 请求体改成 Loomy 认的形态。
 *
 * `reasoning_effort` **只在模型确实声明了该档位时才发**：远端对未知字段是
 * 静默忽略（传 `reasoning_effort` / `reasoningEffort` / `thinking` 三种名字
 * 都回 200），所以「发了没生效」不会被任何错误暴露出来 —— 唯一可靠的做法
 * 是给一个它自己声明过的值。
 */
function shape(bodyText, model) {
  let b
  try {
    b = JSON.parse(bodyText)
  } catch {
    return { text: bodyText, stream: true }
  }
  if (!b || typeof b !== "object") return { text: bodyText, stream: true }
  const wantsStream = b.stream !== false
  b.stream = true
  if (b.max_tokens === undefined || !(b.max_tokens > 0) || b.max_tokens > MAX_OUTPUT_TOKENS) {
    if (b.max_tokens === undefined) delete b.max_tokens
    else b.max_tokens = MAX_OUTPUT_TOKENS
  }
  const effort = typeof b.reasoning_effort === "string" ? b.reasoning_effort.trim().toLowerCase() : ""
  if (effort && !(model?.efforts ?? []).includes(effort)) delete b.reasoning_effort
  return { text: JSON.stringify(b), stream: wantsStream }
}

/** 把一段标准 SSE 折成一个 `chat.completion`（非流式客户端用）。 */
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
      return new Response(
        JSON.stringify({ error: { message: String(frame.error?.message ?? "upstream error"), type: "upstream_error" } }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      )
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
      id: id || `chatcmpl-${randomUUID().replace(/-/g, "")}`,
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

export const PROVIDER = "loomy"

export default async function LoomyPlugin() {
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER] ??= {}
      const p = config.provider[PROVIDER]
      p.name ??= "Loomy"
      p.npm ??= NPM
      p.api ??= API_BASE
      const models = {}
      for (const [id, name, context, images, rate] of FALLBACK_MODELS) {
        models[id] = {
          name: rate ? `${name} · ${rate}` : name,
          limit: { context: windowOf(id, context), output: 0 },
          tool_call: true,
          attachment: isImage(id, images),
          reasoning: true,
          variants: Object.fromEntries(EFFORTS.map((e) => [e, { reasoningEffort: e }])),
        }
      }
      // 用户自己的配置优先。
      p.models = { ...models, ...(p.models ?? {}) }
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth }) {
        const token = tokenOf(auth)
        if (auth?.type !== "oauth" || !token) return provider.models
        try {
          const list = await liveModels(token)
          if (!list.length) return provider.models
          return Object.fromEntries(
            list.map((m) => [
              m.id,
              {
                id: m.id,
                providerID: PROVIDER,
                name: m.name,
                api: { id: m.id, url: API_BASE, npm: NPM },
                status: "active",
                headers: {},
                options: {},
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: m.context || 0, output: MAX_OUTPUT_TOKENS },
                capabilities: {
                  temperature: true,
                  reasoning: m.efforts.length > 0,
                  attachment: m.images,
                  toolcall: true,
                  input: { text: true, image: m.images, audio: false, video: false, pdf: false },
                  output: { text: true, image: false, audio: false, video: false, pdf: false },
                  interleaved: false,
                },
                release_date: "",
                ...(m.efforts.length
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
      provider: PROVIDER,
      /** Providers 页这一行的图标；缺了会回落到 Veyra 的蓝 V。见 `icons/loomy.svg`。 */
      icon: LOOMY_ICON,

      async loader(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth") return {}
        return {
          baseURL: API_BASE,
          apiKey: "",
          async fetch(input, init) {
            const cred = await getAuth()
            const token = tokenOf(cred)
            if (cred?.type !== "oauth" || !token) throw new Error("Loomy isn't signed in")

            const req = input instanceof Request ? input : null
            const body = init?.body ?? (req ? await req.clone().text() : "")
            let model = ""
            try {
              model = String(JSON.parse(String(body ?? "")).model ?? "")
            } catch {}
            const shaped = shape(body, { efforts: EFFORTS })

            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("content-length")
            headers.delete("authorization")
            for (const [k, v] of Object.entries(chatHeaders(token))) headers.set(k, v)

            const res = await fetch(`${API_BASE}/chat/completions`, {
              ...init,
              method: init?.method ?? req?.method ?? "POST",
              headers,
              body: shaped.text,
            })
            // 401/403 才是真的凭据问题；其余 4xx 是「这次请求不合规」，打 kept
            // 否则 magpie 会把账号标成失效并要求重新登录。
            if (res.status === 401 || res.status === 403) return res
            if (res.status >= 400) return explained(res, "Loomy refused this request")
            const out = shaped.stream ? res : await unstream(res, model)
            return kept(out)
          },
        }
      },

      /**
       * 短信验证码登录，`ask` 逐问推进：问手机号 → 当场发码 → 问验证码。
       *
       * 用 `oauth` 而非 `api` 方法：`api` 方法在 GUI 里会先弹一个「API key」输入框，
       * 而这里用户手上没有任何 key。`oauth` + 自己的 `callback()` 是唯一在 GUI 与
       * CLI 下行为一致的形状 —— 且不需要开浏览器（`url` 留空，`method: "auto"`）。
       */
      methods: [
        {
          type: "oauth",
          label: "Loomy account (phone code)",
          async ask(inputs) {
            if (!inputs.phone) {
              return {
                type: "text",
                key: "phone",
                message: "Phone number that receives the code",
                placeholder: "13800138000",
              }
            }
            if (!inputs.code) {
              // 发码放在「问验证码」之前 —— 用户拿到提示时短信应当已经在路上。
              try {
                await sendCode(inputs.phone)
              } catch (e) {
                throw new Error(e?.message ?? String(e))
              }
              return { type: "text", key: "code", message: "The code Loomy texted you", placeholder: "123456" }
            }
            return null
          },
          authorize(inputs) {
            return {
              url: "",
              instructions: "Enter the code Loomy texts you.",
              method: "auto",
              async callback() {
                const phone = String(inputs?.phone ?? "").trim()
                const code = String(inputs?.code ?? "").trim()
                if (!phone || !code) return { type: "failed", error: "the phone number and code are both needed" }
                // 进程重启或用户重开会话时 msgid 可能不在；补发一次再换。
                let msgid = msgids.get(phone)
                if (!msgid) msgid = await sendCode(phone)
                const { session, userid } = await loginByCode(phone, code, msgid)
                msgids.delete(phone)
                const expires = Date.now() + SESSION_TTL_SECONDS * 1000
                return {
                  type: "success",
                  // 无 refresh 端点 ⇒ 只存 access，不声明 refresh（见 `isRefreshable` 的注释）。
                  access: pack({ session, userid, phone, expires }),
                  expires,
                  accountId: phone,
                }
              },
            }
          },
        },
      ],

      usage: async (getAuth) => {
        const token = tokenOf(await getAuth())
        if (!token) return { error: "not signed in", signIn: "kept" }
        // 用 `points/records` 而不是 `first-login`：后者是**写**端点，
        // 在「打开面板」这种高频路径上调用会意外触发签到。
        const got = await call(token, "/points/records?pageNo=1&pageSize=1&recordType=all")
        if (!got.ok) return { error: got.message, signIn: "kept" }
        return { ...usageOf(got.data), signIn: "kept" }
      },

      /**
       * 签到：语义是**触发每日额度重置**，不是「+5000 积分」。
       *
       * 幂等判据是响应体的 `alreadyProcessed`（重复调用同样 HTTP 200），
       * 故已处理映射成 `done`（= 今天已经领过）而不是 `claimed` —— 后者会让
       * 用户以为每天都真的加了额度。
       */
      checkin: async (getAuth) => {
        const token = tokenOf(await getAuth())
        if (!token) return { outcome: "inactive", message: "not signed in" }
        const got = await call(token, "/points/first-login", { method: "POST", body: {} })
        if (!got.ok) return { outcome: "failed", message: got.message }
        const quota = num(got.data?.dailyQuota)
        const balance = num(got.data?.dailyBalance) ?? 0
        if (got.data?.alreadyProcessed === true) {
          return {
            outcome: "done",
            message: quota === undefined ? "每日额度已初始化" : `今日额度已初始化（${balance}/${quota}）`,
          }
        }
        const consumed = num(got.data?.dailyConsumed)
        const granted = quota !== undefined && consumed !== undefined ? Math.max(0, quota - consumed) : (quota ?? 0)
        return { outcome: "claimed", message: `每日额度 ${balance}/${quota ?? granted}`, credit: granted }
      },
    },
  }
}

export const _internal = {
  API_BASE,
  ACCOUNT_BASE,
  EFFORTS,
  FALLBACK_MODELS,
  FALLBACK_BY_ID: new Map(FALLBACK_MODELS.map(([id, name, context, images, rate]) => [id, { id, name, context, images, rate }])),
  splitRate,
  displayName,
  isImage,
  windowOf,
  accountHeaders,
  envelopeOf,
  accountBody,
  usageOf,
  shape,
  unstream,
}
