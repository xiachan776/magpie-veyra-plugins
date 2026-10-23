/**
 * 给 agent 用的工具：`veyra_accounts`。
 *
 * ## 为什么需要它
 *
 * magpie 的插件页被沙箱钉死（`connect-src 'none'`、`PageReads` 只有
 * `providers:list` 与 `usage:summary`），面板拿不到账号列表、额度明细、签到实况，
 * 也发不出任何网络请求。而「看我有几个号、哪个号今天签到了、把 Veyra 的号搬过来」
 * 这类事恰恰需要读本地文件。宿主给插件的另一条通道就是 **tool 钩子**：它经
 * magpie 的 plugin-tools MCP server 暴露给每个 agent，运行在宿主进程里，能自由读盘。
 *
 * ## 只做三件本地事
 *
 * | action | 做什么 | 为什么不由别处做 |
 * | --- | --- | --- |
 * | `list` | 读 `plugin-auth.json` + `plugin-checkin.json`，列出本包五家的账号与今日签到结果 | 面板读不到账号；`usage:summary` 只有汇总用量 |
 * | `import` | 把 Veyra（`~/.dsh`）里的五家账号搬进 `plugin-auth.json` | 纯本地文件操作，面板发不出请求 |
 * | `export` | 把本包的账号导成可贴进 Veyra 的 `refs` 清单 | 同上 |
 *
 * **刻意不提供「立即签到」**：magpie 自己已经有三个入口（`magpie accounts checkin`、
 * Usage 页的手动按钮、`KeepPluginsCheckedIn` 的每小时循环），再包一层只会让
 * 「谁签的」这件事有两个说法。签到能力靠各 provider 的 `auth.checkin` 钩子暴露，
 * 宿主用 `typeof a.auth.checkin === "function"` 自动探测。
 *
 * ## 契约（`internal/plugin/host.js:1426-1580`）
 *
 * - 工具名 `/^[A-Za-z0-9_-]{1,48}$/`；
 * - `args` 可以是纯 JSON Schema，但**宿主不校验**（`parsedArgs` 对 JSON Schema
 *   原样返回），所以参数检查必须自己写；
 * - `execute(args, ctx)` 返回字符串，或 `{output: string}`，其余会被 `JSON.stringify`；
 * - `ctx.directory` 就是 magpie 配置目录（`plugin-auth.json` 所在处）；
 * - 默认 60 秒超时（宿主侧封顶 55 秒）。
 */

import fs from "node:fs"
import path from "node:path"

import { MAP, OURS, dshHome, importFromVeyra, exportToVeyra } from "./veyra.mjs"
import { list as manageList, preview as managePreview, remove as manageRemove, rename as manageRename } from "./manage.mjs"
import { readProviders } from "./accounts.mjs"

/** 五个 provider 的显示名，只用于把 key 说得像人话。 */
const NAMES = {
  codebuddy: "CodeBuddy",
  "codebuddy-intl": "CodeBuddy Intl",
  lobsterai: "LobsterAI",
  codearts: "CodeArts",
  loomy: "Loomy",
}

const ACTIONS = ["all", "list", "checkin", "show", "rename", "remove", "import", "export"]

/**
 * 读签到记录：键是 `"<provider>|<accountId>"`（`pluginCheckinPath()` 的落盘形状）。
 * 读不到就是没有记录 —— 不报错，签到记录缺失不等于账号有问题。
 */
function readCheckins(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "plugin-checkin.json"), "utf8")
    const all = JSON.parse(raw)
    return all && typeof all === "object" ? all : {}
  } catch {
    return {}
  }
}

const oneLine = (v, n = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n)

/**
 * 账号总览。
 *
 * 只列本包负责的五家：同一个 `plugin-auth.json` 里还有社区插件的账号（zcode、
 * qoder…），把它们也列出来会让人以为本包能管它们。
 */
