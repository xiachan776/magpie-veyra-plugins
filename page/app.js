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
    "login-h",
    "login-count",
    "login-hint",
    "login-queue",
    "accounts-h",
    "accounts-note",
    "accounts-hint",
    "accounts-groups",
    "accounts-error",
    "providers-h",
    "providers-note",
    "cards",
    "cards-empty",
    "checkin-h",
    "checkin-note",
    "checkin-how",
    "checkin-list",
    "checkin-where",
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
    /**
     * 全部账号：`null` = 读不到，`[]` = 读到了但一家都没有。
     *
     * 形状与 `plugin-providers.json` 的分组视图一致（见 `src/accounts.mjs`）。
     * 来源不是 `magpie.read` —— 页面桥只认两个白名单 key，读不到账号文件。
     */
    accounts: null,
    accountsError: null,
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
    // provider 右键菜单（magpie.actions）靠它把对应的卡片highlight出来，
    // 不用再去比标题文字。
    if (c.pid) card.dataset.pid = c.pid

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

  /**
   * 聚合队列的一行。
   *
   * 行内只有**一个**可点落点（右侧按钮），且它不是「直接登录」—— 页面发不出登录
   * （桥没有 signIn 方法、沙箱连不上授权页）。它做的是把这一行的 provider 高亮出来，
   * 并跳转到 Providers 段，由用户在那里完成授权。按钮上写「去登录」而不是「登录」，
   * 是因为后者会让用户以为点完就登上了。
   */
  function queueNode(item, w) {
    const li = document.createElement("li")
    li.className = "queue-row"
    li.dataset.pid = item.pid
    if (item.known === false) li.dataset.dead = "1"

    const name = document.createElement("span")
    name.className = "q-name"
    name.textContent = item.name

    const login = document.createElement("span")
    login.className = "q-login"
    login.textContent = item.login

    const badge = document.createElement("span")
    badge.className = `badge ${item.badge.kind}`
    badge.textContent = item.badge.text

    const go = document.createElement("button")
    go.type = "button"
    go.className = "btn q-go"
    go.textContent = w.queueLogin
    go.title = item.known === false ? w.errNotRegistered : w.queueGoHint
    // 未注册的渠道点了也没用（Providers 页压根没有这张卡），直接禁掉并说明原因。
    go.disabled = item.known === false
    go.addEventListener("click", () => {
      highlight(item.pid)
      if (el["providers-h"] && el["providers-h"].scrollIntoView) {
        el["providers-h"].scrollIntoView({ block: "start", behavior: "smooth" })
      }
    })

    li.append(name, login, badge, go)
    return li
  }

  /**
   * 把某个 provider 的卡片与队列行高亮 4 秒。
   *
   * 两处都要打，因为用户点的是队列行、而真正要操作的是下面的 Provider 卡片；
   * 只高亮一处会让视线断开。用 `data-hit` 属性 + CSS outline，不动布局。
   */
  let hitTimer = null
  function highlight(pid) {
    const marks = [el["login-queue"], el.cards]
    const hits = []
    for (const box of marks) {
      if (!box) continue
      for (const n of box.querySelectorAll("[data-pid]")) {
        n.removeAttribute("data-hit")
        if (n.dataset.pid === pid) hits.push(n)
      }
    }
    for (const n of hits) n.setAttribute("data-hit", "1")
    if (hitTimer) clearTimeout(hitTimer)
    hitTimer = hits.length ? setTimeout(() => { for (const n of hits) n.removeAttribute("data-hit") }, 4000) : null
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
    // 读不到名册时一个字都不写：把「不知道」说成「0 家」是替宿主圆谎。
    el["overview-note"].textContent = V.overviewNote(state, w)
  }

  function paintQueue() {
    const w = t()
    const q = V.loginQueue(state, w)
    el["login-h"].textContent = w.queueTitle
    el["login-count"].textContent = q.count
    el["login-hint"].textContent = q.hint
    el["login-queue"].replaceChildren(...q.items.map((it) => queueNode(it, w)))
    el["login-queue"].hidden = q.items.length === 0
  }

  /**
   * 全部账号段 —— 页面读不到账号，所以这一段是**一句话的说明**，不是一份列表。
   *
   * 上一版把这里做成了账号列表，数据假设「来自 plugin-providers.json」。那假设是错的：
   * 页面桥根本没有文件通道（`providers:list` 只给 id+name，`read` 白名单只有两个 key），
   * 所以那一版在真宿主里永远显示「读不到」。现在保留段落、说明原因并指向真正能看
   * 账号的地方 —— 比一个永远空的列表有用。
   *
   * 不显示「0 个账号」：那是把「读不到」说成「一个都没有」（这条规矩与记账段一致）。
   */
  function paintAccounts() {
    const w = t()
    el["accounts-h"].textContent = w.accountsTitle
    el["accounts-note"].textContent = ""
    el["accounts-hint"].textContent = w.accountsHint
    el["accounts-groups"].replaceChildren()
    el["accounts-error"].hidden = !w.accountsEmpty
    el["accounts-error"].textContent = w.accountsEmpty || ""
  }

  /**
   * 签到段：只说**能确定的事**。
   *
   * 页面读不到 `plugin-checkin.json`（沙箱只给 `providers:list` 与
   * `usage:summary`），所以这里**不画任何"今日已签 N 个"的数字** ——
   * 那会是把猜测写成人话。能确定的有三样：签到怎么发生、本包哪几家有
   * 签到能力、结果要去哪儿看。
   */
  function paintCheckin() {
    const w = t()
    const ck = V.checkin(state, w)
    el["checkin-h"].textContent = w.ckTitle
    el["checkin-note"].textContent = ck.note
    el["checkin-how"].textContent = ck.how
    el["checkin-where"].textContent = ck.where
    el["checkin-list"].replaceChildren(
      ...ck.rows.map((r) => {
        const li = document.createElement("li")
        li.className = "ck-row"
        li.dataset.pid = r.pid
        li.dataset.on = r.on ? "1" : "0"
        const name = document.createElement("span")
        name.className = "ck-name"
        name.textContent = r.name
        const said = document.createElement("span")
        said.className = "ck-said"
        said.textContent = r.said
        const badge = document.createElement("span")
        badge.className = "badge " + (r.on ? "ok" : "off")
        badge.textContent = r.on ? w.ckBadgeOn : w.ckBadgeOff
        li.append(name, said, badge)
        return li
      }),
    )
  }

  function paintCards() {
    const w = t()
    el.cards.replaceChildren(...V.cards(state, w).map(cardNode))

    // 三种状态分开说，不能合并：读不到（不知道）/ 读到了但一家没有 / 有内容。
    // `state.providers === null` 与 `[]` 是不同的事，混起来就是在替宿主圆谎。
    const unknown = state.providers === null
    const empty = !unknown && state.providers.length === 0
    el["cards-empty"].hidden = !(unknown || empty)
    el["cards-empty"].textContent = unknown ? w.cardsEmptyUnknown : empty ? w.cardsEmpty : ""
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
    paintAccounts()
    paintCheckin()
    paintQueue()
    paintCards()
    paintUsage()
  }

  /* ---- 取数 -------------------------------------------------------------- */

  /**
   * 读账号 —— **页面做不到，这里直说。**
   *
   * 曾经尝试走 `options.get`，那条路是错的：
   * - `options` 读的是 `plugins.json` 里本插件的 `options` 字段，**只有 `options.set`
   *   能写它**，而 `set` 走 `SetOptions` → `Restart()`，**整包插件重启**；
   * - 更糟的是 `options` 是用户在设置里能改、能「恢复默认」的东西，把账号快照混进去，
   *   重置一次选项就把账号列表清了。
   *
   * 桥给的五种能力里没有任何一种能读账号：`providers:list` 只有 `{id, name}`
   * （宿主注释写明 "no key, no account, no address"），`read` 的白名单也只有那两个 key。
   *
   * ⇒ 所以这一段恒为「读不到」，并解释原因与去哪里看。不编造、不显示「0 个账号」。
   */
  function loadAccounts() {
    state.accounts = null
    state.accountsError = null
  }

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
      loadAccounts()
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
    el["accounts-note"].textContent = ""
    el["accounts-hint"].textContent = w.accountsHint
    el["accounts-error"].hidden = false
    el["accounts-error"].textContent = w.noHost
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

  /**
   * provider 行的右键菜单（`magpie.actions`，menu: "provider"）被点中的响应。
   *
   * 宿主在菜单被点时才 `postMessage` 过来，页面可能刚打开、也可能早就开着；
   * bridge 会把**先于** `onAction` 注册到达的那一条排队（`acted`），所以这里
   * 同步注册就能收全，不用自己再缓存。
   *
   * 两个 action 都只是「把焦点带到相关的一段」：`veyra-accounts` 滚到 Provider
   * 卡片并按 id 高亮，`veyra-checkin` 滚到同一个地方并说明签到该去哪里开。
   * 页面是只读的（`connect-src 'none'`，写盘也轮不到它），所以它不能真的触发
   * 签到 —— 签到在 Providers 页那一行上。这里只做定位，并在页脚说清下一步。
   */
  if (typeof magpie.onAction === "function") {
    magpie.onAction((a) => {
      const id = a && a.provider && a.provider.id ? String(a.provider.id) : ""
      const which = a && a.id
      // 队列行与 Provider 卡片一起高亮：用户在队列里点的，但要去卡片上操作。
      highlight(id)
      // 两个入口各自滚到自己那一段：账号 → Provider 卡片，签到 → 签到段。
      // 之前两个都滚到 Provider 段，点「签到」落在一个没有签到信息的地方。
      const target = which === "veyra-checkin" ? el["checkin-h"] : el["providers-h"]
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "start", behavior: "smooth" })
      if (which === "veyra-checkin") {
        // 这个菜单项只是「带我去签到那一段」：magpie 的菜单只能打开插件页，
        // 不能执行命令（internal/plugin/page.go:53），所以照实说下一步在哪。
        const can = (V.PROVIDERS || []).filter((p) => p.checkin).map((p) => p.name)
        el["checkin-how"].dataset.hit = "1"
        setTimeout(() => delete el["checkin-how"].dataset.hit, 4000)
        el["checkin-where"].textContent = /^zh/i.test(lang || "")
          ? `支持签到的通道：${can.join("、")}。要现在跑一轮，用 magpie 用量页的签到按钮；要看今天谁签了，让 agent 调 veyra_accounts action=checkin。`
          : `Channels with check-in: ${can.join(", ")}. To run one now, use the button on magpie's Usage page; to see who is in today, have the agent call veyra_accounts action=checkin.`
      }
    })
  }

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
