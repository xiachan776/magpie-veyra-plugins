/**
 * 把 magpie 供应商列表里的账号读出来 —— 让插件页与 Providers 页显示**同一批**账号。
 *
 * ## 为什么需要这个模块（这是 P1 的唯一目的）
 *
 * 之前插件页只认本包五家（`codebuddy` / `codebuddy-intl` / `lobsterai` / `codearts` /
 * `loomy`），而用户在 Providers 页登录的 11 个账号属于另外六家（`zcode`、
 * `workbuddy-ai`、`workbuddy`、`our-free-model`、`qoder`、`opencode-zen-free`）。
 * 两边对不上，用户看到的是「插件里 0 个号，供应商里 11 个号」。
 *
 * 用户的原话（这是本模块的需求来源）：
 *
 *   「我要的是直接管理这里的账号，这里的账号应该和供应商里面的同步」
 *   「magpie供应商的账号和我们设计的verya账号同步，一样的」
 *
 * ⇒ 口径改成：**插件页列出 magpie 认识的每一家、每一个账号**，不分归属。
 *   本包自己那五家只是其中五行，不再特殊对待。
 *
 * ## 数据来源：`plugin-providers.json`，不是 `plugin-auth.json`
 *
 * 两个文件管的事不一样，混用会出错：
 *
 * | 文件 | 内容 | 用途 |
 * | --- | --- | --- |
 * | `plugin-providers.json` | 每家一条，带 `accounts[]`（**没有秘密**，只有 `key`/`type`/`accountId`/`models`） | 列表、计数、`signedIn` |
 * | `plugin-auth.json` | `key → {type, access, refresh, expires, …}`（**有秘密**） | 读凭据本体 |
 *
 * 用户要的「和供应商页一样」指的是前者：Providers 页就是拿它的 `accounts[]`
 * 渲染的。所以本模块**只读前者**，凭据本体一个字节都不碰 —— 这样即使文件被
 * 并发刷新，也不可能把 token 写坏。
 *
 * ## 为什么能读到（依赖的前提，改 magpie 前要重新确认）
 *
 * 插件进程的 cwd 就是 magpie 配置目录：
 *
 *   // internal/plugin/host.go:929
 *   cmd := bunCommand(context.Background(), bun, settings.Dir(), "run", js)
 *   // internal/settings/settings.go:1049
 *   func Dir() string { return appdir.Config() }
 *   // internal/plugin/host.js:282
 *   let directory = process.cwd()
 *
 * 所以 `ctx.directory` 天然指向 `plugin-providers.json` 所在处。页面沙箱读不到，
 * 但 tool 钩子跑在宿主进程里能读到 —— 本模块就是给 tool 用的。
 *
 * ## 只读，且容忍残缺
 *
 * 这个文件由 magpie 主程序在登录/退出时改写，可能正被写入。读失败时返回
 * `ok:false` 而不是抛错：单个 provider 字段残缺也只跳过那一行，不连坐整个列表。
 * 「列不出账号」和「插件崩了」是两件严重程度完全不同的事，不能混为一谈。
 */

import fs from "node:fs"
import path from "node:path"

/** `plugin-providers.json` 的路径（与 `plugin-auth.json` 同目录）。 */
export const providersPathOf = (dir) => path.join(dir, "plugin-providers.json")

/**
 * 一家 provider 在界面上的显示名。
 *
 * 顺序：文件里的 `name` → 我们认识的别名 → id 本身。别名表只覆盖那几家
 * 名字与 id 差别大的（中文名、带空格的），其余直接用 id 更诚实。
 */
const ALIASES = {
  zcode: "ZCode",
  "workbuddy-ai": "WorkBuddy AI",
  workbuddy: "WorkBuddy",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  "our-free-model": "Our Free Model",
  "opencode-zen-free": "OpenCode Zen Free",
  cline: "Cline",
  "trae-cn": "Trae CN",
  "trae-global": "Trae Global",
  "trae-cn-next": "Trae CN Next",
  "trae-global-next": "Trae Global Next",
  raccoon: "Raccoon",
  "auto-checkin": "Auto Checkin",
  "quality-check": "Quality Check",
  codearts: "CodeArts",
  codebuddy: "CodeBuddy",
  "codebuddy-intl": "CodeBuddy Intl",
  lobsterai: "LobsterAI",
  loomy: "Loomy",
}

