/**
 * 与 Veyra（`xiachan776/veyra`，DSH 的那个账号插件）之间的账号互通。
 *
 * ## 为什么要做这件事
 *
 * 这两套东西管的是同一批订阅。Veyra 那边的账号库是
 *   `~/.dsh/.credentials.yaml`（凭据本体，`refs:` 下一行一个 `KEY: '<json>'`）
 * + `~/.dsh/veyra/state.json`（账号表：`accounts[]` 每项带 `provider` 与
 *   `credentialRef`）
 * magpie 这边是
 *   `<magpie 配置目录>/plugin-auth.json`（`{provider 或 provider#后缀: {type, access, refresh, expires, accountId, …}}`）
 *
 * 两边形状不同、语义相近，所以「换过去」要能重复做而不丢东西：导入时**不**搬走
 * Veyra 的凭据（它是单一副本，Veyra 自己也还在用），导出时也**不**动
 * `plugin-auth.json`。
 *
 * ## 三条硬约束（都来自实测，改之前先读）
 *
 * 1. **只碰本包负责的五家。** Veyra 的另外十来个 provider（cline/trae/qoder/…）
 *    由社区插件各自的格式管着，把 Veyra 的 JSON 塞进去只会让那些插件读不懂自己
 *    的凭据。所以这里有一张显式的映射表，表外的 provider 一律跳过。
 * 2. **写 `plugin-auth.json` 必须走 magpie 的锁。** `host.js` 的 `changeAuth()`
 *    用 `plugin-auth.json.lock`（`wx` 创建，超 10 秒视为上一个进程死掉留下的）
 *    串行化读-改-写，并用「写临时文件 + fsync + rename」落盘（早年一次掉电留下
 *    全零文件，见 magpie #1505）。这里逐条照抄：不建锁就写，会和同时刷新的
 *    host 互相覆盖对方刚换到的 token。
 * 3. **`.credentials.yaml` 不是标准 YAML 子集，要自己折叠。** 一个 buddy 凭据
 *    是 2.6 KB 的单引号标量，被折成 3 行：YAML 的规则是「换行折成一个空格、
 *    剥掉续行前导空白、`''` 是转义的 `'`」。用 `JSON.parse` 直接读会失败，用
 *    正则按行切会把 JSON 切坏。
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

/**
 * Veyra 的 provider id → 本包的 provider id。
 *
 * 表外的**不导出也不导入**：那些 id 归社区插件（`@magpie-community/…`）管，
 * 凭据形状各不相同。
 */
export const MAP = {
  "veyra-buddy": "codebuddy",
  "veyra-buddy-intl": "codebuddy-intl",
  "veyra-lobsterai": "lobsterai",
  "veyra-codearts": "codearts",
  "veyra-loomy": "loomy",
}

/** 反查：本包 provider id → Veyra 的 provider id。 */
export const BACK = Object.fromEntries(Object.entries(MAP).map(([v, m]) => [m, v]))

/** 本包负责的 magpie provider id。 */
export const OURS = Object.values(MAP)

/** 一次操作里跳过的一行，带原因：导出的报告要能解释「为什么没搬它」。 */
const skipped = (what, why) => ({ what, why })

// ---- YAML 折叠 ---------------------------------------------------------------

/**
 * 把 `.credentials.yaml` 的 `refs:` 段读成 `{KEY: 字符串}`。
 *
 * 只认这一种写法（Veyra 自己也只写这一种）：
 *
 * ```yaml
 * refs:
 *   SOME_KEY: '{"a":1,
 *     "b":2}'
 *   PLAIN_KEY: plain text
 * ```
 *
 * 单引号标量可以跨行，折叠规则见文件头第 3 条。双引号与裸标量也顺手支持，但
 * 不做 `\n` 转义展开 —— Veyra 存的是 JSON，里面没有需要展开的转义。
 *
 * 读不懂的行**跳过而不是抛错**：一个坏行不该让用户一个账号都导不进来。
 */
