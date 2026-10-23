/**
 * 聚合登录队列（`data.js` 的 `loginQueue`）的行为锁。
 *
 * 为什么单独测这个：队列是**唯一**把五家收敛成一个入口的地方，它的排序规则一旦
 * 被后来的改动破坏（比如有人"顺手"按字母排序），用户看到的就是次序每次刷新都在跳，
 * 而这在假 DOM 里不报错、在真浏览器里也只是一排顺序不同的行 —— 属于最容易被
 * 静默改坏的逻辑，必须有断言。
 *
 * 断言项：
 *   1. 五家一个不少、id 不重复（漏一家等于把某渠道藏起来）
 *   2. 已注册且有签到的排最前，其次已注册，未注册的垫底
 *   3. 同一档内保持 PROVIDERS 声明顺序（次序必须稳定）
 *   4. 读不到 provider 列表时不算次序（不假装知道谁该先登），徽标统一为 unknown
 *   5. 未注册行的徽标是 dead，且调用方据此禁用按钮
 *   6. 计数文案区分"未知"与"0 家已注册"——这两件事不能混
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")

/** `data.js` 是经典脚本（挂 globalThis），用 vm 语义直接跑一次即可。 */
const source = readFileSync(join(root, "page", "data.js"), "utf8")
const factory = new Function(`${source}\nreturn globalThis.VeyraPage`)
const V = factory()

const zh = V.text("zh")

test("队列包含全部五家，且 id 不重复", () => {
  const q = V.loginQueue({ providers: [] }, zh)
  assert.equal(q.items.length, 5)
  assert.equal(q.total, 5)
  const ids = q.items.map((x) => x.id)
  assert.equal(new Set(ids).size, 5)
  // 与静态快照同源，不是另抄一份。
  assert.deepEqual([...ids].sort(), V.PROVIDERS.map((p) => p.id).sort())
})

test("排序：已注册且有签到 → 已注册 → 未注册", () => {
  // 只让 loomy 与 codebuddy-intl 注册；loomy 有签到、intl 没有。
  const q = V.loginQueue({ providers: [{ id: "loomy" }, { id: "codebuddy-intl" }] }, zh)
  const order = q.items.map((x) => x.id)
  // 有签到的 loomy 必须排第一（同档里它是唯一注册且有签到的）
  assert.equal(order[0], "loomy")
  // codebuddy-intl 虽已注册但没有签到，应排在 loomy 之后、未注册之前
  assert.equal(order[1], "codebuddy-intl")
  // 其余三家未注册，垫底
  for (const id of ["codebuddy", "lobsterai", "codearts"]) {
    assert.ok(order.indexOf(id) > 1, `${id} 未注册却排在了已注册渠道前面`)
  }
})

test("同一档内保持声明顺序（次序稳定，不随刷新跳动）", () => {
  const all = V.PROVIDERS.map((p) => ({ id: p.id }))
  const q = V.loginQueue({ providers: all }, zh)
  const firstTier = q.items.filter((x) => x.checkin).map((x) => x.id)
  const declared = V.PROVIDERS.filter((p) => p.checkin).map((p) => p.id)
  assert.deepEqual(firstTier, declared)
})

test("读不到 provider 列表时不排序，徽标统一 unknown", () => {
  const q = V.loginQueue({ providers: null }, zh)
  assert.equal(q.done, null)
  // 原样输出声明顺序
  assert.deepEqual(q.items.map((x) => x.id), V.PROVIDERS.map((p) => p.id))
  for (const it of q.items) {
    assert.equal(it.known, null)
    assert.equal(it.badge.kind, "off")
    assert.equal(it.badge.text, zh.badgeUnknown)
  }
})

test("未注册的行标 dead，已注册的标 ok", () => {
  const q = V.loginQueue({ providers: [{ id: "codearts" }] }, zh)
  for (const it of q.items) {
    if (it.id === "codearts") {
      assert.equal(it.known, true)
      assert.equal(it.badge.kind, "ok")
      assert.equal(it.badge.text, zh.badgeOn)
    } else {
      assert.equal(it.known, false)
      assert.equal(it.badge.kind, "dead")
    }
  }
})

test("计数文案区分「未知」与「0 家已注册」", () => {
  const unknown = V.loginQueue({ providers: null }, zh)
  assert.match(unknown.count, /注册状态未知/)
  const none = V.loginQueue({ providers: [] }, zh)
  assert.match(none.count, /已注册 0 \/ 5/)
  assert.notEqual(unknown.count, none.count)
})

test("登录方式逐家如实：loomy 是手机验证码，其余是浏览器授权", () => {
  const q = V.loginQueue({ providers: [] }, zh)
  for (const it of q.items) {
    const declared = V.PROVIDERS.find((p) => p.id === it.id)
    const want = declared.login === "phone" ? zh.loginPhone : zh.loginBrowser
    assert.equal(it.login, want, `${it.id} 的登录方式与静态快照不一致`)
  }
})
