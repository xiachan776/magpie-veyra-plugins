/**
 * 第六个导出（`VeyraToolsPlugin`）的契约测试。
 *
 * 它和五家 provider 工厂的不同点值得单独锁住：**没有 `auth` 钩子**，只挂
 * `tool`。宿主 `withProviders()` 在 `signsIn(spec)` 为空时直接返回（`host.js:1416-1424`），
 * 所以「只挂工具、不注册 provider」是合法形态；但正因为没有 `auth.provider`，
 * Providers 页不会多一行，装错了也没有任何报错 —— 只能靠这里挡住。
 *
 * 不联网、不读真实的 `plugin-auth.json`：所有 case 都在临时目录里造数据。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { VeyraToolsPlugin } from "../index.mjs"

const TOOL_NAME = /^[A-Za-z0-9_-]{1,48}$/

/** 造一个只含 `plugin-auth.json` / `plugin-checkin.json` 的假 magpie 配置目录。 */
function playground(auth = {}, checkins = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-tool-"))
  fs.writeFileSync(path.join(dir, "plugin-auth.json"), JSON.stringify(auth, null, 2))
  if (Object.keys(checkins).length) {
    fs.writeFileSync(path.join(dir, "plugin-checkin.json"), JSON.stringify(checkins, null, 2))
  }
  return dir
}

const tool = async () => {
  const hooks = (await VeyraToolsPlugin({})) ?? {}
  return hooks.tool
}

test("工厂返回 tool 钩子，且不注册任何 provider", async () => {
  const hooks = (await VeyraToolsPlugin({})) ?? {}
  assert.equal(hooks.auth, undefined, "挂 auth 会让它出现在 Providers 页，抢五家的 id")
  assert.equal(typeof hooks.tool, "object")
  assert.deepEqual(Object.keys(hooks.tool), ["veyra_accounts"])
})

test("工具名与 description 合宿主约束（host.js:1434 / toolList 截 2000）", async () => {
  const t = (await tool()).veyra_accounts
  for (const name of Object.keys({ veyra_accounts: t })) assert.match(name, TOOL_NAME)
  assert.equal(typeof t.description, "string")
  assert.ok(t.description.length > 0 && t.description.length <= 2000)
  assert.equal(typeof t.execute, "function")
})

test("args 是纯 JSON Schema（宿主对 JSON Schema 不校验，得自己判）", async () => {
  const t = (await tool()).veyra_accounts
  assert.equal(t.args.type, "object")
  assert.deepEqual(Object.keys(t.args.properties).sort(), ["account", "action", "confirm", "dryRun", "name"])
  assert.deepEqual(t.args.properties.action.enum, ["list", "show", "rename", "remove", "import", "export"])
  // 只有 action 是必需的：account/name 只对部分 action 有意义，由 checked() 按 action 判。
  assert.deepEqual(t.args.required, ["action"])
})

test("action 拼错 / 缺失都抛错，不静默成功", async () => {
  const t = (await tool()).veyra_accounts
  const ctx = { directory: playground() }
  for (const args of [undefined, null, {}, { action: "" }, { action: "nope" }, { action: 42 }]) {
    await assert.rejects(() => t.execute(args, ctx), /action must be one of/, `arg ${JSON.stringify(args)}`)
  }
})

test("action 大小写不敏感（模型常写 LIST）", async () => {
  const t = (await tool()).veyra_accounts
  const r = await t.execute({ action: "LIST" }, { directory: playground() })
  assert.equal(typeof r.output, "string")
})

test("show / rename / remove 缺 account 时抛错，且错误里说清要什么", async () => {
  const t = (await tool()).veyra_accounts
  const ctx = { directory: playground() }
  for (const action of ["show", "rename", "remove"]) {
    await assert.rejects(() => t.execute({ action }, ctx), /needs account/, action)
  }
  await assert.rejects(() => t.execute({ action: "rename", account: "codebuddy" }, ctx), /needs name/)
})

test("全部管理动作都拒绝别家插件的账号，且不写盘", async () => {
  const t = (await tool()).veyra_accounts
  const dir = playground({ zcode: { type: "oauth", access: "a", refresh: "r", accountId: "zc" } })
  const file = path.join(dir, "plugin-auth.json")
  const before = fs.readFileSync(file, "utf8")
  for (const args of [
    { action: "show", account: "zcode" },
    { action: "rename", account: "zcode", name: "x" },
    { action: "remove", account: "zcode", confirm: true },
  ]) {
    await assert.rejects(() => t.execute(args, { directory: dir }), /only codebuddy/i, args.action)
  }
  assert.equal(fs.readFileSync(file, "utf8"), before, "拒绝路径不能改动文件")
})

test("rename 改完名字，后续 list 读到的是新名字", async () => {
  const t = (await tool()).veyra_accounts
  const dir = playground({ codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "138****1111" } })
  const r1 = await t.execute({ action: "rename", account: "codebuddy", name: "主力号" }, { directory: dir })
  assert.match(r1.output, /Renamed/)
  const r2 = await t.execute({ action: "list" }, { directory: dir })
  assert.match(r2.output, /主力号/)
  assert.doesNotMatch(r2.output, /138\*\*\*\*1111/)
})

test("remove 默认只预览；必须显式 confirm 才真的删", async () => {
  const t = (await tool()).veyra_accounts
  const dir = playground({ codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "keep-me" } })
  const preview = await t.execute({ action: "remove", account: "codebuddy" }, { directory: dir })
  assert.match(preview.output, /Would remove/)
  assert.match(preview.output, /cannot be undone/i)
  const after = await t.execute({ action: "list" }, { directory: dir })
  assert.match(after.output, /keep-me/, "不传 confirm 时绝不能真的删掉")

  const gone = await t.execute({ action: "remove", account: "codebuddy", confirm: true }, { directory: dir })
  assert.match(gone.output, /Removed/)
  const empty = await t.execute({ action: "list" }, { directory: dir })
  assert.match(empty.output, /No accounts/)
})