function list(dir) {
  let all
  try {
    all = readAuthFile(authPathOf(dir))
  } catch (e) {
    return `plugin-auth.json can't be read (${e?.message ?? e}); nothing is listed.`
  }
  const checkins = readCheckins(dir)
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const lines = []
  let total = 0
  for (const provider of OURS) {
    const keys = Object.keys(all).filter((k) => k === provider || k.startsWith(provider + "#"))
    if (!keys.length) continue
    keys.sort()
    lines.push(`${NAMES[provider] ?? provider} (${provider})`)
    for (const key of keys) {
      const a = all[key] ?? {}
      total++
      // 与宿主的 `whoOf()` 同序：`accountId` → `metadata.email` → `email`。
      const who = a.accountId || a?.metadata?.email || a.email || ""
      const exp = Number(a.expires) > 0 ? new Date(Number(a.expires)).toISOString().slice(0, 16).replace("T", " ") : "no expiry"
      // 签到记录的键是 `"<provider>|<accountId>"`，账号没有 id 时退化成账号 key
      // （`internal/provider/plugin_checkin.go:60-65` 的 `who = acct` 分支）。
      const rec = checkins[`${provider}|${who || key}`]
      let said = "no check-in recorded"
      if (rec && typeof rec === "object") {
        const when = rec.day === today ? "today" : String(rec.day ?? "?")
        said = `${rec.outcome ?? "?"} ${when}`
        if (Number(rec.credit) > 0) said += ` +${rec.credit}`
        if (Number(rec.streak) > 0) said += ` (${rec.streak}-day streak)`
        if (rec.msg) said += ` — ${oneLine(rec.msg, 60)}`
      }
      lines.push(`  ${key === provider ? "·" : " "} ${key}  ${who || "(no account id)"}  expires ${exp}  ·  ${said}`)
    }
  }
  if (!total) {
    return "No accounts of this package's five providers are signed in yet. Sign in on magpie's Providers page, or run action=import to bring Veyra's accounts over."
  }
  const head = `${total} account${total === 1 ? "" : "s"} across ${OURS.length} providers (${dshHome()} is Veyra's home):`
  return [head, ...lines].join("\n")
}

/**
 * **全部**账号总览：magpie 认识的每一家、每一个号，不分归属。
 *
 * 与上面 `list()` 的分工：
 *
 * | | `action=list` | `action=all` |
 * | --- | --- | --- |
 * | 范围 | 本包五家 | magpie 全部 20 家 |
 * | 来源 | `plugin-auth.json`（有凭据、能判过期） | `plugin-providers.json`（与 Providers 页同源） |
 * | 用途 | 管本包自己的号 | 回答「供应商页里那些号在插件里看不看得见」 |
 *
 * 用户的原话是「这里的账号应该和供应商里面的同步」—— 所以 `action=all` 的口径
 * 必须与 Providers 页**逐数字对齐**：同样是 20 家、6 家已登录、11 个号。
 * 对不齐就是 bug，不是显示差异。
 *
 * 每家都列出来（含 0 账号的 14 家）：裁剪成「有号的才显示」会让人以为插件只认识
 * 那几家，而供应商页是全列的。**空**和**缺**是两件事，这里必须说清楚。
 */
function doAll(dir) {
  const r = readProviders(dir)
  if (!r.ok) return `${r.error}; nothing is listed. (file: ${r.file})`
  const lines = []
  lines.push(`${r.summary.accounts} account${r.summary.accounts === 1 ? "" : "s"} across ${r.summary.providers} providers, ${r.summary.signedIn} signed in — the same numbers magpie's Providers page shows:`)
  for (const p of r.providers) {
    // `signedIn` 与 `accounts.length` 说话不一致时如实标出来。两者来自同一个文件，
    // 只有主程序写到一半时才会出现，值得看见而不是被悄悄抹平。
    const tags = [`${p.accountCount} account${p.accountCount === 1 ? "" : "s"}`]
    if (p.signedIn) tags.push("signed in")
    else if (p.accountCount) tags.push("has accounts but signedIn=false")
    if (p.checkin) tags.push("check-in")
    lines.push("")
    lines.push(`${p.name} (${p.id}) — ${tags.join(", ")}`)
    if (!p.accountCount) {
      lines.push("  (no accounts)")
      continue
    }
    for (const a of p.accounts) {
      const suffix = a.type ? `  ${a.type}` : ""
      const models = a.modelCount ? `  ${a.modelCount} model${a.modelCount === 1 ? "" : "s"}` : ""
      lines.push(`  · ${a.key}  ${a.name}${suffix}${models}`)
    }
  }
  lines.push("")
  lines.push(`source: ${r.file}`)
  return lines.join("\n")
}

