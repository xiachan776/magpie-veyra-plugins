/**
 * `src/accounts.mjs` 的测试。
 *
 * 这个模块的要害只有一条：**手机上的账号数必须和 Providers 页一致**。
 * 所以这里不测「函数能不能跑」，测的是口径：
 *
 * - 20 家里有号的 6 家、11 个号，一个都不能少、一个都不能多；
 * - 14 家没号的也必须列出来（Providers 页是全列的，裁剪掉就又不一致了）；
 * - 文件被并发写坏时返回 `ok:false` 而不是抛错（列不出账号 ≠ 插件崩了）；
 * - 单个条目残缺只跳过那一行的字段，不连坐整家 provider。
 *
 * 夹具是手写的，不是从真机拷的：真机文件会变（用户随时登录/退出），
 * 测试必须能在一个固定的输入上反复跑。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readProviders, accountsByProvider, providersPathOf } from "../src/accounts.mjs"

/** 造一个临时的 magpie 配置目录，写入给定的 `plugin-providers.json` 内容。 */
function withProviders(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-accounts-"))
  try {
    const file = providersPathOf(dir)
    if (content !== undefined) {
      fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2))
    }
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 一份贴近真机的夹具：6 家有号（11 个账号）、若干家空、一家只有 checkin 没有号。
 *
 * 数字对齐真机的理由：这是用户会拿来跟 Providers 页对照的算式，
 * 期望值写错会让测试本身成为假绿。
 */
const FIXTURE = [
  { id: "zcode", name: "ZCode", signedIn: true, accounts: [{ key: "zcode", type: "oauth", accountId: "15333882338" }] },
  {
    id: "workbuddy-ai",
    name: "WorkBuddy AI",
    signedIn: true,
    accounts: [
      { key: "workbuddy-ai", type: "oauth", accountId: "xiachan315@gmail.com", models: Array(28).fill("m") },
      { key: "workbuddy-ai#j5asbg", type: "oauth", accountId: "xiachan776@gmail.com", models: Array(28).fill("m") },
      { key: "workbuddy-ai#ltbn2v", type: "oauth", accountId: "xiachan010@gmail.com", models: Array(28).fill("m") },
    ],
  },
  { id: "workbuddy", name: "WorkBuddy", signedIn: true, accounts: [{ key: "workbuddy", type: "oauth", accountId: "153****6211" }] },
  { id: "cline", name: "Cline", signedIn: false, accounts: [] },
  { id: "trae-cn", name: "Trae CN", signedIn: false, checkin: {}, accounts: [] },
  { id: "our-free-model", name: "Our Free Model", signedIn: true, accounts: [{ key: "our-free-model", type: "api" }] },
  {
    id: "qoder",
    name: "Qoder",
    signedIn: true,
    checkin: {},
    accounts: [
      { key: "qoder", type: "oauth", accountId: "a@2980.com", models: ["qfmodel", "dfmodel"] },
      { key: "qoder#pxv36y", type: "oauth", accountId: "b@outlook.com", models: ["qfmodel", "dfmodel"] },
      { key: "qoder#qbv6ue", type: "oauth", accountId: "c@outlook.com", models: ["qfmodel", "dfmodel"] },
      { key: "qoder#x5qaeq", type: "oauth", accountId: "d@outlook.com", models: ["qfmodel", "dfmodel"] },
    ],
  },
  { id: "opencode-zen-free", name: "OpenCode Zen Free", signedIn: true, accounts: [{ key: "opencode-zen-free", type: "api" }] },
  { id: "codearts", name: "CodeArts", signedIn: false, checkin: {}, accounts: [] },
  { id: "codebuddy", name: "CodeBuddy", signedIn: false, checkin: {}, accounts: [] },
]

test("账号数与 Providers 页一致：6 家有号、11 个号", () => {
  withProviders(FIXTURE, (dir) => {
    const r = readProviders(dir)
    assert.equal(r.ok, true)
    assert.equal(r.summary.providers, FIXTURE.length)
    assert.equal(r.summary.signedIn, 6)
    assert.equal(r.summary.accounts, 11)
    // 扁平行数必须等于汇总，否则界面上的「11」和列表里的行对不上。
    assert.equal(r.rows.length, 11)
  })
})

test("没号的 provider 也列出来，不会被裁掉", () => {
  withProviders(FIXTURE, (dir) => {
    const g = accountsByProvider(dir)
    assert.equal(g.groups.length, FIXTURE.length)
    const empty = g.groups.filter((x) => x.empty)
    assert.equal(empty.length, FIXTURE.length - 6)
    // 空组也带全字段，界面不用再判 undefined。
    for (const e of empty) {
      assert.equal(e.accountCount, 0)
      assert.deepEqual(e.accounts, [])
      assert.equal(typeof e.name, "string")
      assert.equal(typeof e.checkin, "boolean")
    }
  })
})

