import test from "node:test"
import assert from "node:assert/strict"
import "../page/data.js"

const V = globalThis.VeyraPage

// credits:list 的三种状态必须分得开：
//   读不到（宿主不认这个 key，或没给权限）≠ 读到了但这家没账号 ≠ 有数字
// 把「读不到」画成「0」是在替宿主撒谎，用户会拿它去跟供应商页对账。
function state(extra = {}) {
  return { providers: null, summary: null, credits: null, ...extra }
}

test("credits：宿主不认 credits:list 时报读不到，不报 0", () => {
  const w = V.text("zh")
  const cr = V.credits(state(), w, null)
  assert.equal(cr.live, false, "没拿到读数时 live 必须是 false")
  for (const r of cr.rows) {
    assert.equal(r.listed, false)
    assert.equal(r.counted, 0)
  }
})

test("credits：读到了但这家没账号 → listed=false，且 live=true 与读不到区分开", () => {
  const w = V.text("zh")
  const cr = V.credits(state(), w, [])
  assert.equal(cr.live, true)
  for (const r of cr.rows) {
    assert.equal(r.listed, false, "空读数里没有任何 provider")
    assert.equal(r.accounts, 0)
  }
})

test("credits：把一家多个账号的余额加总，缺数字的按缺失计不计入", () => {
  const w = V.text("zh")
  const live = [
    {
      id: "codebuddy",
      name: "CodeBuddy",
      accounts: [
        { account: "a", balance: "1200" },
        { account: "b", balance: "800" },
        { account: "c", balance: "" }, // 接口没报
        { account: "d", balance: "50" },
      ],
    },
  ]
  const cr = V.credits(state(), w, live)
  const row = cr.rows.find((r) => r.pid === "codebuddy")
  assert.equal(row.listed, true)
  assert.equal(row.accounts, 4)
  assert.equal(row.counted, 3, "空 balance 不算进 counted")
  assert.equal(row.sum, 2050, "只有有数字的加总")
})

test("credits：单个账号读失败标记 bad，但不影响其它账号的加总", () => {
  const w = V.text("zh")
  const live = [
    {
      id: "loomy",
      name: "Loomy",
      accounts: [
        { account: "a", balance: "300" },
        { account: "b", error: "timeout" },
      ],
    },
  ]
  const cr = V.credits(state(), w, live)
  const row = cr.rows.find((r) => r.pid === "loomy")
  assert.equal(row.bad, 1)
  assert.equal(row.counted, 1)
  assert.equal(row.sum, 300)
})

test("credits：只列本插件负责的家（roster 有名字时）", () => {
  const w = V.text("zh")
  const s = state({ providers: [{ id: "codebuddy", name: "CodeBuddy" }] })
  const cr = V.credits(s, w, [])
  assert.equal(cr.rows.length, 1)
  assert.equal(cr.rows[0].pid, "codebuddy")
})