export function parseRefs(text) {
  const out = {}
  const lines = String(text ?? "").split(/\r?\n/)
  let inRefs = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      i++
      continue
    }
    // 顶格的另一个键（`version:` 之类）结束 refs 段
    if (/^\S/.test(line) && line.trim()) {
      inRefs = false
      i++
      continue
    }
    if (!inRefs) {
      i++
      continue
    }
    const m = /^\s+([A-Za-z0-9_.-]+):\s?(.*)$/.exec(line)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    let rest = m[2] ?? ""
    if (rest.startsWith("'")) {
      // 单引号标量：吃到收尾的 '（末尾可能还有空白）
      let buf = rest.slice(1)
      for (;;) {
        // 收尾判定：末尾的 ' 且后面只剩空白；`''` 是转义，不是收尾
        if (buf.endsWith("'") && !buf.endsWith("''")) break
        if (buf.endsWith("''")) {
          // 转义的一半，继续往下拼
        }
        i++
        if (i >= lines.length) break
        buf += "\n" + lines[i].replace(/^\s+/, "")
      }
      out[key] = buf.slice(0, -1).replace(/\n/g, " ").replace(/''/g, "'")
    } else if (rest.startsWith('"')) {
      let buf = rest.slice(1)
      while (!buf.endsWith('"') && i + 1 < lines.length) {
        i++
        buf += "\n" + lines[i]
      }
      out[key] = buf.slice(0, -1).replace(/\n/g, " ")
    } else {
      // 裸标量：只取这一行
      out[key] = rest.trim()
    }
    i++
  }
  return out
}

/** `refs` 的值按 JSON 解析；解析不了就给 `undefined`（调用方据此跳过）。 */
function jsonOf(refs, key) {
  const raw = refs?.[key]
  if (typeof raw !== "string" || !raw.trim()) return undefined
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" ? v : undefined
  } catch {
    return undefined
  }
}

// ---- Veyra 的目录 -----------------------------------------------------------

/**
 * DSH 的主目录：`$DSH_HOME`，否则 `~/.dsh`。
 *
 * 与 Veyra 自己的 `getHome()` 同口径（`options.home ?? env.DSH_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')`），
 * 用户把 DSH 装在别处时两边仍然指同一个地方。
 */
export function dshHome(env = process.env) {
  const set = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : ""
  return set || path.join(os.homedir(), ".dsh")
}

/** Veyra 的两个文件。 */
export function veyraPaths(home = dshHome()) {
  return {
    credentials: path.join(home, ".credentials.yaml"),
    state: path.join(home, "veyra", "state.json"),
  }
}

/** 静默读文本：不在就是 `""`（用户的 Veyra 可能压根没装）。 */
function readText(p) {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return ""
  }
}

/**
 * 读 Veyra 那边的账号表与凭据，返回 `{accounts: [...], problems: [...]}`。
 *
 * 每一项：
 * ```
 * { veyraId, magpieId, nickname, ref, credentialRef, enabled,
 *   credential,            // 原样 JSON 对象（只在本进程内用，不落盘）
 *   expiresAt }            // ms；0 表示这份凭据没写有效期
 * ```
 */
export function readVeyra({ home = dshHome(), credentials, state } = {}) {
  const paths = veyraPaths(home)
  const yaml = credentials ?? readText(paths.credentials)
  const raw = state ?? readText(paths.state)
  const problems = []
  const refs = parseRefs(yaml)
  let st = {}
  if (raw.trim()) {
    try {
      st = JSON.parse(raw)
    } catch (e) {
      problems.push(skipped("veyra/state.json", `读不懂：${e?.message ?? e}`))
    }
  }
  const list = Array.isArray(st?.accounts) ? st.accounts : []
  if (raw.trim() && !Array.isArray(st?.accounts)) problems.push(skipped("veyra/state.json", "没有 accounts 数组"))
  if (!Object.keys(refs).length && yaml.trim()) problems.push(skipped(".credentials.yaml", "refs 段是空的或读不懂"))

  const accounts = []
  for (const a of list) {
    if (!a || typeof a !== "object") continue
    const veyraId = typeof a.provider === "string" ? a.provider : ""
    const magpieId = MAP[veyraId]
    if (!magpieId) {
      problems.push(skipped(`${veyraId || "?"}/${a.nickname ?? a.id ?? "?"}`, "不在本包负责的五家里，跳过以免破坏别的插件的凭据格式"))
      continue
    }
    if (a.enabled === false) {
      problems.push(skipped(`${veyraId}/${a.nickname ?? a.id ?? "?"}`, "在 Veyra 里被停用了"))
      continue
    }
    const ref = typeof a.credentialRef === "string" ? a.credentialRef : ""
    const credential = jsonOf(refs, ref)
    if (!credential) {
      problems.push(skipped(`${veyraId}/${a.nickname ?? a.id ?? "?"}`, `凭据 ${ref || "(空)"} 在 .credentials.yaml 里找不到或不是 JSON`))
      continue
    }
    const expires = Number(
      credential.expires_at ?? credential.expiresAt ?? (typeof a.expiresAt === "number" ? a.expiresAt : 0),
    )
    accounts.push({
      veyraId,
      magpieId,
      id: typeof a.id === "string" ? a.id : "",
      nickname: typeof a.nickname === "string" ? a.nickname : "",
      ref,
      credentialRef: ref,
      credential,
      // 秒与毫秒都出现过（buddy 是秒，lobsterai 是毫秒），按量级判
      expiresAt: Number.isFinite(expires) ? (expires > 1e12 ? expires : expires > 1e9 ? expires * 1000 : 0) : 0,
    })
  }
  return { accounts, problems, refs, state: st }
}

