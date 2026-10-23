#!/usr/bin/env node
// 比对 Veyra 里那些「协议源文件」的哈希，看本插件的实现依据有没有过期。
//
// 为什么要单独列一张表：本包复刻的是协议而不是代码 —— 端点、请求头、签名算法、
// 模型目录、积分与签到端点。这些东西只在 Veyra 的少数几个 src/*.ts 里，改一行
// 就可能让本包的某个请求头失效，而那种失效在 magpie 里表现为「上游 400」，
// 排查时完全看不出是上游改了协议。
//
// 用法：
//   node scripts/upstream.mjs --dir <Veyra 检出目录>            # 打印差异
//   node scripts/upstream.mjs --dir <dir> --write              # 更新 upstream.json
//   node scripts/upstream.mjs --dir <dir> --check              # 有差异退出码 1
//   node scripts/upstream.mjs --dir <dir> --json               # 机器可读输出

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const LEDGER = join(here, "..", "upstream.json")

// WATCHED 是本包实现所依据的每一个上游文件，以及它管着本包的哪一块。
// 加新 provider 时先在这里加行，否则漂移检查看不见它。
export const WATCHED = [
  ["src/product.ts", "codebuddy / codebuddy-intl：四产品常量、端点、UA、兜底模型表"],
  ["src/buddy.ts", "腾讯系头部常量、登录与模型端点路径"],
  ["src/buddy-oauth.ts", "腾讯系登录三步（state → token → account）与续期"],
  ["src/buddy-adapter.ts", "CodeBuddy 出站头与请求体"],
  ["src/lobsterai.ts", "LobsterAI 端点、信封、token 解析"],
  ["src/lobsterai-product.ts", "LobsterAI 端点与产品常量"],
  ["src/lobsterai-oauth.ts", "LobsterAI 本地回调登录与 exchange"],
  ["src/lobsterai-adapter.ts", "LobsterAI 请求体（stream 恒 true、无 tool_choice、无图）"],
  ["src/lobsterai-credits.ts", "LobsterAI 签到与积分"],
  ["src/llm-adapter.ts", "CodeArts 请求体、模型表、上下文窗口、max_tokens 上限"],
  ["src/sign.ts", "华为云 SDK-HMAC-SHA256 签名"],
  ["src/oauth.ts", "CodeArts PKCE + DPoP 与 STS token 交换"],
  ["src/login.ts", "CodeArts 登录 URL 与回调（不能带 auth_callback_url、端口 ≥10000）"],
  ["src/models.ts", "CodeArts 两个模型源、benefit 集合、视觉模型过滤"],
  ["src/codearts-credits.ts", "CodeArts 积分与签到三步"],
  ["src/loomy.ts", "Loomy 端点、信封、两套认证头"],
  ["src/loomy-sign.ts", "讯飞 CAccount HMAC-SHA1 签名"],
  ["src/loomy-oauth.ts", "Loomy 短信两步登录"],
  ["src/loomy-adapter.ts", "Loomy 请求体与模型目录"],
  ["src/loomy-product.ts", "Loomy 兜底模型表与图片能力覆盖"],
  ["src/loomy-credits.ts", "Loomy 积分与签到"],
]

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16)

// 一个被监视文件管的是哪套系统。签到与积分改动风险最高 —— 那两套的协议一改，
// 本包的 `veyra_accounts checkin` / `credits` 就会静默拿到错误结果而不是报错，
// 所以报告里先列它们。
const AREA = (rel) => {
  if (/checkin/i.test(rel)) return "checkin"
  if (/credit/i.test(rel)) return "credits"
  return "protocol"
}

const AREA_CN = { checkin: "签到", credits: "积分", protocol: "协议" }

/** 跑一条 git 命令，拿不到就返回 null（上游目录可能不是 git 检出）。 */
function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim()
  } catch {
    return null
  }
}

/** 上游 HEAD 的短 sha 与日期；非 git 目录时两项都是 null。 */
function head(dir) {
  const sha7 = git(dir, ["rev-parse", "--short", "HEAD"])
  const when = git(dir, ["log", "-1", "--format=%cs"])
  return { sha: sha7 || null, date: when || null }
}

/** 一个文件自 `since` 以来的提交数，和增删行数；查不到就是 null。 */
function churn(dir, rel, since) {
  const range = since ? `${since}..HEAD` : "HEAD"
  const n = git(dir, ["rev-list", "--count", range, "--", rel])
  const stats = git(dir, ["diff", "--numstat", range, "--", rel])
  let added = null
  let removed = null
  if (stats) {
    // 二进制文件是 "-\t-\tpath"，那时行数无意义
    for (const line of stats.split("\n")) {
      const [a, d, p] = line.split("\t")
      if (p !== rel) continue
      if (a !== "-" && d !== "-") {
        added = (added ?? 0) + Number(a)
        removed = (removed ?? 0) + Number(d)
      }
    }
  }
  return { commits: n === null ? null : Number(n), added, removed }
}