function doImport(dir, dryRun) {
  const r = importFromVeyra({ dir, dryRun })
  const out = []
  out.push(`${dryRun ? "Would add" : "Added"} ${r.added.length}, already there ${r.exists.length}, failed ${r.failed.length}, skipped ${r.skipped.length}.`)
  out.push(`file: ${r.file}`)
  for (const a of r.added) out.push(`  + ${a.provider}  ${a.accountId || "(no account id)"}`)
  for (const a of r.exists) out.push(`  = ${a.provider}  ${a.accountId || "(no account id)"}  (already at ${a.key})`)
  for (const a of r.failed) out.push(`  ! ${a.provider}  ${a.account || "(unnamed)"}: ${a.why}`)
  for (const s of r.skipped) out.push(`  · skipped ${s.what}: ${s.why}`)
  if (dryRun) out.push("Nothing was written (dryRun).")
  else if (r.added.length) out.push("Sign-ins are kept in plugin-auth.json; magpie picks them up on its next load.")
  return out.join("\n")
}

/**
 * 管理动作的共用入口：先给宿主文件加一句「改动会立即生效」的现实描述。
 *
 * magpie 的内存状态来自 `readAuthState()`，每次取用都会重读文件；因此改名或删除
 * 之后不需要重启，下一次请求就按新内容走。这句话必须写出来，否则用户会以为
 * 还要点一次「重载」。
 */
function say(lines) {
  return lines.filter(Boolean).join("\n")
}

/**
 * 列出账号与诊断（`list`）。
 *
 * 签到结果放在同一行：宿主把结果写在 `plugin-checkin.json`，键是
 * `"<provider>|<accountId>"`（账号没有 accountId 时退化成账号 key，见
 * `internal/provider/plugin_checkin.go:60-65`）。把两件事分开输出会让人
 * 反复对照两个列表去找「这个号今天签没签」。
 */
function doList(dir) {
  const r = manageList(dir)
  if (!r.ok) return r.error
  if (!r.rows.length) {
    return "No accounts of this package's five providers are signed in yet. Sign in on magpie's Providers page, or run action=import to bring Veyra's accounts over."
  }
  const checkins = readCheckins(dir)
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const out = []
  out.push(`${r.rows.length} account${r.rows.length === 1 ? "" : "s"} across ${OURS.length} providers:`)
  let lastProvider = ""
  for (const row of r.rows) {
    if (row.provider !== lastProvider) {
      out.push("")
      out.push(`${row.name} (${row.provider})`)
      lastProvider = row.provider
    }
    const exp = row.expiry === "none" ? "no expiry" : row.expiry === "expired" ? "EXPIRED" : new Date(row.expires).toISOString().slice(0, 16).replace("T", " ")
    const rec = checkins[`${row.provider}|${row.accountId || row.key}`]
    let said = "no check-in recorded"
    if (rec && typeof rec === "object") {
      said = `${rec.outcome ?? "?"} ${rec.day === today ? "today" : String(rec.day ?? "?")}`
      if (Number(rec.credit) > 0) said += ` +${rec.credit}`
      if (Number(rec.streak) > 0) said += ` (${rec.streak}-day streak)`
      if (rec.msg) said += ` — ${oneLine(rec.msg, 60)}`
    }
    const flags = []
    if (!row.hasSecret) flags.push("NO CREDENTIAL")
    if (row.expiry === "expired") flags.push("expired")
    out.push(`  ${row.key.padEnd(24)} ${(row.accountId || "(no account id)").padEnd(18)} ${exp.padEnd(10)} · ${said}${flags.length ? "  ← " + flags.join(", ") : ""}`)
  }
  const { broken, expired, multi } = r.summary
  out.push("")
  if (broken.length) out.push(`! ${broken.length} account(s) hold no credential: ${broken.join(", ")} — re-sign-in needed`)
  if (expired.length) out.push(`! ${expired.length} account(s) expired: ${expired.join(", ")}`)
  if (multi.length) out.push(`· several accounts: ${multi.join(", ")} (magpie rotates among them; no per-account switch exists)`)
  return say(out)
}