// ---- 形状转换 ---------------------------------------------------------------

/** 账号在 magpie 里的显示名：昵称优先，退到手机尾号、uid。 */
function nameOf(c, fallback) {
  for (const k of ["nickname", "name", "user_name", "phone", "userid", "uid", "user_id"]) {
    const v = c?.[k]
    if (typeof v === "string" && v.trim()) return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return fallback
}

/**
 * Veyra 的一份凭据 → magpie `plugin-auth.json` 的一条。
 *
 * 形状与各插件自己的 `success()` 必须**逐字一致**，否则 magpie 里能登录但跑不动：
 * - `codebuddy` / `codebuddy-intl`：`{type:"oauth", access, refresh, expires, refreshExpiresAt, domain, tokenType, accountId, …}`
 * - `lobsterai`：`{type:"oauth", access: <整份 JSON 字符串>, refresh, expires, accountId}`
 * - `codearts`：`{type:"oauth", access: <{ak,sk,st,expires,verifier,jwk} 的 JSON 字符串>, refresh, expires, accountId}`
 * - `loomy`：`{type:"api", key: <{session,…} 的 JSON 字符串>, metadata}`
 *
 * `refresh` 必须是字符串（`host.js` 按它去重并发续期），没有就填 `""`。
 */
export function toMagpie(account) {
  const c = account.credential ?? {}
  const magpieId = account.magpieId
  const who = nameOf(c, account.nickname || account.id || magpieId)
  const pack = (o) => JSON.stringify(o)
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)

  if (magpieId === "codebuddy" || magpieId === "codebuddy-intl") {
    const access = typeof c.access_token === "string" ? c.access_token : ""
    const refresh = typeof c.refresh_token === "string" ? c.refresh_token : ""
    if (!access && !refresh) return { error: "凭据里没有 access_token / refresh_token" }
    const out = {
      type: "oauth",
      access,
      refresh,
      expires: account.expiresAt || num(c.expires_at) * (num(c.expires_at) > 1e12 ? 1 : 1000),
      accountId: who,
    }
    const rExp = num(c.refresh_expires_at)
    if (rExp > 0) out.refreshExpiresAt = rExp > 1e12 ? rExp : rExp * 1000
    if (typeof c.domain === "string" && c.domain) out.domain = c.domain
    if (typeof c.token_type === "string" && c.token_type) out.tokenType = c.token_type
    if (typeof c.user_id === "string" && c.user_id) out.uid = c.user_id
    if (typeof c.enterprise_id === "string" && c.enterprise_id) out.enterpriseId = c.enterprise_id
    return { auth: out, accountId: who }
  }

  if (magpieId === "lobsterai") {
    const access = typeof c.access_token === "string" ? c.access_token : ""
    if (!access) return { error: "凭据里没有 access_token" }
    const cred = {
      access_token: access,
      refresh_token: typeof c.refresh_token === "string" ? c.refresh_token : "",
      expires_at: String(account.expiresAt || ""),
      uid: String(c.uid ?? ""),
      user_id: String(c.user_id ?? ""),
      nickname: String(c.nickname ?? ""),
      uuid: String(c.uuid ?? ""),
      first_keyfrom: String(c.first_keyfrom ?? ""),
      latest_keyfrom: String(c.latest_keyfrom ?? ""),
    }
    return {
      auth: { type: "oauth", access: pack(cred), refresh: cred.refresh_token, expires: account.expiresAt || 0, accountId: who },
      accountId: who,
    }
  }

  if (magpieId === "codearts") {
    const ak = typeof c.access_key_id === "string" ? c.access_key_id : ""
    const sk = typeof c.secret_access_key === "string" ? c.secret_access_key : ""
    const st = typeof c.security_token === "string" ? c.security_token : ""
    if (!ak || !sk) return { error: "凭据里没有 access_key_id / secret_access_key" }
    const cred = {
      ak,
      sk,
      st,
      expires: account.expiresAt || 0,
      verifier: typeof c.code_verifier === "string" ? c.code_verifier : "",
      jwk: c.dpop_private_key_jwk ?? null,
    }
    return {
      auth: {
        type: "oauth",
        access: pack(cred),
        refresh: typeof c.refresh_token === "string" ? c.refresh_token : "",
        expires: cred.expires,
        accountId: who,
      },
      accountId: who,
    }
  }

  if (magpieId === "loomy") {
    // Veyra 那份的键叫 `access_token`，本包内部叫 `session`（loomy.mjs 的 unpack）
    const session = typeof c.access_token === "string" ? c.access_token : typeof c.session === "string" ? c.session : ""
    if (!session) return { error: "凭据里没有 access_token" }
    const cred = {
      session,
      userid: String(c.userid ?? c.user_id ?? ""),
      phone: String(c.phone ?? ""),
      expires: account.expiresAt || 0,
    }
    return {
      auth: { type: "api", key: pack(cred), metadata: { accountId: who, phone: cred.phone, nickname: String(c.nickname ?? "") } },
      accountId: who,
    }
  }

  return { error: `不认识的 provider ${magpieId}` }
}