function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"))
  } catch {
    return { files: {} }
  }
}

/** 现状：每个被监视文件在 dir 里的哈希；文件不在就记 null。 */
export function fingerprint(dir) {
  const files = {}
  for (const [rel, why] of WATCHED) {
    const p = join(dir, rel)
    files[rel] = { sha: existsSync(p) ? sha(readFileSync(p)) : null, why }
  }
  return files
}

/** 与账本比，返回变了的文件。账本为空时（首次）每个文件都算「新」。 */
export function drift(now, ledger = readLedger()) {
  const was = ledger.files ?? {}
  // 账本里一个都没有 ⇒ 还没 --write 过，别假装「一致」
  const base = Object.keys(was).length ? was : Object.fromEntries(Object.keys(now).map((k) => [k, { sha: null }]))
  const out = []
  for (const [rel, entry] of Object.entries(base)) {
    const is = now[rel]?.sha ?? null
    if (entry?.sha !== is) out.push({ file: rel, was: entry?.sha ?? null, is })
  }
  return out
}

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const flag = (name) => process.argv.includes(name)

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("upstream.mjs")) {
  const dir = resolve(arg("--dir", process.env.VEYRA_DIR ?? ""))
  if (!dir || dir === resolve("")) {
    console.error("用法: node scripts/upstream.mjs --dir <Veyra 检出目录> [--check|--write|--json]")
    process.exit(2)
  }
  const now = fingerprint(dir)
  const seen = Object.values(now).filter((f) => f.sha).length
  if (seen === 0) {
    console.error(`${dir} 里一个被监视的文件都没有 —— 是 Veyra 的检出目录吗？`)
    process.exit(2)
  }

  if (flag("--write")) {
    // 账本同时记下上游 HEAD —— 下次报告靠它算出「自上次同步以来改了多少」
    const ledger = { files: now, head: head(dir), updated: new Date().toISOString() }
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n")
    console.log(`upstream.json 已更新（${seen}/${WATCHED.length} 个文件）`)
    process.exit(0)
  }

  const changed = drift(now)

  const ledger = readLedger()
  const since = ledger.head?.sha ?? null
  const upstreamHead = head(dir)

  // 补上「改了什么」：归类、自上次同步以来的提交数与增删行数
  const detailed = changed.map((c) => ({
    ...c,
    why: now[c.file]?.why ?? null,
    area: AREA(c.file),
    ...churn(dir, c.file, since),
  }))

  if (flag("--json")) {
    console.log(
      JSON.stringify(
        { dir, seen, total: WATCHED.length, head: upstreamHead, since, changed: detailed },
        null,
        2,
      ),
    )
  } else if (detailed.length === 0) {
    console.log(`与 upstream.json 一致（${seen}/${WATCHED.length} 个文件）`)
  } else {
    const byArea = { checkin: [], credits: [], protocol: [] }
    for (const c of detailed) byArea[c.area].push(c)

    const headLine = upstreamHead.sha
      ? `上游 HEAD ${upstreamHead.sha}（${upstreamHead.date}）`
      : "上游不是 git 检出，查不到提交"
    const sinceLine = since ? `，自上次同步 ${since} 起` : "（账本里没有记录过基线 HEAD）"
    console.log(`${detailed.length} 个上游文件变了 — ${headLine}${sinceLine}：`)

    for (const area of ["checkin", "credits", "protocol"]) {
      const list = byArea[area]
      if (!list.length) continue
      console.log(`\n[${AREA_CN[area]}] ${list.length} 个`)
      for (const c of list) {
        const tail = c.commits === null ? "" : `  ${c.commits} 次提交`
        const lines = c.added === null ? "" : ` +${c.added}/-${c.removed} 行`
        console.log(`  ${c.file}  ${c.was ?? "(新)"} → ${c.is ?? "(没了)"}${tail}${lines}`)
        if (c.why) console.log(`      ${c.why}`)
      }
    }

    const risky = byArea.checkin.length + byArea.credits.length
    if (risky) {
      console.log(
        `\n其中 ${risky} 个管签到与积分。这两套协议变了不会报错，只会让 veyra_accounts 的\n` +
          `checkin / credits 拿到错的结果，所以先对它们做一次真实调用再信结论。`,
      )
    }
  }
  process.exit(flag("--check") && changed.length > 0 ? 1 : 0)
}