/** 只看一个账号（`show`）。 */
function doShow(dir, which) {
  const p = managePreview(dir, which)
  const exp = p.expiry === "none" ? "no expiry" : new Date(p.expires).toISOString()
  return say([
    `key: ${p.key}`,
    `provider: ${p.provider}`,
    `account: ${p.accountId || "(no account id)"}`,
    `type: ${p.type || "(none)"}`,
    `expiry: ${p.expiry} (${exp})`,
    `credential: ${p.hasSecret ? "present" : "MISSING — this account cannot be used"}`,
  ])
}

/** 改名（`rename`）。 */
function doRename(dir, which, to) {
  const r = manageRename(dir, which, to)
  if (!r.changed) return `${r.key} is already named ${JSON.stringify(r.after)}; nothing changed.`
  return say([
    `Renamed ${r.key}: ${JSON.stringify(r.before || "(no account id)")} → ${JSON.stringify(r.after)}.`,
    "magpie reads plugin-auth.json on each request, so the new name is in effect now.",
  ])
}

/** 删除（`remove`）——默认只预览；必须显式 confirm 才真的删。 */
function doRemove(dir, which, confirm) {
  const r = manageRemove(dir, which, { confirm })
  if (!r.confirmed) {
    return say([
      `Would remove ${r.key}  ${r.accountId || "(no account id)"}.`,
      "Nothing was written. This cannot be undone — to actually delete it, call again with confirm=true.",
    ])
  }
  return say([
    `Removed ${r.key}  ${r.accountId || "(no account id)"}.`,
    "This cannot be undone: the credential is gone. To get the account back, sign in to that provider again.",
  ])
}

/**
 * 今日签到实况（`checkin`）。
 *
 * ## 为什么不在这里“跑”签到
 *
 * magpie 已经每天自动签：`internal/provider/plugin_checkin.go:216` 的
 * `KeepPluginsCheckedIn` 按北京日逐个账号签、当天失败稍后重试，结果写进
 * `plugin-checkin.json`；手动触发也有现成入口（`POST /api/usage/plugin-checkin`，
 * Usage 页的按钮就走它）。
 *
 * 插件**不重复实现**定时器，也不自己调 `auth.checkin`：那条路径要求 `getAuth()`，
 * 而刷新 token 后的回写归宿主管；插件另起一条写路径只会在同一份
 * `plugin-auth.json` 上和宿主抢写。
 *
 * 所以这里只做一件事——**把宿主写下的结果整理成人话**，说清「今天谁签了、谁没签、
 * 谁签失败了为什么」。这正是签到系统里唯一还缺的那块：可见性。
 */