/**
 * magpie 的一条 → Veyra 的 `refs` 值（JSON 字符串）。
 *
 * 只做「看起来像什么」的转换，不生成 Veyra 的账号表条目 —— 那一步在调用方，
 * 因为账号 id、`credentialRef` 的命名与去重是文件级的决定。
 */
export function toVeyra(magpieId, auth) {
  const veyraId = BACK[magpieId]
  if (!veyraId) return { error: `${magpieId} 没有对应的 Veyra provider` }
  const parse = (s) => {
    try {
      const v = JSON.parse(String(s ?? ""))
      return v && typeof v === "object" ? v : null
    } catch {
      return null
    }
  }
  const now = Date.now()
  const exp = Number(auth?.expires) > 0 ? Number(auth.expires) : 0

  if (magpieId === "codebuddy" || magpieId === "codebuddy-intl") {
    if (!auth?.access && !auth?.refresh) return { error: "这条没有 access / refresh" }
    const out = {
      access_token: auth.access ?? "",
      refresh_token: auth.refresh ?? "",
      expires_at: exp ? Math.floor(exp / 1000) : 0,
      refresh_expires_at: Number(auth.refreshExpiresAt) > 0 ? Math.floor(Number(auth.refreshExpiresAt) / 1000) : 0,
      token_type: auth.tokenType ?? "Bearer",
      scope: "profile offline_access",
      domain: auth.domain ?? "",
      user_id: auth.uid ?? "",
      nickname: auth.accountId ?? "",
      enterprise_id: auth.enterpriseId ?? "",
      account_type: auth.enterpriseId ? "enterprise" : "personal",
    }
    return { provider: veyraId, value: JSON.stringify(out) }
  }

  if (magpieId === "lobsterai") {
    const c = parse(auth?.access)
    if (!c) return { error: "access 不是 lobsterai 的凭据 JSON" }
    return {
      provider: veyraId,
      value: JSON.stringify({
        access_token: c.access_token ?? "",
        refresh_token: c.refresh_token ?? auth?.refresh ?? "",
        expires_at: String(c.expires_at ?? (exp ? String(exp) : "")),
        uid: c.uid ?? "",
        user_id: c.user_id ?? "",
        nickname: c.nickname ?? "",
        uuid: c.uuid ?? "",
        first_keyfrom: c.first_keyfrom ?? "",
        latest_keyfrom: c.latest_keyfrom ?? "",
      }),
    }
  }

  if (magpieId === "codearts") {
    const c = parse(auth?.access)
    if (!c) return { error: "access 不是 codearts 的凭据 JSON" }
    return {
      provider: veyraId,
      value: JSON.stringify({
        access_key_id: c.ak ?? "",
        secret_access_key: c.sk ?? "",
        security_token: c.st ?? "",
        expires_at: c.expires ? new Date(Number(c.expires)).toISOString() : "",
        refresh_token: auth?.refresh ?? "",
        code_verifier: c.verifier ?? "",
        dpop_private_key_jwk: c.jwk ?? null,
      }),
    }
  }

  if (magpieId === "loomy") {
    const c = parse(auth?.type === "api" ? auth.key : auth?.access)
    if (!c) return { error: "key 不是 loomy 的凭据 JSON" }
    return {
      provider: veyraId,
      value: JSON.stringify({
        access_token: c.session ?? "",
        userid: c.userid ?? "",
        phone: c.phone ?? "",
        nickname: auth?.metadata?.nickname ?? "",
        expires_at: c.expires ?? exp ?? 0,
      }),
    }
  }

  void now
  return { error: `不认识的 provider ${magpieId}` }
}

