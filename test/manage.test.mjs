/**
 * `manage.mjs` 的契约测试。
 *
 * 这些测试挡的是几件真会伤到人的事：
 *
 * 1. **不许碰别人家的账号。** `plugin-auth.json` 是混装文件，误删一个 zcode
 *    账号等于让人家重新登录一次。
 * 2. **歧义必须报错而不是猜。** 删除没有 undo，「大概是这个」是最坏的推断。
 * 3. **dryRun 必须真的不写盘。** 一个「预览」把数据删掉，比没有预览更坏。
 * 4. **写盘必须走锁协议。** 宿主可能正在同一个文件里刷新 token。
 *
 * 全部在临时目录里跑，不读真实的 magpie 配置。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { list, preview, remove, rename, resolveKey, isOurs } from "../src/manage.mjs"
import { changeAuth, readAuthFile } from "../src/veyra.mjs"

/** 造一个含「本包的号 + 别人家的号」的 magpie 配置目录。 */
function playground(auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-manage-"))
  fs.writeFileSync(path.join(dir, "plugin-auth.json"), JSON.stringify(auth, null, 2))
  return dir
}

const CODEBUDDY = { type: "oauth", access: "at-1", refresh: "rt-1", expires: Date.now() + 3600_000, accountId: "138****1111" }
const CODEBUDDY2 = { type: "oauth", access: "at-2", refresh: "rt-2", expires: Date.now() + 3600_000, accountId: "139****2222" }
const LOOMY = { type: "api", key: JSON.stringify({ session: "s-1", userid: "u1" }), metadata: { accountId: "loomy-user" } }
const ZCODE = { type: "oauth", access: "zc", refresh: "zc-r", expires: Date.now() + 3600_000, accountId: "someone" }

test("只列出本包五家的账号，别人家的账号一律不出现", () => {
  const dir = playground({ codebuddy: CODEBUDDY, loomy: LOOMY, zcode: ZCODE, "qoder#a1b2c3": ZCODE })
  const r = list(dir)
  assert.equal(r.ok, true)
  assert.deepEqual(
    r.rows.map((x) => x.key).sort(),
    ["codebuddy", "loomy"],
    "zcode 与 qoder 归社区插件管，本包不该列出来",
  )
  assert.equal(r.summary.total, 2)
})

test("isOurs 只认五家，别家的 key 一律 false", () => {
  for (const k of ["codebuddy", "codebuddy#x", "codebuddy-intl", "lobsterai#1", "codearts", "loomy#9"]) {
    assert.equal(isOurs(k), true, k)
  }
  for (const k of ["zcode", "qoder#x", "", "codebuddyy", "codebuddy-"]) {
    assert.equal(isOurs(k), false, k)
  }
})

test("诊断能指出没有凭据的坏行与已过期的账号", () => {
  const dir = playground({
    codebuddy: { type: "oauth", access: "", refresh: "", expires: 0, accountId: "broken" },
    "codebuddy#a1b2c3": { type: "oauth", access: "a", refresh: "r", expires: Date.now() - 1000, accountId: "old" },
  })
  const r = list(dir)
  assert.deepEqual(r.summary.broken, ["codebuddy"])
  assert.deepEqual(r.summary.expired, ["codebuddy#a1b2c3"])
  assert.equal(r.rows.find((x) => x.key === "codebuddy").hasSecret, false)
  assert.equal(r.rows.find((x) => x.key === "codebuddy#a1b2c3").expiry, "expired")
})

test("resolveKey 支持 key / provider / 账号名，且必须唯一命中", () => {
  const all = { codebuddy: CODEBUDDY, "codebuddy#a1b2c3": CODEBUDDY2, loomy: LOOMY, zcode: ZCODE }
  assert.equal(resolveKey(all, "codebuddy#a1b2c3"), "codebuddy#a1b2c3")
  assert.equal(resolveKey(all, "138****1111"), "codebuddy")
  assert.equal(resolveKey(all, "loomy"), "loomy")
  // provider 有两个账号 → 歧义
  assert.throws(() => resolveKey(all, "codebuddy"), /ambiguous/i)
  // 别人家的账号 → 明确拒绝
  assert.throws(() => resolveKey(all, "zcode"), /only codebuddy/i)
  assert.throws(() => resolveKey(all, ""), /which account/i)
  assert.throws(() => resolveKey(all, "nobody"), /no account/i)
})

