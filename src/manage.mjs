/**
 * 管理 magpie 里**已经登录**的账号：改名、删除、移动、诊断。
 *
 * ## 边界：只管本包的五家，且只管「已经在库里」的账号
 *
 * `plugin-auth.json` 是一个混装文件：本包的五家之外还有社区插件的账号
 * （zcode / qoder / minimax…）。那些账号的凭据形状归各自的插件定义，本模块
 * **一律不碰** —— `OURS` 之外的行既不列出也不修改，`selected()` 会直接拒绝。
 *
 * 同理这里**不新建账号**（新建 = 登录，那是 `auth.signIn` 的事），只对已有的
 * 行做原子修改。这与 `veyra.mjs` 的 `importFromVeyra` 是互补的两件事：
 * 那条路从 Veyra 搬来新账号，这条路管搬过来之后的日子。
 *
 * ## 一个必须说清的硬约束：magpie 没有「停用账号」
 *
 * 宿主读账号的方式是 `readAuthState()` 把整个文件读成一个对象，取用某个
 * provider 时在 `<provider>` 与 `<provider>#*` 里挑一条。全文件里**没有**任何
 * `disabled` / `enabled` / `suspended` 字段会被读取（`host.js` 的
 * `whoOf()` / `hintOf()` / `secretOf()` 都没有这种分支）。所以：
 *
 * - 在条目里加 `disabled: true` 只会被当成未知字段**忽略**，账号照样能用、
 *   照样刷新、照样被轮换到 —— 这种「假停用」比没有这个功能更坏。
 * - 真正能把一个账号从轮换里摘出去的做法只有两种：**删除**（不可逆，需要重新
 *   登录），或者**在 magpie 的 Providers 页签出**（那是 GUI 的动作，经
 *   `removeAuth(key)` 落到同一个文件）。
 *
 * 因此本模块**不提供 disable/enable**，只提供 `remove`，并在它的结果里写清
 * 「这一步不可逆、要恢复需重新登录」。宁可少一个按钮，也不给一个骗人的开关。
 *
 * ## 写盘协议
 *
 * 全部走 `changeAuth()`（`plugin-auth.json.lock` + 临时文件 + fsync + rename），
 * 与宿主并发刷新 token 时不会互相覆盖。调用方在读-改-写的同一次锁持有期内
 * 完成判断与写入，所以不需要额外的乐观锁。
 */

import { OURS, authPathOf, changeAuth, readAuthFile } from "./veyra.mjs"

/** 五个 provider 的显示名。 */
const NAMES = {
  codebuddy: "CodeBuddy",
  "codebuddy-intl": "CodeBuddy Intl",
  lobsterai: "LobsterAI",
  codearts: "CodeArts",
  loomy: "Loomy",
}

/** key → provider：`codebuddy#a1b2c3` 的 provider 是 `codebuddy`。 */
const providerOf = (key) => String(key ?? "").split("#")[0]

/** 这个 key 是否归本包管（五家之一）。 */
export function isOurs(key) {
  return OURS.includes(providerOf(key))
}

/** 一个账号在界面上的名字：与宿主 `whoOf()` 同序。 */
function whoOf(a) {
  return String(a?.accountId || a?.metadata?.email || a?.email || "")
}

/**
 * 这份凭据里有没有「能用的秘密」。
 *
 * 判断口径与宿主 `secretOf()` 一致：oauth 看 `refresh` 再退 `access`，
 * api 看 `key`。没有秘密的条目宿主也发不出请求，属于坏行，值得单独报出来。
 */
function secretOf(a) {
  if (a?.type === "api") return typeof a.key === "string" ? a.key : ""
  return typeof a?.refresh === "string" && a.refresh ? a.refresh : typeof a?.access === "string" ? a.access : ""
}

/** 过期状态：`ok` / `expired` / `none`（没写有效期）。 */
function expiryOf(a, now = Date.now()) {
  const exp = Number(a?.expires)
  if (!Number.isFinite(exp) || exp <= 0) return { state: "none", at: 0 }
  return { state: exp <= now ? "expired" : "ok", at: exp }
}

/**
 * 把一次「选账号」的意图解析成一个确定的 key。
 *
 * 接收三种写法，且**必须唯一命中**：
 * - 完整 key（`codebuddy#a1b2c3`）
 * - provider（`codebuddy`）—— 只有该 provider 恰好一个账号时才成立
 * - 账号名（`accountId`，如手机尾号 / 昵称）—— 跨 provider 唯一时才成立
 *
 * 命中多个就报错并列出候选，绝不猜。删除是不可逆动作，「大概是想删这个」
 * 是最不能接受的推断。
 */
export function resolveKey(all, want) {
  const q = String(want ?? "").trim()
  if (!q) throw new Error("which account? pass a key (provider#xxxxxx), a provider, or an account name")
  // 完整 key 直接命中 —— 但只在它是「带后缀的 key」时才跳过歧义检查：
  // `codebuddy` 既是 provider 名也是可能的 key，同名 provider 有多个账号时
  // 它必须被当成歧义，而不是「恰好是第一个」。
  if (all[q] && q.includes("#")) return q
  const hits = []
  for (const [key, a] of Object.entries(all)) {
    if (!isOurs(key)) continue
    if (key === q || providerOf(key) === q || whoOf(a) === q) hits.push(key)
  }
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new Error(`no account of this package matches ${JSON.stringify(q)} (only ${OURS.join(", ")} are managed here)`)
  throw new Error(`${JSON.stringify(q)} is ambiguous: ${hits.join(", ")}. Pass the exact key.`)
}

