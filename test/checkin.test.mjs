/**
 * 签到段（`data.js` 的 `checkin`）的行为锁。
 *
 * 为什么单测这个段：插件页是沙箱页（`connect-src 'none'`，只允许
 * `providers:list` 与 `usage:summary`），**读不到 `plugin-checkin.json`**。
 * 所以这一段的价值全在"不撒谎"上：它绝不能凭空画出"今天已签 N 个"。这条
 * 边界很容易被后来的改动突破（谁顺手加一行 `state.checkin.length` 就破了），
 * 而破掉之后页面照常渲染、测试照常绿 —— 必须有断言钉住。
 *
 * 断言项：
 *   1. 读不到 provider 列表时，五家全列，不猜
 *   2. 能签到 / 不能签到的徽标来自 PROVIDERS 的真实声明，不是另抄一份
 *   3. 手机验证码登录的家（loomy）说明文案与浏览器授权的家不同
 *   4. 计数文案给出的是"能签几家"，不是"今天签了几个"
 *   5. 产出里**不含任何**今日签到数量的字段
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const source = readFileSync(join(root, "page", "data.js"), "utf8")
const V = new Function(`${source}\nreturn globalThis.VeyraPage`)()
const zh = V.text("zh")

test("签到：读不到 provider 列表时五家全列，不猜", () => {
  const ck = V.checkin({ providers: null }, zh)
  assert.equal(ck.rows.length, V.PROVIDERS.length)
  assert.equal(new Set(ck.rows.map((r) => r.pid)).size, ck.rows.length)
})

test("签到：徽标来自 PROVIDERS 的真实声明", () => {
  const ck = V.checkin({ providers: null }, zh)
  for (const row of ck.rows) {
    const p = V.PROVIDERS.find((x) => x.id === row.pid)
    assert.equal(row.on, Boolean(p.checkin), `${row.pid} 的签到能力与声明不一致`)
  }
  // 五家里确实有能签的，也有不能签的 —— 否则这个断言本身没意义
  assert.ok(ck.rows.some((r) => r.on))
  assert.ok(ck.rows.some((r) => !r.on))
})

test("签到：手机验证码的家与浏览器授权的家说明文案不同", () => {
  const ck = V.checkin({ providers: null }, zh)
  const phone = ck.rows.find((r) => {
    const p = V.PROVIDERS.find((x) => x.id === r.pid)
    return p.checkin && p.login === "phone"
  })
  const browser = ck.rows.find((r) => {
    const p = V.PROVIDERS.find((x) => x.id === r.pid)
    return p.checkin && p.login !== "phone"
  })
  assert.ok(phone && browser, "fixture 需要同时有手机与浏览器两家")
  assert.notEqual(phone.said, browser.said)
})

test("签到：计数文案是「能签几家」，且不含今日数量", () => {
  const ck = V.checkin({ providers: null }, zh)
  const can = ck.rows.filter((r) => r.on).length
  assert.match(ck.note, new RegExp(`${can} / ${ck.rows.length}`))
  assert.doesNotMatch(ck.note, /\d+\s*个?\s*(已签|签了|成功)/)
})

test("签到：产出里没有任何「今天签了几个」的字段", () => {
  const ck = V.checkin({ providers: null }, zh)
  // 页面拿不到这份数据，凡是长得像的字段都是编的。
  for (const key of ["claimed", "done", "signed", "today", "count", "streak", "credit"]) {
    assert.equal(key in ck, false, `不该出现 ${key}：页面读不到签到结果`)
  }
  // 文案层也不能暗示知道结果。
  assert.doesNotMatch(ck.how + ck.where, /已签|今日已领|今天签了/)
})
