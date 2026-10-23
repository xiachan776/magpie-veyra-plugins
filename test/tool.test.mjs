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
  assert.deepEqual(t.args.properties.action.enum, ["all", "list", "checkin", "credits", "show", "rename", "remove", "import", "export"])
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

test("checkin：今日已领 / 已在内 / 失败 / 只记着更早的 / 从没签过，五档分开", async () => {
  const t = (await tool()).veyra_accounts
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const dir = playground(
    {
      codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "a@x.com" },
      "codebuddy#b1": { type: "oauth", access: "a2", refresh: "r2", accountId: "b@x.com" },
      "codebuddy#b2": { type: "oauth", access: "a3", refresh: "r3", accountId: "c@x.com" },
      lobsterai: { type: "oauth", access: "a4", refresh: "r4", accountId: "d@x.com" },
      loomy: { type: "api", key: "k", accountId: "e@x.com" },
    },
    {
      "codebuddy|a@x.com": { day: today, outcome: "claimed", credit: 100, streak: 5 },
      "codebuddy|b@x.com": { day: today, outcome: "done", msg: "already today" },
      "codebuddy|c@x.com": { day: "2026-10-21", outcome: "claimed", credit: 50 },
      "lobsterai|d@x.com": { day: today, outcome: "failed", msg: "captcha required" },
    },
  )
  const out = (await t.execute({ action: "checkin" }, { directory: dir })).output
  assert.match(out, /claimed today \(1\)/)
  assert.match(out, /\+100/)
  assert.match(out, /5-day streak/)
  assert.match(out, /already in when checked \(1\)/)
  assert.match(out, /failed \(1\)/)
  assert.match(out, /captcha required/)
  // 关键区分：10-21 的 claimed 不算今天。
  assert.match(out, /only an earlier day on record \(1\)/)
  assert.match(out, /not today/)
  assert.match(out, /never checked in \(1\)/)
  assert.match(out, /2 in today, 3 not/)
})

test("checkin：可选 account 收窄到一家 provider 或一个账号", async () => {
  const t = (await tool()).veyra_accounts
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const dir = playground(
    {
      codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "a@x.com" },
      "lobsterai": { type: "oauth", access: "b", refresh: "r2", accountId: "b@x.com" },
    },
    { "codebuddy|a@x.com": { day: today, outcome: "claimed", credit: 7 } },
  )
  const one = (await t.execute({ action: "checkin", account: "codebuddy" }, { directory: dir })).output
  assert.match(one, /1 account/)
  assert.match(one, /\+7/)
  assert.doesNotMatch(one, /lobsterai/, "收窄到一家时不该提别家")
  const other = (await t.execute({ action: "checkin", account: "lobsterai" }, { directory: dir })).output
  assert.match(other, /never checked in \(1\)/)
})

test("checkin：没有账号时给出去哪儿登录的指引，不是空串", async () => {
  const t = (await tool()).veyra_accounts
  const out = (await t.execute({ action: "checkin" }, { directory: playground() })).output
  assert.match(out, /no account/)
  assert.match(out, /Providers page/)
})

test("checkin 是只读动作：不写 plugin-auth.json 也不写 plugin-checkin.json", async () => {
  const t = (await tool()).veyra_accounts
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const dir = playground(
    { codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "a@x.com" } },
    { "codebuddy|a@x.com": { day: today, outcome: "claimed", credit: 1 } },
  )
  const auth = fs.readFileSync(path.join(dir, "plugin-auth.json"), "utf8")
  const ck = fs.readFileSync(path.join(dir, "plugin-checkin.json"), "utf8")
  await t.execute({ action: "checkin" }, { directory: dir })
  assert.equal(fs.readFileSync(path.join(dir, "plugin-auth.json"), "utf8"), auth)
  assert.equal(fs.readFileSync(path.join(dir, "plugin-checkin.json"), "utf8"), ck)
})