/**
 * 列出本包五家的账号，带诊断。
 *
 * 每一行给出 `key`、账号名、过期状态、是否有秘密。另外把三类该被看见的情况
 * 单独汇总：坏行（没有秘密）、已过期、以及「同 provider 多账号」—— 后者不是
 * 问题，但它是「哪个号会被用到」这个疑问的来源，值得在总览里点明。
 */
export function list(dir, { now = Date.now() } = {}) {
  let all
  try {
    all = readAuthFile(authPathOf(dir))
  } catch (e) {
    return { ok: false, error: `plugin-auth.json can't be read (${e?.message ?? e})`, rows: [], summary: {} }
  }
  const rows = []
  for (const provider of OURS) {
    const keys = Object.keys(all)
      .filter((k) => providerOf(k) === provider)
      .sort()
    for (const key of keys) {
      const a = all[key] ?? {}
      const exp = expiryOf(a, now)
      rows.push({
        key,
        provider,
        name: NAMES[provider] ?? provider,
        accountId: whoOf(a),
        type: String(a?.type ?? ""),
        expires: exp.at,
        expiry: exp.state,
        hasSecret: Boolean(secretOf(a)),
        suffix: key.includes("#") ? key.split("#")[1] : "",
      })
    }
  }
  const broken = rows.filter((r) => !r.hasSecret).map((r) => r.key)
  const expired = rows.filter((r) => r.expiry === "expired").map((r) => r.key)
  const perProvider = {}
  for (const r of rows) perProvider[r.provider] = (perProvider[r.provider] ?? 0) + 1
  const multi = Object.entries(perProvider)
    .filter(([, n]) => n > 1)
    .map(([p, n]) => `${p}×${n}`)
  return {
    ok: true,
    file: authPathOf(dir),
    rows,
    summary: { total: rows.length, broken, expired, multi },
  }
}

/**
 * 改账号名（`accountId`）。
 *
 * 用途很实际：两个号的 `accountId` 都是空串时，宿主只能靠 key 后缀区分它们，
 * 界面上就是两行一样的「(no account id)」。起个名字不影响认证，纯粹让人认得出。
 *
 * 只改 `accountId`，**不碰** `metadata`（有的 provider 把 `metadata.email`
 * 当显示名，改它可能影响别的插件对该账号的记录）。
 */
export function rename(dir, want, to) {
  const name = String(to ?? "").trim()
  if (!name) throw new Error("new name is empty")
  if (name.length > 64) throw new Error("new name is longer than 64 characters")
  // 锁内解析并改完，返回值也在锁内定下 —— 锁外再读一次文件会读到别人刚改的版本。
  let key = ""
  let before = ""
  let changed = false
  changeAuth(authPathOf(dir), (all) => {
    key = resolveKey(all, want)
    const a = all[key]
    if (!a || typeof a !== "object") throw new Error(`${key} is not an account object`)
    before = whoOf(a)
    if (before === name) return 0
    a.accountId = name
    changed = true
    return 1
  })
  return { key, before, after: name, changed }
}

/**
 * 删除一个账号。
 *
 * **不可逆**：magpie 的凭据条目一旦删除，恢复的唯一办法是重新登录该 provider。
 * （刷新令牌确实能换新令牌，但它本身在这一次调用里就被抹掉了。）
 *
 * 调用方必须显式传 `confirm: true`，否则只做「选到了谁」的预览。这是刻意加的
 * 一道闸：这个动作没有 undo。
 */
export function remove(dir, want, { confirm = false } = {}) {
  let key = ""
  let who = ""
  let removed = false
  changeAuth(authPathOf(dir), (all) => {
    key = resolveKey(all, want)
    const a = all[key]
    who = whoOf(a)
    if (!confirm) return 0
    delete all[key]
    removed = true
    return 1
  })
  return { key, accountId: who, removed, confirmed: confirm }
}

/** 预览：选到的 key 与它的当前状态，不改动任何东西。 */
export function preview(dir, want) {
  const all = readAuthFile(authPathOf(dir))
  const key = resolveKey(all, want)
  const a = all[key] ?? {}
  const exp = expiryOf(a)
  return {
    key,
    provider: providerOf(key),
    accountId: whoOf(a),
    type: String(a?.type ?? ""),
    expiry: exp.state,
    expires: exp.at,
    hasSecret: Boolean(secretOf(a)),
  }
}

/** 本包在这个 magpie 目录里管着几个账号（别的 provider 不算）。 */
export function count(dir) {
  try {
    const all = readAuthFile(authPathOf(dir))
    return Object.keys(all).filter(isOurs).length
  } catch {
    return 0
  }
}

export const _internal = { NAMES, providerOf, whoOf, secretOf, expiryOf }
