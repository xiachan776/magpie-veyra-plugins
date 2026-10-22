/**
 * Veyra · magpie 页面的 **DOM 层**。
 *
 * 分工：`data.js` 只算视图模型（不碰 DOM、可在 Node 里跑），本文件只负责把模型
 * 画成节点。这样「文案/数字算错」与「节点拼错」两类问题能分开验证。
 *
 * ## 三条必须守住的约定
 *
 * 1. **只用 `createElement` + `replaceChildren`，绝不用 `innerHTML`。**
 *    页面虽然被关在沙箱里，但 provider 名、模型 id、错误信息全部来自外部（远端目录、
 *    宿主报文），拼字符串等于把这些东西当 HTML 解析，是注入面。
 * 2. **`magpie.read` 必须逐个 try/catch。** 两个读互相独立：`providers:list` 挂了
 *    不该让记账段一起变空（反之亦然）。失败信息要显示成人话 —— 抛到控制台就没了，
 *    而用户看到的是「页面一片空白但没有任何解释」。
 * 3. **页面可能不在宿主里**（用户直接双击 index.html）。那时 `magpie` 根本不存在，
 *    必须给一句明确解释，而不是白屏 + 控制台红字。
 */
(async () => {
  "use strict"

  const V = globalThis.VeyraPage
  const $ = (id) => document.getElementById(id)

  /**
   * ⚠️ **必须先等 DOM 建好。**
   *
   * 骨架把三个 `<script>` 都放在 `<head>` 里且**没有 `defer`**，所以经典脚本是在
   * 解析 `<head>` 的过程中同步执行的 —— 那一刻 `<body>` 还不存在，
   * 所有 `getElementById` 都返回 `null`。真浏览器实测：`words()` 里第一次
   * 碰 `el["overview-h"].textContent` 就抛
   * `TypeError: Cannot set properties of null`，整页一个字都画不出来
   * （而用「DOM 已就绪」的假 DOM 测试是看不出来的）。
   *
   * 修法只能是这里等：骨架的 script 引用是定稿，不许加 `defer`。
   */
  async function domReady() {
    if (document.readyState === "loading") {
      await new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true })
      })
    }
  }

  await domReady()

  /**
   * 本文件用到的全部 id，集中一处便于核对。
   * `.sync/check-page.mjs` 会把这些 id 与 `index.html` 里的真实 id 做交集比对 ——
   * id 打错是这类页面最常见的**静默**失败（元素为 null，画不出来但也不报错）。
   */
  const IDS = [
    "generated",
    "version",
    "refresh",
    "overview-h",
    "overview-note",
    "tiles",
    "providers-h",
    "providers-note",
    "cards",
    "cards-empty",
    "usage-h",
    "periods",
    "since",
    "usage-tiles",
    "models",
    "usage-empty",
    "usage-error",
    "footer",
  ]

  const el = {}
  for (const id of IDS) el[id] = $(id)

  /** tagline 在骨架里没有 id（骨架已定稿，不为它改 HTML），只能按类名取一次。 */
  const tagline = document.querySelector(".tagline")

  const state = {
    period: "today",
    /** `null` = 读不到（与「读到了但是空数组」是两件事）。 */
    providers: null,
    providerError: null,
    summary: null,
    usageError: null,
    at: null,
  }

  let lang = "en"
  let loading = false

  const t = () => V.text(lang)
  const msg = (e) => (e && e.message ? String(e.message) : String(e))

  /* ---- 节点小工具 -------------------------------------------------------- */

  /**
   * 单元后缀 `.u` 刻意塞进 `.v` 里面：CSS 里 `.tile .u` 是后代选择器且带
   * `margin-left: 3px`，只有内联在数值后面才读成「4 / 5」而不是单独一行。
   */
  function tileNode(item) {
    const box = document.createElement("div")
    box.className = "tile"
    if (item.title) box.title = item.title
    const k = document.createElement("div")
    k.className = "k"
    k.textContent = item.k
    const v = document.createElement("div")
    v.className = "v"
    v.textContent = item.v
    if (item.u) {
      const u = document.createElement("span")
      u.className = "u"
      u.textContent = item.u
      v.append(u)
    }
    box.append(k, v)
    return box
  }

  /** `.tile` 外壳 + `.win` 量条：外壳给边框底色，`.win` 负责条本身（样式表如此分工）。 */
  function gaugeNode(g) {
    const box = document.createElement("div")
    // `gauge` 让这一格跨两列：条太窄就只剩一根看不出比例的短线。
    box.className = "tile gauge"
    const k = document.createElement("div")
    k.className = "k"
    k.textContent = g.k
    const win = document.createElement("div")
    win.className = "win"
    const top = document.createElement("div")
    top.className = "win-top"
    const left = document.createElement("span")
    left.textContent = g.left
    // 条上显示的是紧凑写法，精确值放悬停 —— 长数字会把条挤到第二行。
    if (g.title) left.title = g.title
    const amt = document.createElement("span")
    amt.className = "amt"
    amt.textContent = g.amt
    amt.title = g.title || ""
    top.append(left, amt)
    const bar = document.createElement("div")
    bar.className = "bar"
    const fill = document.createElement("i")
    // 0% 时留空条，不设最小宽度：错误率 0 却在条上画一截，等于谎报有错误。
    fill.style.width = `${Math.max(0, Math.min(100, Number(g.width) || 0))}%`
    if (g.tone) fill.className = g.tone
    bar.append(fill)
    win.append(top, bar)
    if (g.note) {
      const note = document.createElement("div")
      note.className = "win-note"
      note.textContent = g.note
      win.append(note)
    }
    box.append(k, win)
    return box
  }

  function cardNode(c) {
    const card = document.createElement("div")
    card.className = "card"

    const head = document.createElement("div")
    head.className = "card-head"
    const left = document.createElement("div")
    const title = document.createElement("h3")
    title.className = "card-title"
    title.textContent = c.title
    const sub = document.createElement("p")
    sub.className = "card-sub"
    sub.textContent = c.sub
    const pid = document.createElement("div")
    pid.className = "pid"
    pid.textContent = c.pid
    left.append(title, sub, pid)
    const badge = document.createElement("span")
    badge.className = `badge ${c.badge.kind}`
    badge.textContent = c.badge.text
    head.append(left, badge)

    const facts = document.createElement("div")
    facts.className = "facts"
    for (const f of c.facts) {
      const item = document.createElement("span")
      item.append(document.createTextNode(`${f.k} `))
      const b = document.createElement("b")
      b.textContent = f.v
      if (f.title) b.title = f.title
      item.append(b)
      facts.append(item)
    }

    const checkin = document.createElement("div")
    checkin.className = `checkin ${c.checkin.on ? "on" : "off"}`
    const dot = document.createElement("span")
    dot.className = "dot"
    const said = document.createElement("span")
    said.className = "said"
    said.textContent = c.checkin.said
    checkin.append(dot, said)

    card.append(head, facts, checkin)
    if (c.error) {
      const p = document.createElement("p")
      p.className = "card-error"
      p.textContent = c.error
      card.append(p)
    }
    return card
  }

  /* ---- 文案（与数据无关的那部分） ---------------------------------------- */

  function words() {
    const w = t()
    document.title = `Veyra · magpie`
    if (tagline) tagline.textContent = w.tagline
    el["overview-h"].textContent = w.overview
    el["providers-h"].textContent = w.providers
    el["usage-h"].textContent = w.usage
    el.refresh.textContent = w.refresh
    el.periods.setAttribute("aria-label", w.periodsLabel)
    for (const b of el.periods.querySelectorAll("button")) {
      const p = b.dataset.period
      // tab 的可见文字跟着语言走；`data-period` 是行为值，永不翻译。
      if (w.period[p]) b.textContent = w.period[p]
    }
    el.version.textContent = `v${V.VERSION}`
    el.footer.textContent = w.footer(V.VERSION)
  }

  /** 顶栏两个 chip 与时间戳：只在真正取过数据后才显示，避免显示一个假时刻。 */
  function stamp() {
    const w = t()
    el.generated.textContent = state.at ? `${w.refreshed} ${V.fmt.clock(state.at)}` : ""
    el.generated.title = state.at ? w.refreshed : ""
  }

  function select(period) {
    for (const b of el.periods.querySelectorAll("button")) {
      b.setAttribute("aria-selected", String(b.dataset.period === period))
    }
  }

  /* ---- 三段渲染 ---------------------------------------------------------- */

  function paintOverview() {
    const w = t()
    el.tiles.replaceChildren(...V.overview(state, w).map(tileNode))
    // 读不到列表时不写「0 / 5 个渠道已被认识」：那会把「不知道」说成「一个都没有」。
    el["overview-note"].textContent =
      state.providers === null
        ? ""
        : w.overviewNote(state.providers.length, V.PROVIDERS.length)
  }

  function paintCards() {
    const w = t()
    el.cards.replaceChildren(...V.cards(state, w).map(cardNode))

    // 空态只在真的没有可用信息时占位：读不到 → 说读不到；五个全不在 → 给诊断。
    if (state.providers === null) {
      el["cards-empty"].hidden = false
      el["cards-empty"].textContent = w.cardsEmptyUnknown
    } else {
      const known = new Set(state.providers.map((p) => (p && p.id) || ""))
      const hit = V.PROVIDERS.filter((p) => known.has(p.id)).length
      el["cards-empty"].hidden = hit > 0
      el["cards-empty"].textContent = hit > 0 ? "" : w.cardsEmpty
    }
    el["providers-note"].textContent = w.providersNote
  }

  function paintUsage() {
    const w = t()
    select(state.period)

    const vm = state.summary ? V.usage(state.period, state.summary, w) : null
    el.since.textContent = vm ? vm.since : ""

    if (!vm) {
      el["usage-tiles"].replaceChildren()
      el.models.replaceChildren()
      el["usage-empty"].hidden = true
    } else {
      el["usage-tiles"].replaceChildren(
        ...vm.tiles.map(tileNode),
        ...vm.ratios.map(gaugeNode),
      )
      // 行内三列数字都带 title：窄屏（≤520px）CSS 会藏掉一列，悬停/读屏仍拿得到。
      el.models.replaceChildren(
        ...vm.rows.map((r) => {
          const li = document.createElement("li")
          const name = document.createElement("span")
          name.className = "name"
          name.textContent = r.name
          name.title = r.name
          li.append(name)
          for (const [text, title] of [
            [r.n1, r.t1],
            [r.n2, r.t2],
            [r.n3, r.t3],
          ]) {
            const n = document.createElement("span")
            n.className = "num"
            n.textContent = text
            n.title = title
            li.append(n)
          }
          return li
        }),
      )
      el["usage-empty"].hidden = !vm.empty
      el["usage-empty"].textContent = vm.empty ? w.usageEmpty : ""
    }

    // 错误优先于空态：读不到时不能显示「本区间没有调用」，那是在替宿主圆谎。
    if (state.usageError) {
      el["usage-error"].hidden = false
      el["usage-error"].textContent = `${w.usageFailed}${state.usageError}`
    } else {
      el["usage-error"].hidden = true
      el["usage-error"].textContent = ""
    }
  }

  function paint() {
    stamp()
    paintOverview()
    paintCards()
    paintUsage()
  }

  /* ---- 取数 -------------------------------------------------------------- */

  async function load() {
    // 60s 轮询 + 手动刷新可能撞在一起；重叠的第二次读没有意义，直接跳过。
    if (loading) return
    loading = true
    el.refresh.disabled = true
    try {
      // 两个读各自独立：一个失败不该把另一段也清空。
      try {
        const list = await magpie.read("providers:list")
        state.providers = Array.isArray(list) ? list : []
        state.providerError = null
      } catch (e) {
        state.providers = null
        state.providerError = msg(e)
      }
      try {
        state.summary = await magpie.read("usage:summary", { period: state.period })
        state.usageError = null
      } catch (e) {
        state.summary = null
        state.usageError = msg(e)
      }
      state.at = new Date()
      paint()
    } finally {
      loading = false
      el.refresh.disabled = false
    }
  }

  /* ---- 选项持久化 -------------------------------------------------------- */

  // 宿主把 options 限速到「每秒最多一次」（429），所以连点 tab 只保存最后一次。
  let saving = null
  function save() {
    if (saving) return
    saving = setTimeout(async () => {
      saving = null
      try {
        await magpie.options.set({ ...(await magpie.options.get()), period: state.period })
      } catch {
        // 存不下就算了：period 只是「下次打开停在哪」，不该为它弹错误。
      }
    }, 1100)
  }

  /* ---- 启动 -------------------------------------------------------------- */

  words()

  // 没有宿主桥：页面被当普通网页打开了。给出解释后停下，别假装在读数据。
  if (typeof magpie === "undefined" || !magpie || typeof magpie.ready === "undefined") {
    lang = (typeof navigator !== "undefined" && navigator.language) || "en"
    words()
    const w = t()
    el.since.textContent = ""
    el["usage-error"].hidden = false
    el["usage-error"].textContent = w.noHost
    el["cards-empty"].hidden = false
    el["cards-empty"].textContent = w.cardsEmptyUnknown
    el["overview-note"].textContent = ""
    el["providers-note"].textContent = w.providersNote
    return
  }

  let theme = null
  try {
    theme = await magpie.ready
  } catch {
    theme = null
  }
  if (theme && theme.lang) lang = theme.lang

  let opts = {}
  try {
    opts = (await magpie.options.get()) || {}
  } catch {
    opts = {}
  }
  // 只接受插件自己认得的区间：别让一份旧/坏的 options 让 read 收到非法 period
  // （宿主会回 `no period %q: today, 7d or 30d`）。
  state.period = V.PERIODS.includes(opts.period) ? opts.period : "today"

  words()

  el.refresh.addEventListener("click", () => {
    void load()
  })

  el.periods.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("button") : null
    const p = btn && btn.dataset ? btn.dataset.period : null
    if (!p || p === state.period || !V.PERIODS.includes(p)) return
    state.period = p
    select(p)
    save()
    void load()
  })

  if (typeof magpie.onTheme === "function") {
    magpie.onTheme((next) => {
      if (next && next.lang) lang = next.lang
      // 文案与数字都依赖语言（`t.period`、`t.since` 都在视图模型里），
      // 所以是整页重画，而不是只换几个标签。
      words()
      paint()
    })
  }

  // 页面开着时数字会变旧；60s 一次足够，且与宿主的记账写盘节奏同量级。
  setInterval(() => {
    void load()
  }, 60_000)

  try {
    await load()
  } catch {
    // load 内部已各自兜住；能到这里的只有 paint 阶段真的炸了，给句人话别留白屏。
    el["usage-error"].hidden = false
    el["usage-error"].textContent = t().failing
  }
})()