test("rename 只改 accountId，不动 metadata 与凭据本体", () => {
  const dir = playground({ loomy: LOOMY })
  const r = rename(dir, "loomy", "我的 Loomy")
  assert.equal(r.changed, true)
  assert.equal(r.after, "我的 Loomy")
  const after = readAuthFile(path.join(dir, "plugin-auth.json")).loomy
  assert.equal(after.accountId, "我的 Loomy")
  assert.equal(after.key, LOOMY.key, "key 是凭据本体，不能被名字改到")
  assert.equal(after.metadata.accountId, "loomy-user", "metadata 里那份是别的插件写的，不该跟着改")
})

test("rename 到同名不算改动，且不写盘（不动 mtime）", () => {
  const dir = playground({ codebuddy: CODEBUDDY })
  const file = path.join(dir, "plugin-auth.json")
  const before = fs.statSync(file).mtimeMs
  const r = rename(dir, "codebuddy", "138****1111")
  assert.equal(r.changed, false)
  assert.equal(fs.statSync(file).mtimeMs, before, "没有实际改动就不该碰文件")
})

test("remove 不给 confirm 时一律不写盘", () => {
  const dir = playground({ codebuddy: CODEBUDDY, loomy: LOOMY })
  const file = path.join(dir, "plugin-auth.json")
  const before = fs.readFileSync(file, "utf8")

  const r = remove(dir, "codebuddy")
  assert.equal(r.removed, false)
  assert.equal(r.key, "codebuddy", "预览也要能说出选到了谁")
  assert.equal(fs.readFileSync(file, "utf8"), before, "dryRun 必须一个字都不写")
})

test("remove 给了 confirm 才真的删，且别人家的账号不受影响", () => {
  const dir = playground({ codebuddy: CODEBUDDY, loomy: LOOMY, zcode: ZCODE })
  const r = remove(dir, "codebuddy", { confirm: true })
  assert.equal(r.removed, true)
  const after = readAuthFile(path.join(dir, "plugin-auth.json"))
  assert.equal(after.codebuddy, undefined)
  assert.ok(after.loomy, "同一次删除不该动到别的 provider")
  assert.ok(after.zcode, "更要紧的是别动别人家的账号")
})

test("remove 拒绝歧义输入，且一个字节都不改", () => {
  const dir = playground({ codebuddy: CODEBUDDY, "codebuddy#a1b2c3": CODEBUDDY2 })
  const file = path.join(dir, "plugin-auth.json")
  const before = fs.readFileSync(file, "utf8")
  assert.throws(() => remove(dir, "codebuddy", { confirm: true }), /ambiguous/i)
  assert.equal(fs.readFileSync(file, "utf8"), before)
})

test("preview 给出单个账号的现状，包括有没有凭据", () => {
  const dir = playground({ codebuddy: CODEBUDDY, "loomy#zzz": { type: "api", key: "" } })
  const p = preview(dir, "codebuddy")
  assert.equal(p.key, "codebuddy")
  assert.equal(p.accountId, "138****1111")
  assert.equal(p.hasSecret, true)
  assert.equal(p.expiry, "ok")

  const bad = preview(dir, "loomy#zzz")
  assert.equal(bad.hasSecret, false, "空 key 的账号必须被标成没有凭据")
})

test("文件读不懂时 list 报错而不是当成空", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyra-manage-bad-"))
  fs.writeFileSync(path.join(dir, "plugin-auth.json"), "{ this is not json")
  const r = list(dir)
  assert.equal(r.ok, false)
  assert.match(r.error, /can't be read/i)
})

test("写盘后不留锁文件，也不留临时文件", () => {
  const dir = playground({ codebuddy: CODEBUDDY })
  remove(dir, "codebuddy", { confirm: true })
  const leftovers = fs.readdirSync(dir).filter((f) => f !== "plugin-auth.json")
  assert.deepEqual(leftovers, [], `残留文件：${leftovers.join(", ")}`)
})

test("changeAuth 在 change 抛错时不写盘", () => {
  const dir = playground({ codebuddy: CODEBUDDY })
  const file = path.join(dir, "plugin-auth.json")
  const before = fs.readFileSync(file, "utf8")
  assert.throws(() =>
    changeAuth(file, () => {
      throw new Error("boom")
    }),
  )
  assert.equal(fs.readFileSync(file, "utf8"), before, "异常路径也不能把文件写坏")
})