test("checkin：宿主六类 outcome 分成三种性质，不把没额度说成失败", async () => {
  const t = (await tool()).veyra_accounts
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const dir = playground(
    {
      codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "a@x.com" },
      "codebuddy#b": { type: "oauth", access: "b", refresh: "r", accountId: "b@x.com" },
      lobsterai: { type: "oauth", access: "c", refresh: "r", accountId: "c@x.com" },
      codearts: { type: "oauth", access: "d", refresh: "r", accountId: "d@x.com" },
    },
    {
      // ineligible：今天没额度 —— 不是错
      "codebuddy|a@x.com": { day: today, outcome: "ineligible", msg: "quota used up" },
      // captcha：要人来解，重投没用
      "codebuddy|b@x.com": { day: today, outcome: "captcha", msg: "solve the captcha" },
      // failed：真失败，宿主当天稍后会重投
      "lobsterai|c@x.com": { day: today, outcome: "failed", msg: "500 from server" },
      // inactive：账号闲置，也不算失败
      "codearts|d@x.com": { day: today, outcome: "inactive" },
    },
  )
  const out = (await t.execute({ action: "checkin" }, { directory: dir })).output

  assert.match(out, /not due today \(2\)/, "ineligible 与 inactive 归入不到期，不算失败")
  assert.match(out, /quota used up/)
  assert.match(out, /needs you \(1\)/, "captcha 单独一档，要人处理")
  assert.match(out, /solve the captcha/)
  assert.match(out, /failed \(1\)/, "真失败单独一档")
  assert.match(out, /500 from server/)

  // 三档之间不能互相串：失败那一档里不该出现 captcha 的原因。
  const failedBlock = out.slice(out.indexOf("failed (1)"))
  assert.doesNotMatch(failedBlock, /captcha/)
  assert.match(out, /0 in today, 4 not\./)
})

test("credits：只报记录里真有的数字，并明说余额不在这里", async () => {
  const t = (await tool()).veyra_accounts
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const dir = playground(
    {
      codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "a@x.com" },
      lobsterai: { type: "oauth", access: "b", refresh: "r", accountId: "b@x.com" },
      loomy: { type: "api", key: "k", accountId: "c@x.com" },
    },
    {
      "codebuddy|a@x.com": { day: today, outcome: "claimed", credit: 100, streak: 5, until: "2026-11-30T00:00:00Z" },
      "lobsterai|b@x.com": { day: "2026-10-21", outcome: "claimed", credit: 50, streak: 2 },
    },
  )
  const out = (await t.execute({ action: "credits" }, { directory: dir })).output

  assert.match(out, /\+100 today/)
  assert.match(out, /5-day streak/)
  assert.match(out, /credits end 2026-11-30/)
  // 昨天那笔不能算进今天
  assert.match(out, /last: claimed on 2026-10-21/)
  assert.doesNotMatch(out, /\+50 today/)
  // 没记录如实说
  assert.match(out, /no record yet/)
  // 今日合计只算今天的
  assert.match(out, /100 claimed today/)
  // 余额必须明说不在其中 —— 用户会拿它跟供应商页对账
  assert.match(out, /Balance is not here/)
  assert.match(out, /only magpie reads it/)
})

test("credits：一条记录都没有时直说没东西可加", async () => {
  const t = (await tool()).veyra_accounts
  const dir = playground({ codebuddy: { type: "oauth", access: "a", refresh: "r", accountId: "a@x.com" } })
  const out = (await t.execute({ action: "credits" }, { directory: dir })).output
  assert.match(out, /no record yet/)
  assert.match(out, /No check-in has run yet/)
  assert.match(out, /0 claimed today/)
})

test("credits：没有本包账号时给出去哪儿登录的指引", async () => {
  const t = (await tool()).veyra_accounts
  const out = (await t.execute({ action: "credits" }, { directory: playground() })).output
  assert.match(out, /no account/)
  assert.match(out, /Providers page/)
})
