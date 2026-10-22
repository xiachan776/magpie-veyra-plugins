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

import { MAP, OURS, authPathOf, readAuthFile, importFromVeyra, exportToVeyra, dshHome } from "./veyra.mjs"

/** 五个 provider 的显示名，只用于把 key 说得像人话。 */
const NAMES = {
  codebuddy: "CodeBuddy",
  "codebuddy-intl": "CodeBuddy Intl",
  lobsterai: "LobsterAI",
  codearts: "CodeArts",
  loomy: "Loomy",
}

const ACTIONS = ["list", "import", "export"]

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
  return { action, dryRun: args?.dryRun === true }
}

const tool = {
  veyra_accounts: {
    description:
      "List this plugin's Veyra-signed-in accounts (CodeBuddy CN/Intl, LobsterAI, CodeArts, Loomy) with each one's expiry and today's check-in result, and move accounts between Veyra (~/.dsh) and magpie in either direction. " +
      "action=list reads local files only; action=import brings Veyra's accounts into magpie's plugin-auth.json (idempotent, add dryRun=true to preview); " +
      "action=export prints paste-ready Veyra refs and account entries without touching Veyra's files.",
    args: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: "list = accounts and check-in state; import = Veyra into magpie; export = magpie as Veyra entries",
        },
        dryRun: {
          type: "boolean",
          description: "import only: report what would be added without writing plugin-auth.json",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const { action, dryRun } = checked(args)
      const dir = ctx?.directory || ctx?.worktree
      if (!dir) throw new Error("no directory in the tool's context")
      if (action === "list") return { output: list(dir) }
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

export const _internal = { ACTIONS, NAMES, MAP, OURS, list, doImport, doExport, checked, readCheckins }
