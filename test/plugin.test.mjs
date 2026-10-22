/**
 * 把五个插件工厂按 magpie 宿主的方式真调一遍，锁住契约。
 *
 * 这些测试**不联网**：宿主契约（导出、返回形状、config 写法、方法类型）
 * 全部是本地可判定的，而它们恰好是「装进 magpie 就整个不出现」那类故障的唯一
 * 拦路虎 —— 例如 auth hook 少了 `provider` 字段，插件照样加载成功，只是
 * Providers 页永远多不出一行，且没有任何错误。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  CodeArtsPlugin,
  CodeBuddyIntlPlugin,
  CodeBuddyPlugin,
  LobsterAIPlugin,
  LoomyPlugin,
} from "../index.mjs"

/** 宿主给插件的 input（`internal/plugin/host.js` 的 `loadPlugins`）。 */
const input = () => ({
  client: { app: { log() {} } },
  project: { id: "magpie", worktree: process.cwd(), vcs: undefined, time: { created: Date.now() } },
  directory: process.cwd(),
  worktree: process.cwd(),
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://127.0.0.1:4096"),
  magpie: { option: () => false, options: () => ({}) },
})

const PLUGINS = [
  ["codebuddy", CodeBuddyPlugin],
  ["codebuddy-intl", CodeBuddyIntlPlugin],
  ["lobsterai", LobsterAIPlugin],
  ["codearts", CodeArtsPlugin],
  ["loomy", LoomyPlugin],
]

/** 按宿主的顺序跑一次：`fn(input, options)`，再逐个 `config` hook。 */
async function load(fn) {
  const hooks = (await fn(input(), undefined)) ?? {}
  const config = { provider: {} }
  if (typeof hooks.config === "function") await hooks.config(config)
  return { hooks, config }
}

for (const [id, fn] of PLUGINS) {
  test(`${id}: 工厂可调用并返回 auth hook`, async () => {
    const { hooks } = await load(fn)
    assert.equal(typeof hooks, "object")
    assert.equal(hooks.auth?.provider, id, "auth.provider 决定 provides；缺了 Providers 页不会多出一行")
    assert.equal(typeof hooks.auth.loader, "function")
    assert.ok(Array.isArray(hooks.auth.methods) && hooks.auth.methods.length > 0)
    for (const m of hooks.auth.methods) {
      assert.ok(["oauth", "api"].includes(m.type), `${id}: 未知方法类型 ${m.type}`)
      assert.equal(typeof m.label, "string")
      assert.ok(m.label.length > 0 && m.label.length <= 60, `${id}: label 必须 ≤60 字符`)
    }
  })

  test(`${id}: config 写出的模型条目可被宿主读成目录`, async () => {
    const { config } = await load(fn)
    const p = config.provider[id]
    assert.ok(p, `${id}: config 没写自己的 provider`)
    assert.equal(typeof p.name, "string")
    assert.equal(p.npm, "@ai-sdk/openai-compatible")
    assert.match(p.api, /^https:\/\//)
    const models = Object.entries(p.models ?? {})
    assert.ok(models.length > 0, `${id}: 兜底模型表是空的`)
    for (const [key, m] of models) {
      assert.equal(typeof m.name, "string", `${id}/${key}: name`)
      assert.equal(typeof m.limit?.context, "number", `${id}/${key}: limit.context`)
      assert.ok(m.limit.context >= 0)
      if (m.variants) {
        // 宿主把 variants 的**键**当档位名（internal/provider/plugins.go:202）
        for (const e of Object.keys(m.variants)) {
          assert.ok(
            ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(e),
            `${id}/${key}: magpie 不认识档位 ${e}`,
          )
        }
      }
    }
  })

  test(`${id}: loader 在未登录时返回空对象而不是抛错`, async () => {
    const { hooks } = await load(fn)
    const opts = await hooks.auth.loader(async () => ({ type: "api", key: "not-ours" }))
    assert.deepEqual(opts, {}, "未登录要回 {}，抛错会让整个 provider 在列表里报错")
  })

  test(`${id}: usage 在未登录时如实说没登录并打 kept`, async () => {
    const { hooks } = await load(fn)
    if (typeof hooks.auth.usage !== "function") return
    const u = await hooks.auth.usage(async () => ({ type: "api", key: "not-ours" }))
    assert.equal(u.signIn, "kept", "不打 kept 会让 magpie 把账号标成过期")
    assert.equal(typeof u.error, "string")
  })
}

test("五个 provider id 互不重复，且都不占用 magpie 内置或社区插件已有的 id", async () => {
  const ids = []
  for (const [, fn] of PLUGINS) {
    const { hooks } = await load(fn)
    ids.push(hooks.auth.provider)
  }
  assert.deepEqual(ids, ["codebuddy", "codebuddy-intl", "lobsterai", "codearts", "loomy"])
  const taken = new Set([
    "zcode", "qoder", "qoder-cn", "devin", "zed", "factory", "grok", "commandcode-plan",
    "mimo-app", "cursor", "kiro", "workbuddy", "workbuddy-ai", "cline", "trae-cn",
    "trae-global", "raccoon", "opencode-zen-free", "autoclaw", "kimi-work",
    "claude", "codex", "copilot", "gemini", "antigravity",
  ])
  for (const id of ids) assert.ok(!taken.has(id), `${id} 已被内置或社区插件占用，会互相抢签名`)
})

test("checkin 只报宿主认的 outcome（internal/plugin/host.js:2329）", async () => {
  const outcomes = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]
  for (const [id, fn] of PLUGINS) {
    const { hooks } = await load(fn)
    if (typeof hooks.auth.checkin !== "function") continue
    // 未登录这一路是唯一不联网就能走到的分支
    const r = await hooks.auth.checkin(async () => ({ type: "api", key: "not-ours" }))
    assert.ok(outcomes.includes(r.outcome), `${id}: 未知 outcome ${r.outcome}`)
    assert.equal(typeof r.message, "string")
  }
})

test("VERSION 与 package.json 一致（发版时最容易忘记的一处）", async () => {
  const { VERSION } = await import("../index.mjs")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(VERSION, pkg.version)
})

test("provider 图标合宿主要求（host.js:1850：https 或 data:image，≤1.5 MB）", async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const icon = pkg.magpie?.icon
  assert.equal(typeof icon, "string", "没有 magpie.icon 时 Providers 页的卡片就没有图标")
  assert.match(icon, /^(https:\/\/|data:image\/)/i, "相对路径会被 iconOf() 静默丢掉")
  assert.ok(icon.length <= 3 << 19)
})