function doCheckin(dir, which) {
  const r = manageList(dir)
  if (!r.ok) return r.error
  const checkins = readCheckins(dir)
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const want = String(which || "").trim().toLowerCase()

  // 只看本包的号；`which` 可以收窄到一家 provider 或一个账号。
  const rows = r.rows.filter((row) => !want || row.provider === want || row.key === want)
  if (!rows.length) {
    const scope = want ? `${want} — ` : ""
    return `${scope}no account of this package's five providers. Sign in on magpie's Providers page first.`
  }

  const buckets = { claimed: [], done: [], other: [], none: [], stale: [] }
  for (const row of rows) {
    // 与宿主 `whoOf()` 同序（internal/provider/plugin_checkin.go:60-65）：
    // 有 accountId 用它，否则退化成账号 key。
    const rec = checkins[`${row.provider}|${row.accountId || row.key}`]
    if (!rec || typeof rec !== "object") {
      buckets.none.push(row)
      continue
    }
    if (rec.day !== today) {
      // ⚠️ 关键区分：昨天签到成功 ≠ 今天已签。上游 auto-checkin.ts 在这里
      // 栽过（Qoder 在 10:00 UTC+8 刷新前看到的 CLAIMED 属于昨天）。
      buckets.stale.push({ row, rec })
      continue
    }
    const outcome = String(rec.outcome ?? "")
    if (outcome === "claimed") buckets.claimed.push({ row, rec })
    else if (outcome === "done") buckets.done.push({ row, rec })
    else buckets.other.push({ row, rec })
  }

  const out = []
  out.push(`Today (${today}, UTC+8) — ${rows.length} account${rows.length === 1 ? "" : "s"}:`)
  out.push("")
  if (buckets.claimed.length) {
    out.push(`claimed today (${buckets.claimed.length})`)
    for (const { row, rec } of buckets.claimed) out.push(`  ${oneLine(row.key, 26).padEnd(26)} ${creditOf(rec)}`)
  }
  if (buckets.done.length) {
    out.push(`already in when checked (${buckets.done.length})`)
    for (const { row, rec } of buckets.done) out.push(`  ${oneLine(row.key, 26).padEnd(26)} ${rec.msg ? oneLine(rec.msg, 60) : "already claimed today"}`)
  }
  if (buckets.other.length) {
    out.push(`not claimed (${buckets.other.length})`)
    for (const { row, rec } of buckets.other) {
      out.push(`  ${oneLine(row.key, 26).padEnd(26)} ${String(rec.outcome ?? "?")}${rec.msg ? " — " + oneLine(rec.msg, 70) : ""}`)
    }
  }
  if (buckets.stale.length) {
    out.push(`only an earlier day on record (${buckets.stale.length})`)
    for (const { row, rec } of buckets.stale) {
      out.push(`  ${oneLine(row.key, 26).padEnd(26)} ${String(rec.outcome ?? "?")} on ${rec.day ?? "?"} — not today`)
    }
  }
  if (buckets.none.length) {
    out.push(`never checked in (${buckets.none.length})`)
    for (const row of buckets.none) out.push(`  ${oneLine(row.key, 26).padEnd(26)} no record`)
  }
  out.push("")
  const claimedToday = buckets.claimed.length + buckets.done.length
  out.push(`${claimedToday} in today, ${rows.length - claimedToday} not.`)
  out.push("Check-in runs by itself once a day while the provider's switch is on; magpie's Usage page has the button to do it now.")

  // 只有在“没签”时解释为什么可能没签：签到开关被关、凭据没了。
  const off = rows.filter((row) => !row.hasSecret)
  if (off.length) out.push(`! ${off.length} account(s) hold no credential, so they cannot check in: ${off.map((x) => x.key).join(", ")}`)
  return say(out)
}

/** 一次签到的进账，`credit` 缺失时不给假数字。 */
function creditOf(rec) {
  const bits = []
  if (Number(rec.credit) > 0) bits.push(`+${rec.credit}`)
  if (Number(rec.streak) > 0) bits.push(`${rec.streak}-day streak`)
  if (rec.msg) bits.push(oneLine(rec.msg, 60))
  return bits.length ? bits.join("  ") : "claimed"
}

function doExport(dir) {
  const r = exportToVeyra({ dir })
  if (!r.entries.length) {
    return `Nothing to export: plugin-auth.json has no accounts of this package's five providers.\nfile: ${r.file}`
  }
  const out = []
  out.push(`${r.entries.length} account${r.entries.length === 1 ? "" : "s"} as Veyra entries (skipped ${r.skipped.length}).`)
  out.push(`read from: ${r.file}`)
  out.push(`paste the refs into: ${r.credentialsFile}`)
  out.push("")
  out.push("# refs — one line per account, inside the refs: block")
  out.push(r.refs)
  out.push("")
  out.push("# accounts — merge into state.json's accounts[]")
  out.push(JSON.stringify(r.accounts, null, 2))
  for (const s of r.skipped) out.push(`# skipped ${s.what}: ${s.why}`)
  out.push("")
  out.push("Veyra keeps its own copy in memory, so this is a list to paste, not a file this plugin writes.")
  return out.join("\n")
}

/**
 * 参数自己校验：宿主的 `parsedArgs` 对 JSON Schema **不做**任何检查
 * （`host.js:1546` 原样返回），不自己判就会出现「action 拼错但静默成功」。
 */