// ---- plugin-auth.json 的读、锁、写 ------------------------------------------

/** magpie 的账号库路径。`dir` 是 host 给的 `input.directory`（= `settings.Dir()`）。 */
export const authPathOf = (dir) => path.join(dir, "plugin-auth.json")

/** 读账号库：不在就是 `{}`，读不懂就抛（**绝不**在读不懂时写回去）。 */
export function readAuthFile(file) {
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (e) {
    if (e?.code === "ENOENT") return {}
    throw e
  }
  if (!text.trim()) return {}
  const v = JSON.parse(text)
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("plugin-auth.json 不是一个对象")
  return v
}

const AUTH_LOCK_STALE = 10 * 1000
const pause = (ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* 同步忙等：调用方在 host 单线程里，不能让出事件循环去和别人抢同一个锁 */
  }
}

/**
 * 建锁：与 `host.js` 的 `lockAuth()` 同协议（`wx` 独占创建，超过
 * `AUTH_LOCK_STALE` 视为上一个进程死掉留下的，删掉重来；最多等 2 个周期）。
 */
function lockAuth(file) {
  const lock = file + ".lock"
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (const start = Date.now(); ; ) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600))
      return () => {
        try {
          fs.unlinkSync(lock)
        } catch {}
      }
    } catch (e) {
      if (e?.code !== "EEXIST" && e?.code !== "EPERM" && e?.code !== "EACCES") throw e
    }
    let old = false
    try {
      old = Date.now() - fs.statSync(lock).mtimeMs > AUTH_LOCK_STALE
    } catch {}
    if (old || Date.now() - start > 2 * AUTH_LOCK_STALE) {
      try {
        fs.unlinkSync(lock)
      } catch {}
    }
    pause(5)
  }
}

/**
 * 落盘：写临时文件 → fsync → rename（与 `host.js` 的 `writeDurable()` 同协议）。
 *
 * 为什么非要 fsync：只 rename 的话数据到盘是另一回事，中途掉电会留下一个长度
 * 正确但内容全零的文件 —— magpie #1505 就是这么来的，那段代码至今留着防御。
 */