test("有 checkin 的 provider 标出来，没有的不标", () => {
  withProviders(FIXTURE, (dir) => {
    const g = accountsByProvider(dir).groups
    const byId = Object.fromEntries(g.map((x) => [x.id, x]))
    assert.equal(byId["qoder"].checkin, true)
    assert.equal(byId["codearts"].checkin, true)
    assert.equal(byId["zcode"].checkin, false)
    assert.equal(byId["cline"].checkin, false)
  })
})

test("账号名按 accountId → key 后缀 → 占位 的顺序取", () => {
  withProviders(
    [
      {
        id: "x",
        name: "X",
        signedIn: true,
        accounts: [
          { key: "x", type: "oauth", accountId: "who@example.com" },
          { key: "x#abc123", type: "oauth" },
          { type: "oauth" },
        ],
      },
    ],
    (dir) => {
      const rows = readProviders(dir).rows
      assert.equal(rows[0].name, "who@example.com")
      assert.equal(rows[1].name, "#abc123")
      assert.equal(rows[2].name, "(no account id)")
      // 没有 key 的行标 keyless，界面据此不给它挂操作。
      assert.equal(rows[2].keyless, true)
      assert.equal(rows[0].keyless, false)
    },
  )
})

test("models 只数字符串，脏值不会把 count 撑大", () => {
  withProviders(
    [{ id: "x", name: "X", accounts: [{ key: "x", models: ["a", 1, null, "b", {}] }] }],
    (dir) => {
      const a = readProviders(dir).rows[0]
      assert.equal(a.modelCount, 2)
      assert.deepEqual(a.models, ["a", "b"])
    },
  )
})

test("文件不存在时返回 ok:false 且带原因，不抛错", () => {
  withProviders(undefined, (dir) => {
    const r = readProviders(dir)
    assert.equal(r.ok, false)
    assert.match(r.error, /plugin-providers\.json/)
    assert.deepEqual(r.providers, [])
    assert.deepEqual(r.rows, [])
    assert.equal(r.summary.accounts, 0)
  })
})

test("文件是坏 JSON 时返回 ok:false，原因里说清是 JSON 坏了", () => {
  withProviders("{not json", (dir) => {
    const r = readProviders(dir)
    assert.equal(r.ok, false)
    assert.match(r.error, /isn't valid JSON/)
  })
})

test("顶层不是数组时按空处理，不抛错", () => {
  withProviders({ nope: true }, (dir) => {
    const r = readProviders(dir)
    assert.equal(r.ok, true)
    assert.equal(r.summary.providers, 0)
    assert.equal(r.summary.accounts, 0)
  })
})

test("单个条目残缺只影响它自己，不连坐同文件的其他家", () => {
  withProviders([null, 42, { id: "good", name: "Good", accounts: [{ key: "good" }] }], (dir) => {
    const r = readProviders(dir)
    assert.equal(r.ok, true)
    // null 与 42 不是对象，直接跳过；good 正常列出。
    assert.equal(r.providers.length, 1)
    assert.equal(r.providers[0].id, "good")
    assert.equal(r.summary.accounts, 1)
  })
})

test("只有 id 没有 name 时退到别名表，再退到 id", () => {
  withProviders([{ id: "workbuddy-ai", accounts: [] }, { id: "never-heard-of-it", accounts: [] }], (dir) => {
    const names = readProviders(dir).providers.map((p) => p.name)
    assert.deepEqual(names, ["WorkBuddy AI", "never-heard-of-it"])
  })
})

test("only 过滤不改变 summary 的口径（只算选中的）", () => {
  withProviders(FIXTURE, (dir) => {
    const r = readProviders(dir, { only: ["qoder"] })
    assert.equal(r.providers.length, 1)
    assert.equal(r.summary.accounts, 4)
    assert.equal(r.summary.signedIn, 1)
  })
})

test("signedIn 缺省是 false，不是 undefined", () => {
  withProviders([{ id: "x", name: "X", accounts: [{ key: "x" }] }], (dir) => {
    const p = readProviders(dir).providers[0]
    assert.equal(p.signedIn, false)
    // 有账号但 signedIn=false —— 这是主程序写到一半才会出现的状态，
    // 工具输出会如实标出来，模块本身不擅自改成 true。
    assert.equal(p.accountCount, 1)
  })
})