function checked(args) {
  const action = typeof args?.action === "string" ? args.action.trim().toLowerCase() : ""
  if (!ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${ACTIONS.join(", ")} (got ${JSON.stringify(args?.action ?? null)})`)
  }
  const account = typeof args?.account === "string" ? args.account.trim() : ""
  const name = typeof args?.name === "string" ? args.name.trim() : ""
  // checkin 的 account 是可选的，而且接受 provider id（看一家）与账号 key（看一个号）。
  if (["show", "rename", "remove"].includes(action) && !account) {
    throw new Error(`action=${action} needs account (a key like codebuddy#a1b2c3, a provider, or an account name)`)
  }
  if (action === "rename" && !name) throw new Error("action=rename needs name (the new account name)")
  return { action, account, name, dryRun: args?.dryRun === true, confirm: args?.confirm === true }
}

const tool = {
  veyra_accounts: {
    description:
      "Look at and manage magpie's accounts. action=all lists every account magpie knows, across all providers, with the same counts magpie's Providers page shows; the other actions work on the five providers this plugin signs in to (CodeBuddy CN/Intl, LobsterAI, CodeArts, Loomy). " +
      "action=list shows those five with expiry and check-in state; action=checkin reports today's check-in per account — what was claimed, what was already in, what failed and why — and takes an optional account to narrow it to one provider or one account; action=show inspects one account; action=rename sets its name; action=remove deletes it (without confirm=true it only reports which account would go — there is no undo); " +
      "action=import brings Veyra's accounts into magpie's plugin-auth.json (idempotent); action=export prints paste-ready Veyra refs and account entries without touching Veyra's files. " +
      "Check-in itself needs no action here: magpie checks every account in once a day on its own while that provider's switch is on, and its Usage page has the button to run it now — this tool reports what came of it. " +
      "magpie has no per-account disable switch: the file has no field for it, so removing or signing out is the only way to take an account out of rotation.",
    args: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description:
            "all = every account magpie knows, all providers; list = this package's five providers with check-in state; checkin = today's check-in per account; show = one account; rename = change its name; remove = delete it; import = Veyra into magpie; export = magpie as Veyra entries",
        },
        account: {
          type: "string",
          description:
            "which account (show/rename/remove require it; checkin takes it optionally): a key like codebuddy#a1b2c3, a provider name like codebuddy (only when it has one account), or an account name. Ambiguous input is rejected with the candidates.",
        },
        name: {
          type: "string",
          description: "rename only: the new account name, 1-64 characters",
        },
        dryRun: {
          type: "boolean",
          description: "import only: report what would be added without writing anything",
        },
        confirm: {
          type: "boolean",
          description:
            "remove only: actually delete. Without it the call only reports which account would go. Deletion cannot be undone.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const { action, account, name, dryRun, confirm } = checked(args)
      const dir = ctx?.directory || ctx?.worktree
      if (!dir) throw new Error("no directory in the tool's context")
      if (action === "all") return { output: doAll(dir) }
      if (action === "list") return { output: doList(dir) }
      if (action === "checkin") return { output: doCheckin(dir, account) }
      if (action === "show") return { output: doShow(dir, account) }
      if (action === "rename") return { output: doRename(dir, account, name) }
      if (action === "remove") return { output: doRemove(dir, account, confirm) }
      if (action === "import") return { output: doImport(dir, dryRun) }
      return { output: doExport(dir) }
    },
  },
}

/**
 * 第六个导出：**只挂工具，不注册 provider**。
 *
 * `host.js` 的 `servers()` 把每个导出函数都当工厂调用，所以这就是合法的插件形态：
 * 返回值里没有 `auth.provider`，它不会出现在 Providers 页，也不会和五家抢 id；
 * 而 `toolsOf(spec)` 是按 spec 收集的，工具对整包可见。
 */
export async function VeyraToolsPlugin() {
  return { tool }
}

export const _internal = { ACTIONS, NAMES, MAP, OURS, list, doAll, doImport, doExport, doList, doCheckin, doShow, doRename, doRemove, checked, readCheckins }