function writeDurable(file, data) {
  const tmp = file + ".tmp-" + process.pid
  try {
    const f = fs.openSync(tmp, "w", 0o600)
    try {
      const buf = Buffer.from(data)
      for (let off = 0; off < buf.length; ) off += fs.writeSync(f, buf, off, buf.length - off)
      fs.fsyncSync(f)
    } finally {
      fs.closeSync(f)
    }
    for (let i = 0; ; i++) {
      try {
        return fs.renameSync(tmp, file)
      } catch (e) {
        // Windows 上另一个进程正开着这个文件时 rename 会 EPERM/EBUSY，重试
        if (i >= 50 || !["EPERM", "EACCES", "EBUSY"].includes(e?.code)) throw e
        pause(10)
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw e
  }
}

/**
 * 在锁内读-改-写账号库。`change(all)` 改 `all` 并返回改了几条（0 就不写盘，
 * 免得把 mtime 动一下就让 host 重读整个文件）。
 */
export function changeAuth(file, change) {
  const unlock = lockAuth(file)
  try {
    const all = readAuthFile(file)
    const n = change(all) || 0
    if (n > 0) writeDurable(file, JSON.stringify(all, null, 2) + "\n")
    return n
  } finally {
    unlock()
  }
}

/**
 * 给一个 provider 挑一个没被占用的 key：`provider` 空着就用它，否则
 * `provider#xxxxxx`（与 `host.js` 的 `freshKey()` 同形，后缀 6 位）。
 */
export function freshKey(all, provider) {
  if (!all[provider]) return provider
  for (;;) {
    const k = `${provider}#${Math.random().toString(36).slice(2, 8)}`
    if (!all[k]) return k
  }
}

/** 账号是否已在库里：同 provider 下 `accountId` 相同，或凭据本体相同。 */
export function alreadyThere(all, provider, auth) {
  for (const [k, v] of Object.entries(all ?? {})) {
    if (k !== provider && !k.startsWith(provider + "#")) continue
    if (!v || typeof v !== "object") continue
    if (auth.accountId && v.accountId && auth.accountId === v.accountId) return k
    const secret = (x) => (x?.type === "oauth" ? x.refresh || x.access : x?.key) || ""
    if (secret(v) && secret(v) === secret(auth)) return k
  }
  return ""
}

// ---- 两个方向的高层动作 -----------------------------------------------------

/**
 * Veyra → magpie：把 Veyra 里本包负责的五家账号搬进 `plugin-auth.json`。
 *
 * 幂等：已经在库里的账号（同 accountId 或同凭据）不重复添加，只报 `exists`。
 * **不动** Veyra 的任何文件 —— 它是单一副本，抓一次不影响它继续用。
 */
export function importFromVeyra({ dir, home, dryRun = false, credentials, state } = {}) {
  const found = readVeyra({ home, credentials, state })
  const file = authPathOf(dir)
  const report = { file, dryRun, added: [], exists: [], failed: [], skipped: found.problems }
  const plan = []
  for (const account of found.accounts) {
    const conv = toMagpie(account)
    if (conv.error) {
      report.failed.push({ account: account.nickname || account.id || account.ref, provider: account.magpieId, why: conv.error })
      continue
    }
    plan.push({ account, auth: conv.auth })
  }
  if (dryRun) {
    const all = (() => {
      try {
        return readAuthFile(file)
      } catch {
        return {}
      }
    })()
    for (const { account, auth } of plan) {
      const at = alreadyThere(all, account.magpieId, auth)
      if (at) report.exists.push({ provider: account.magpieId, accountId: auth.accountId, key: at })
      else {
        report.added.push({ provider: account.magpieId, accountId: auth.accountId })
        all[freshKey(all, account.magpieId)] = auth
      }
    }
    return report
  }
  changeAuth(file, (all) => {
    let n = 0
    for (const { account, auth } of plan) {
      const at = alreadyThere(all, account.magpieId, auth)
      if (at) {
        report.exists.push({ provider: account.magpieId, accountId: auth.accountId, key: at })
        continue
      }
      all[freshKey(all, account.magpieId)] = auth
      report.added.push({ provider: account.magpieId, accountId: auth.accountId })
      n++
    }
    return n
  })
  return report
}

/**
 * magpie → Veyra：把 `plugin-auth.json` 里本包负责的账号导成 Veyra 的
 * 「`refs` 条目 + 账号表条目」，**写成一份可以贴进 Veyra 的 JSON**，不直接改
 * Veyra 的文件。
 *
 * 为什么不直接写：Veyra 也持有一份内存/磁盘状态，外部悄悄改它的
 * `state.json` 与 `.credentials.yaml` 会让它下次保存时把改动覆盖掉。导出成
 * 「清单」交给人/agent 决策更安全，也符合「备份导出」的字面意思。
 */
export function exportToVeyra({ dir, home } = {}) {
  const file = authPathOf(dir)
  const all = readAuthFile(file)
  const report = { file, credentialsFile: veyraPaths(home).credentials, entries: [], skipped: [] }
  for (const [key, auth] of Object.entries(all)) {
    const provider = key.split("#")[0]
    if (!OURS.includes(provider)) {
      report.skipped.push(skipped(key, "不在本包负责的五家里"))
      continue
    }
    const conv = toVeyra(provider, auth)
    if (conv.error) {
      report.skipped.push(skipped(key, conv.error))
      continue
    }
    const accountId = auth?.accountId || auth?.metadata?.accountId || key
    // `refs` 的键：Veyra 自己用 `<PROVIDER>_ACCOUNT_<8 位大写 hex>`，这里照抄形状，
    // 加时间戳后缀的哈希源，避免与已有 ref 撞名。
    const ref = `${conv.provider.replace(/^veyra-/, "").toUpperCase().replace(/-/g, "_")}_ACCOUNT_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`
    report.entries.push({
      ref,
      account: {
        id: `${conv.provider}-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        provider: conv.provider,
        nickname: String(accountId),
        enabled: true,
        credentialRef: ref,
        refreshable: true,
        createdAt: Date.now(),
        expiresAt: Number(auth?.expires) > 0 ? Number(auth.expires) : 0,
      },
      value: conv.value,
    })
  }
  // 给你一份能直接喂给 YAML 的 `refs:` 片段（单引号标量，与 Veyra 写法一致）
  report.refs = report.entries.map((e) => `  ${e.ref}: '${e.value.replace(/'/g, "''")}'`).join("\n")
  report.accounts = report.entries.map((e) => e.account)
  return report
}