/** 一个账号行在界面上的名字：`accountId` 优先，退到 key 后缀，再退到「(未命名)」。 */
function nameOfAccount(entry) {
  const who = String(entry?.accountId ?? "").trim()
  if (who) return who
  const key = String(entry?.key ?? "")
  const suffix = key.includes("#") ? key.split("#")[1] : ""
  return suffix ? `#${suffix}` : "(no account id)"
}

/**
 * 读 `accounts[]` 里的一个条目。
 *
 * 字段可能是任何形状（文件由主程序写，版本间加过字段），所以逐项容错：
 * 拿不到 `key` 的条目仍然列出（用 provider 名占位），但标 `keyless: true`，
 * 这样界面不会把它当成一个可操作的账号。
 */
function accountRow(providerId, entry, index) {
  const models = Array.isArray(entry?.models) ? entry.models.filter((m) => typeof m === "string") : []
  const key = typeof entry?.key === "string" ? entry.key : ""
  return {
    provider: providerId,
    key,
    keyless: !key,
    index,
    name: nameOfAccount(entry),
    type: typeof entry?.type === "string" ? entry.type : "",
    models,
    modelCount: models.length,
  }
}

/**
 * 读一家 provider 的条目。
 *
 * `checkin` 字段在主程序里是「这家支持签到」的结构体（有的版本是布尔、有的是对象），
 * 这里只关心**有没有**，统一折成布尔 —— 界面只需要回答「能不能签」。
 */
function providerRow(entry, index) {
  const id = typeof entry?.id === "string" ? entry.id : ""
  const accounts = Array.isArray(entry?.accounts) ? entry.accounts.map((a, i) => accountRow(id, a, i)) : []
  const name = String(entry?.name ?? "").trim() || ALIASES[id] || id
  const models = Array.isArray(entry?.models) ? entry.models.filter((m) => typeof m === "string") : []
  return {
    id,
    index,
    name,
    signedIn: entry?.signedIn === true,
    checkin: Boolean(entry?.checkin),
    accountCount: accounts.length,
    accounts,
    models,
    modelCount: models.length,
    authType: typeof entry?.authType === "string" ? entry.authType : "",
  }
}

/**
 * 读出全部 provider 与其账号。
 *
 * 返回结构里 `rows` 是扁平的全部账号（每行都带 `provider`，界面按 provider 分组
 * 或平铺都行），`providers` 是分组视图，`summary` 是给页头用的汇总数字。
 *
 * `only` 可以把结果限制在若干 provider id 上（实测/调试用），但不影响口径：
 * 默认**不传 = 全部**，这正是「和供应商页一致」的含义。
 */
export function readProviders(dir, { only } = {}) {
  const file = providersPathOf(dir)
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (e) {
    return {
      ok: false,
      file,
      error: `plugin-providers.json can't be read (${e?.code ?? e?.message ?? e})`,
      providers: [],
      rows: [],
      summary: { providers: 0, signedIn: 0, accounts: 0 },
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return {
      ok: false,
      file,
      error: `plugin-providers.json isn't valid JSON (${e?.message ?? e})`,
      providers: [],
      rows: [],
      summary: { providers: 0, signedIn: 0, accounts: 0 },
    }
  }
  const list = Array.isArray(parsed) ? parsed : []
  const wanted = Array.isArray(only) && only.length ? new Set(only) : null
  const providers = []
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (!entry || typeof entry !== "object") continue
    if (wanted && !wanted.has(entry.id)) continue
    providers.push(providerRow(entry, i))
  }
  const rows = providers.flatMap((p) => p.accounts)
  return {
    ok: true,
    file,
    providers,
    rows,
    summary: {
      providers: providers.length,
      signedIn: providers.filter((p) => p.signedIn).length,
      accounts: rows.length,
    },
  }
}

/**
 * 按 provider 分组的账号视图 —— 供 `veyra_accounts action=list` 直接返回。
 *
 * 与 `readProviders` 的区别只在形状：这里每组都标了「有账号 / 空」，把 14 家
 * 没账号的也列出来。用户要的是「和供应商页一样」，而供应商页是 20 家全显示的，
 * 所以这里不裁剪。
 */
export function accountsByProvider(dir) {
  const r = readProviders(dir)
  if (!r.ok) return r
  return {
    ...r,
    groups: r.providers.map((p) => ({
      id: p.id,
      name: p.name,
      signedIn: p.signedIn,
      checkin: p.checkin,
      accountCount: p.accountCount,
      empty: p.accountCount === 0,
      accounts: p.accounts.map((a) => ({
        key: a.key,
        name: a.name,
        type: a.type,
        modelCount: a.modelCount,
      })),
    })),
  }
}
