/**
 * 用宿主的真实规则读一遍 package.json：面板与 actions 是否会被 magpie 认下来。
 *
 * 直接 import magpie 自己的 `internal/plugin/page.go` 不现实（Go），所以这里把
 * 那几条**硬约束**逐条照抄成断言 —— 任何一条错了，宿主是**静默跳过**而不是报错，
 * 所以必须自己有测试盯着。
 *
 * 参照 `internal/plugin/page.go`：
 *   - `PanelSlots = ["agents","usage","settings","provider"]`
 *   - `ActionMenus = ["provider","agent"]`
 *   - `actionID = /^[a-z0-9][a-z0-9-]{0,39}$/`
 *   - `maxPanels = 8`、`maxActions = 8`
 *   - 面板的 `file` 必须是插件目录内的 `.html`（`htmlInside`）
 *   - **没有 page 就没有 action**（`if w.Page == nil { break }`）
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))

const PANEL_SLOTS = ["agents", "usage", "settings", "provider"]
const ACTION_MENUS = ["provider", "agent"]
const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

/** `htmlInside`：插件目录内、后缀 .html、且文件真的存在。 */
function htmlInside(rel) {
  if (typeof rel !== "string" || !rel) return null
  const abs = path.resolve(root, rel)
  const inRoot = abs === root || abs.startsWith(root + path.sep)
  if (!inRoot) return null
  if (path.extname(abs).toLowerCase() !== ".html") return null
  if (!fs.existsSync(abs)) return null
  return abs
}

test("provider 面板：slot/file 合宿主要求，否则 magpie 静默跳过", () => {
  const panels = pkg.magpie?.panels ?? []
  assert.ok(panels.length > 0, "没有 panels：provider 编辑页里就不会出现 Veyra 卡片")
  for (const p of panels) {
    assert.ok(PANEL_SLOTS.includes(p.slot), `未知 slot ${p.slot}`)
    assert.ok(htmlInside(p.file), `面板 file ${p.file} 不是插件目录内存在的 .html`)
    assert.equal(typeof p.title, "string")
    assert.ok(p.title.trim().length > 0, "没有 title 的面板标题会空着")
    if (p.titles) for (const v of Object.values(p.titles)) assert.equal(typeof v, "string")
  }
  assert.ok(panels.length <= 8, `面板超过 maxPanels=8`)
})

test("provider 面板指向的文件自带 bridge 与脚本，且不引外部资源", () => {
  const panel = (pkg.magpie?.panels ?? []).find((p) => p.slot === "provider")
  assert.ok(panel, "没有 slot=provider 的面板")
  const html = fs.readFileSync(path.join(root, panel.file), "utf8")
  assert.match(html, /_magpie\/bridge\.js/, "面板必须引入 app 提供的 bridge，否则拿不到 magpie.context")
  // CSP 是 img-src 'self' data: / connect-src 'none'：外链一定失败
  assert.doesNotMatch(html, /(src|href)="https?:\/\//, "面板不能引外部资源，沙箱会拦掉")
})

test("actions：id 合宿主正则、menu 合宿主白名单，且有 page 才成立", async () => {
  const actions = pkg.magpie?.actions ?? []
  assert.ok(pkg.magpie?.page, "没有 page 的插件，宿主的 actions 循环第一句就 break，菜单项不会出现")
  assert.ok(actions.length > 0, "没有 actions：provider 行右键不会出现 Veyra 的菜单项")
  assert.ok(actions.length <= 8, "actions 超过 maxActions=8")
  const ids = new Set()
  for (const a of actions) {
    assert.match(a.id, ACTION_ID, `action id ${a.id} 不合 ^[a-z0-9][a-z0-9-]{0,39}$`)
    assert.ok(!ids.has(a.id), `action id ${a.id} 重复，宿主只认第一个`)
    ids.add(a.id)
    assert.ok(ACTION_MENUS.includes(a.menu), `未知 menu ${a.menu}`)
    assert.ok(typeof a.title === "string" && a.title.trim(), "action 缺 title")
  }
})

test("五家渠道的面板都能拿到 context：文件不假设 provider id", () => {
  const js = fs.readFileSync(path.join(root, "page", "panel.js"), "utf8")
  assert.match(js, /magpie\.context/, "面板必须从 magpie.context 读当前 provider")
  assert.match(js, /magpie\.ready/, "必须等 ready（hello 应答里才带 context），抢跑会读到空对象")
  // 面板是同一个文件服务五家，不能把 id 写死在 DOM 结构里
  assert.match(js, /KNOWN\s*=\s*\{/, "缺少对五家的静态资料表")
  for (const id of ["codebuddy", "codebuddy-intl", "lobsterai", "codearts", "loomy"]) {
    assert.ok(js.includes(`"${id}"`) || js.includes(`${id}:`), `面板缺 ${id} 的资料`)
  }
})