test("list 空库时说清下一步，不报错", async () => {
  const t = (await tool()).veyra_accounts
  const r = await t.execute({ action: "list" }, { directory: playground() })
  assert.match(r.output, /No accounts/)
  assert.match(r.output, /action=import/)
})

test("list 只列本包五家，别家插件的一律不出现", async () => {
  const t = (await tool()).veyra_accounts
  const dir = playground({
    codebuddy: { type: "oauth", access: "a", refresh: "r", expires: 4102444800000, accountId: "someone" },
    "lobsterai#abc123": { type: "oauth", access: "a", refresh: "r", accountId: "182****7250" },
    zcode: { type: "oauth", access: "a", refresh: "r", accountId: "15333882338" },
    qoder: { type: "oauth", access: "a", refresh: "r" },
  })
  const r = await t.execute({ action: "list" }, { directory: dir })
  assert.match(r.output, /CodeBuddy \(codebuddy\)/)
  assert.match(r.output, /LobsterAI \(lobsterai\)/)
  assert.match(r.output, /someone/)
  assert.doesNotMatch(r.output, /zcode/, "zcode 是社区插件的，列出来会让人以为本包能管")
  assert.doesNotMatch(r.output, /qoder/)
})

test("list 把今天的签到结果读出来（含 credit 与 streak）", async () => {
  const t = (await tool()).veyra_accounts
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const dir = playground(
    { codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "who1" } },
    { "codebuddy|who1": { day: today, at: "x", outcome: "claimed", credit: 320, streak: 7 } },
  )
  const r = await t.execute({ action: "list" }, { directory: dir })
  assert.match(r.output, /claimed today/)
  assert.match(r.output, /\+320/)
  assert.match(r.output, /7-day streak/)
})

test("list 对坏掉的 plugin-auth.json 报一句人话，不抛", async () => {
  const t = (await tool()).veyra_accounts
  const dir = playground()
  fs.writeFileSync(path.join(dir, "plugin-auth.json"), "{ not json")
  const r = await t.execute({ action: "list" }, { directory: dir })
  assert.match(r.output, /can't be read/)
})

test("export 空库时说不导出，并给出文件路径", async () => {
  const t = (await tool()).veyra_accounts
  const r = await t.execute({ action: "export" }, { directory: playground() })
  assert.match(r.output, /Nothing to export/)
  assert.match(r.output, /plugin-auth\.json/)
})

test("export 产出可贴的 refs 与 accounts，且明说不动 Veyra 的文件", async () => {
  const t = (await tool()).veyra_accounts
  const dir = playground({
    codebuddy: { type: "oauth", access: "A", refresh: "R", expires: 4102444800000, accountId: "who1" },
  })
  const r = await t.execute({ action: "export" }, { directory: dir })
  // ref 名照 Veyra 自己的形状：BUDDY_ACCOUNT_<8 位大写 hex>
  // （真机 ~/.dsh/.credentials.yaml 里就是 BUDDY ×9 / BUDDY_INTL ×1 / LOBSTERAI ×5 / LOOMY ×1）
  assert.match(r.output, /BUDDY_ACCOUNT_[0-9A-F]{8}:/, "ref 名要与 Veyra 同形")
  assert.match(r.output, /"provider": "veyra-buddy"/)
  assert.match(r.output, /paste the refs into/)
  assert.match(r.output, /not a file this plugin writes/)
})

test("export 的 ref 前缀逐家对齐 Veyra 的既有命名", async () => {
  const t = (await tool()).veyra_accounts
  // 每家的凭据存放位置不同，必须照真实形状造：
  //   codebuddy 系列 → 令牌平铺在 oauth 上（access / refresh / uid…）
  //   lobsterai      → 整份 credential JSON 压在 access 里（见 src/lobsterai.mjs 的 pack）
  //   loomy          → 走 api 型，整份 JSON 压 key 里
  const dir = playground({
    codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "1" },
    "codebuddy-intl": { type: "oauth", access: "a", refresh: "r", accountId: "2" },
    lobsterai: {
      type: "oauth",
      access: JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: "0", nickname: "3" }),
      refresh: "r",
      accountId: "182****7250",
    },
    loomy: { type: "api", key: JSON.stringify({ session: "s", userid: "u", phone: "18800000000", expires: 0 }), accountId: "18800000000" },
  })
  const r = await t.execute({ action: "export" }, { directory: dir })
  assert.match(r.output, /skipped 0/, `不该有跳过的：${r.output}`)
  for (const p of ["BUDDY", "BUDDY_INTL", "LOBSTERAI", "LOOMY"]) {
    assert.match(r.output, new RegExp(`${p}_ACCOUNT_[0-9A-F]{8}:`), `${p} 的 ref 前缀`)
  }
})

test("import 在没有 Veyra 的机器上不炸（dryRun 只读到空）", async () => {
  const t = (await tool()).veyra_accounts
  const dir = playground()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-home-"))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const r = await t.execute({ action: "import", dryRun: true }, { directory: dir })
    assert.match(r.output, /Would add 0/)
    assert.match(r.output, /Nothing was written/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "plugin-auth.json"), "utf8")), {})
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
})

test("ctx 没有 directory 时抛错（不能瞎猜路径）", async () => {
  const t = (await tool()).veyra_accounts
  await assert.rejects(() => t.execute({ action: "list" }, {}), /no directory/)
})
