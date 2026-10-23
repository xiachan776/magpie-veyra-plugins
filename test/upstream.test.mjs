import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { WATCHED, fingerprint, drift } from "../scripts/upstream.mjs"

// 造一个假的 Veyra 检出目录，只为让 fingerprint 能跑
function fakeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "veyra-up-"))
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

test("WATCHED 每行都是 [路径, 说明]，路径唯一且指向 src/*.ts", () => {
  const seen = new Set()
  for (const [rel, why] of WATCHED) {
    assert.match(rel, /^src\/.+\.ts$/, `${rel} 不像 Veyra 的协议源文件`)
    assert.ok(!seen.has(rel), `${rel} 重复登记`)
    seen.add(rel)
    assert.ok(why && why.length > 2, `${rel} 缺说明，报告里会只剩一行路径`)
  }
})

test("签到与积分的源文件都在监视表里 —— 漏掉它们，协议改了也看不见", () => {
  const paths = WATCHED.map((w) => w[0])
  // 本包真正实现签到与积分的两家
  assert.ok(paths.includes("src/lobsterai-credits.ts"), "LobsterAI 签到没被监视")
  assert.ok(paths.includes("src/codearts-credits.ts"), "CodeArts 积分没被监视")
  assert.ok(paths.includes("src/loomy-credits.ts"), "Loomy 积分没被监视")
})

test("fingerprint 给每个文件算哈希，缺文件的记 null", () => {
  const dir = fakeDir({ "src/product.ts": "a", "src/oauth.ts": "b" })
  const now = fingerprint(dir)
  assert.equal(now["src/product.ts"].sha.length, 16)
  assert.notEqual(now["src/product.ts"].sha, now["src/oauth.ts"].sha)
  // 目录里没有的文件仍要出现在结果里，值为 null —— 否则「上游删了文件」会被漏报
  assert.equal(now["src/models.ts"].sha, null)
  assert.equal(Object.keys(now).length, WATCHED.length)
})

test("drift：哈希变了、多了、没了，三种都算漂移", () => {
  const now = { a: { sha: "111" }, b: { sha: null }, c: { sha: "333" } }
  const ledger = { files: { a: { sha: "111" }, b: { sha: "222" }, c: { sha: null } } }
  const out = drift(now, ledger)
  assert.deepEqual(
    out.map((x) => x.file),
    ["b", "c"],
    "a 没变不该报；b 从有到无、c 从无到有都要报",
  )
})

test("drift：账本为空（还没 --write）时每个文件都算新，不假装一致", () => {
  const now = { a: { sha: "111" }, b: { sha: "222" } }
  const out = drift(now, { files: {} })
  assert.equal(out.length, 2, "首次运行时把「没基线」当成「一致」是假绿")
})

test("drift：完全一致时返回空", () => {
  const now = { a: { sha: "111" } }
  assert.deepEqual(drift(now, { files: { a: { sha: "111" } } }), [])
})
