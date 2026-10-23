/**
 * Veyra · magpie 页面的**纯逻辑层**：只做取数与视图模型转换，一个 DOM 都不碰。
 *
 * 为什么单独拆一层（而不是都塞进 app.js）：
 * - 页面要能在 `connect-src 'none'` 的沙箱里跑，逻辑一旦写进渲染代码就只能靠
 *   肉眼验证；拆出来后 `.sync/check-page.mjs` 能把它整段载入执行，
 *   文案、格式化、视图模型都是可断言的纯函数。
 * - 纯逻辑层不读 `window`/`document`，所以它同时能在 Node 里被真跑，不需要 jsdom。
 *
 * ## 数据来源（这是本页面最重要的一条约束，改动前必读）
 *
 * magpie 宿主把页面能读的东西**硬编码成白名单**：
 *
 *   // internal/plugin/page.go
 *   var PageReads = []string{"usage:summary", "providers:list"}
 *
 * 未声明的 key 在 `WindowPage()` 里被静默丢弃，页面调用时
 * `/api/plugin-pages/read` 直接 403。也就是说**不存在**「我方插件自定义一个读权限」
 * 这条路 —— 改成 `magpie-veyra:accounts` 之类的 key 不是报错，而是永远 403。
 *
 * 页面还有更硬的边界：桥接只有 `ready / read / options.get / options.set / theme`，
 * 没有任何通往插件自己的 `index.mjs`/`src/*.mjs` 的通道；而且「只有页面」的插件
 * 连 Bun 宿主都不启动（`inMagpieOnly`），`src/veyra.mjs` 那套账号读取能力在页面里
 * 根本不可能 require 到（浏览器沙箱 + `connect-src 'none'`）。
 *
 * ⇒ 结论：页面**拿不到**账号列表、额度窗口、签到实况这类 Veyra 私有数据。
 *   能拿到的只有两样：
 *     - `providers:list` → `[{id, name}]`：magpie 当前认识的 provider。
 *       某个 id 在列表里 = **本插件已加载且注册成功**，这是很有用的运行时事实。
 *     - `usage:summary`  → magpie 自己的记账汇总（按区间）。
 *
 * 所以本页的定位是「**渠道静态事实 + 注册状态 + magpie 记账**」，
 * 而账号/额度/签到实况老老实实留给 magpie 的 Providers 页（那里能真调 provider 的
 * `usage`/`checkin` hook）。宁可少显示，也不编一个看起来像真的进度条。
 *
 * 下面 `PROVIDERS` 是**静态快照**（渠道名、端点、登录方式、是否支持签到、兜底模型表
 * 条数）。它不是拍脑袋写死的：`.sync/check-page.mjs` 会按宿主的方式真跑五个工厂，
 * 逐字段比对，漂移即报错 —— 这样「改了 src 忘了改页面」不会静默发生。
 */
(() => {
  "use strict"

  /** 与 `index.mjs` 的 `VERSION`、`package.json` 的 `version` 三处一致（由 check 脚本锁）。 */
  const VERSION = "0.2.0"

  /** 与宿主 `usage.Summarize` 认的区间一致；顺序即 tab 顺序。 */
  const PERIODS = ["today", "7d", "30d"]

  /**
   * 五个渠道的静态事实。字段逐条对应工厂里真写出的东西：
   * - `name` / `models` ← `config.provider[id].name` 与 `.models` 的条数（兜底表，非远端目录）
   * - `host` ← `config.provider[id].api` 的主机名
   * - `login` ← `auth.methods[0]` 是浏览器轮询还是手机验证码
   * - `checkin` ← 工厂是否真的挂了 `auth.checkin`（**不是**协议上有没有这个端点）
   */
  const PROVIDERS = [
    {
      id: "codebuddy",
      name: "CodeBuddy",
      host: "copilot.tencent.com",
      login: "browser",
      checkin: true,
      models: 16,
    },
    {
      id: "codebuddy-intl",
      name: "CodeBuddy Intl",
      host: "www.codebuddy.ai",
      login: "browser",
      checkin: false,
      models: 23,
    },
    {
      id: "lobsterai",
      name: "LobsterAI",
      host: "lobsterai-server.youdao.com",
      login: "browser",
      checkin: true,
      models: 19,
    },
    {
      id: "codearts",
      name: "CodeArts",
      host: "snap-access.cn-north-4.myhuaweicloud.com",
      login: "browser",
      checkin: true,
      models: 9,
    },
    {
      id: "loomy",
      name: "Loomy",
      host: "loomyad.xunfei.cn",
      login: "phone",
      checkin: true,
      models: 8,
    },
  ]

  /* ---- 文案 -------------------------------------------------------------- */

  const TEXT = {
    zh: {
      tagline: "五个渠道的账号归属、登录方式、签到能力与 magpie 记账",
      overview: "总览",
      providers: "Provider",
      usage: "magpie 记账",
      refresh: "刷新",
      refreshed: "更新于",
      periodsLabel: "统计区间",
      period: { today: "今天", "7d": "7 天", "30d": "30 天" },

      // 总览 tiles
      tChannels: "渠道",
      tRegistered: "已注册到 magpie",
      tModels: "兜底模型",
      tCheckin: "支持签到",
      tModelsHint: "插件内置的兜底模型表条数；真实目录可能更多（登录后由远端刷新）",

      overviewNote: (n, total) => `${n} / ${total} 个渠道已被 magpie 认识`,

      // 聚合登录队列
      queueTitle: "账号登录",
      queueCount: (done, total) => `已注册 ${done} / ${total}`,
      queueUnknown: (total) => `共 ${total} 家 · 注册状态未知`,
      queueHint:
        "一个入口列出五家，按建议顺序排好；点任一行右侧的「去登录」会在 magpie 的 Providers 页打开该渠道，那里才能真完成授权。",
      queueLogin: "去登录",
      queueGoHint: "在 magpie 的 Providers 页登录",

      // provider 段
      providersNote:
        "本页只读得到 provider 的 id 与名字；账号、额度、签到实况请在 magpie 的 Providers 页查看",
      badgeOn: "已注册",
      badgeOff: "未注册",
      badgeUnknown: "无法确认",
      fModels: "模型",
      fLogin: "登录",
      loginBrowser: "浏览器授权",
      loginPhone: "手机验证码",
      checkinOn: "每日可签",
      checkinOff: "无每日签到",
      errNotRegistered:
        "magpie 的 providers:list 里没有这个 id：本插件很可能没装上、被关掉了，或注册时抛错（注册失败不会报错，只在 Providers 页缺席）。",
      errUnreadable: "读不到 magpie 的 provider 列表，无法确认这个渠道是否已注册：",
      cardsEmpty:
        "五个渠道一个都不在 magpie 的 providers:list 里。这通常意味着本插件未安装或被停用 —— 页面上能看到的只是插件源码里的静态声明，不代表 magpie 真的能路由这些渠道。",
      cardsEmptyUnknown: "读不到 magpie 的 provider 列表（providers:list），无法核对这五个渠道是否已注册。",

      // 记账段
      since: (when) => `统计自 ${when} 起 · 每行：调用 · tokens · 成本`,
      uCalls: "调用",
      uErrors: "错误",
      uInput: "输入 tokens",
      uOutput: "输出 tokens",
      uCost: "成本",
      rErrorRate: "错误率",
      rCacheHit: "缓存命中",
      noteNoCalls: "本区间没有调用",
      noteErrorLow: "占比正常",
      noteErrorHot: "偏高",
      noteErrorFull: "过高",
      usageEmpty: "本区间没有调用记录：magpie 还没有通过任何 agent 走这个网关。",
      usageFailed: "读不到 magpie 的记账数据：",
      colCalls: "调用",
      colTokens: "tokens",
      colCost: "成本",

      footer: (v) =>
        `magpie-veyra-auth v${v} · 五个渠道：CodeBuddy（国内/国际）、LobsterAI、CodeArts、Loomy · 账号与额度请到 magpie 的 Providers 页查看`,
      noHost:
        "这个页面必须由 magpie 打开（它需要宿主注入的 _magpie/bridge.js）。直接用浏览器打开时没有 magpie 桥，因此读不到任何数据。",
      failing: "页面没能加载完，稍后会自动重试。",
    },
    en: {
      tagline: "Accounts, sign-in, check-in and magpie's ledger for the five channels",
      overview: "Overview",
      providers: "Providers",
      usage: "magpie ledger",
      refresh: "Refresh",
      refreshed: "Updated",
      periodsLabel: "Period",
      period: { today: "Today", "7d": "7 days", "30d": "30 days" },

      tChannels: "Channels",
      tRegistered: "Known to magpie",
      tModels: "Fallback models",
      tCheckin: "With check-in",
      tModelsHint:
        "Entries in the plugin's own fallback table; the live catalog can be larger once signed in",

      overviewNote: (n, total) => `${n} of ${total} channels known to magpie`,

      // Aggregated sign-in queue
      queueTitle: "Accounts",
      queueCount: (done, total) => `${done} of ${total} registered`,
      queueUnknown: (total) => `${total} channels · registration unknown`,
      queueHint:
        "One entry lists all five in suggested order; the button on each row opens that channel on magpie's Providers page, which is the only place sign-in can actually finish.",
      queueLogin: "Sign in",
      queueGoHint: "Sign in on magpie's Providers page",

      providersNote:
        "A page can read only provider ids and names; accounts, quotas and check-in live on magpie's Providers page",
      badgeOn: "registered",
      badgeOff: "missing",
      badgeUnknown: "unknown",
      fModels: "models",
      fLogin: "sign-in",
      loginBrowser: "browser",
      loginPhone: "phone code",
      checkinOn: "daily check-in",
      checkinOff: "no check-in",
      errNotRegistered:
        "magpie's providers:list has no such id: this plugin is most likely not installed, switched off, or threw while registering (a failed registration is silent, it just never shows up under Providers).",
      errUnreadable: "Could not read magpie's provider list, so this channel's registration is unknown: ",
      cardsEmpty:
        "None of the five channels is in magpie's providers:list. That usually means this plugin is not installed or is switched off — what you see is the plugin's own static declaration, not what magpie can actually route.",
      cardsEmptyUnknown: "Could not read magpie's provider list, so these five cannot be checked.",

      since: (when) => `Since ${when} · each row: calls · tokens · cost`,
      uCalls: "Calls",
      uErrors: "Errors",
      uInput: "Input tokens",
      uOutput: "Output tokens",
      uCost: "Cost",
      rErrorRate: "Error rate",
      rCacheHit: "Cache hit",
      noteNoCalls: "no calls in this period",
      noteErrorLow: "normal",
      noteErrorHot: "high",
      noteErrorFull: "too high",
      usageEmpty: "No calls in this period: magpie has not served anything through this gateway yet.",
      usageFailed: "Could not read magpie's usage: ",
      colCalls: "calls",
      colTokens: "tokens",
      colCost: "cost",

      footer: (v) =>
        `magpie-veyra-auth v${v} · CodeBuddy (CN/Intl), LobsterAI, CodeArts, Loomy · accounts and quotas live on magpie's Providers page`,
      noHost:
        "This page has to be opened by magpie (it needs the host's _magpie/bridge.js). Opened straight in a browser there is no bridge, so it can read nothing.",
      failing: "The page did not finish loading; it will try again shortly.",
    },
  }

  /** 按语言码挑词典：`zh-TW`/`zh-Hans` 之类一律归中文，其余归英文（与宿主 `titled` 的取向一致）。 */
  function text(lang) {
    return String(lang || "").toLowerCase().startsWith("zh") ? TEXT.zh : TEXT.en
  }

  /* ---- 数值格式化 -------------------------------------------------------- */

  /** 千分位，用于 `title` 之类需要精确值的地方。 */
  function num(n) {
    const x = Number(n)
    if (!Number.isFinite(x)) return "0"
    return Math.round(x).toLocaleString("en-US")
  }

  /**
   * 拆成「数值 + 量级单位」两段，让 `.tile .v` 显示大字、`.u` 显示小字。
   * 与参考实现（返回 "1.23M" 单串）的区别只是形态：这里 CSS 已经有 `.u` 了。
   */
  function split(n) {
    const x = Number(n)
    if (!Number.isFinite(x) || x === 0) return { v: "0", u: "" }
    const abs = Math.abs(x)
    if (abs < 1000) return { v: String(Math.round(x)), u: "" }
    const units = [
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "K"],
    ]
    for (const [size, unit] of units) {
      if (abs >= size) return { v: (x / size).toFixed(abs / size >= 100 ? 0 : 1), u: unit }
    }
    return { v: String(Math.round(x)), u: "" }
  }

  /** 由比例得到百分比文本；0 与极小的值分开表达，避免 "0.0%" 掩盖"有错误但很少"。 */
  function pct(ratio) {
    const r = Number(ratio)
    if (!Number.isFinite(r) || r <= 0) return "0%"
    const p = r * 100
    if (p < 0.1) return "<0.1%"
    return `${p.toFixed(p >= 10 ? 0 : 1)}%`
  }

  /** 成本：零就是 $0，不足一分钱用 `<$0.01` 表示 —— 显示 "$0.00" 会被读成免费。 */
  function money(cost) {
    const c = Number(cost)
    if (!Number.isFinite(c) || c <= 0) return "$0"
    if (c < 0.01) return "<$0.01"
    if (c < 1000) return `$${c.toFixed(2)}`
    const s = split(c)
    return `$${s.v}${s.u}`
  }

  const pad = (n) => String(n).padStart(2, "0")

  /** 时钟：顶栏「更新于 20:31:07」。 */
  function clock(date) {
    const d = date instanceof Date ? date : new Date(date)
    if (Number.isNaN(d.getTime())) return ""
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  /** 日期时刻：`since` 是 RFC3339，本地化后便于与"今天/7 天"对上。 */
  function stamp(value) {
    const d = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(d.getTime())) return ""
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /* ---- 视图模型 ---------------------------------------------------------- */

  /**
   * 总览 tiles。
   * `registered` 为 `null` 表示读不到 provider 列表 —— 此时显示 "?" 而不是 0，
   * 因为 "0 个已注册" 与 "不知道" 是两件事，混为一谈会把可修的配置问题藏起来。
   */
  function overview(state, t) {
    const total = PROVIDERS.length
    const registered = state.providers ? state.providers.length : null
    return [
      { k: t.tChannels, v: String(total) },
      { k: t.tRegistered, v: registered === null ? "?" : String(registered), u: `/ ${total}` },
      { k: t.tModels, v: String(PROVIDERS.reduce((n, p) => n + p.models, 0)), title: t.tModelsHint },
      { k: t.tCheckin, v: String(PROVIDERS.filter((p) => p.checkin).length), u: `/ ${total}` },
    ]
  }

  /** provider 卡片。`state.providerError` 是读 `providers:list` 的失败原因。 */
  function cards(state, t) {
    const known = state.providers
    const ids = new Set((known || []).map((p) => (p && typeof p.id === "string" ? p.id : "")))
    return PROVIDERS.map((p) => {
      const isKnown = known ? ids.has(p.id) : null
      const badge =
        isKnown === null
          ? { kind: "off", text: t.badgeUnknown }
          : isKnown
            ? { kind: "ok", text: t.badgeOn }
            : { kind: "dead", text: t.badgeOff }
      let error = null
      if (isKnown === false) error = t.errNotRegistered
      else if (isKnown === null) error = t.errUnreadable + (state.providerError || "?")
      return {
        id: p.id,
        title: p.name,
        sub: p.host,
        pid: p.id,
        badge,
        facts: [
          { k: t.fModels, v: String(p.models), title: t.tModelsHint },
          { k: t.fLogin, v: p.login === "phone" ? t.loginPhone : t.loginBrowser },
        ],
        checkin: { on: p.checkin, said: p.checkin ? t.checkinOn : t.checkinOff },
        error,
      }
    })
  }

  /**
   * 聚合视图：一张卡片容纳五个渠道，按「该不该现在登录」排序。
   *
   * ## 为什么要有这个东西（这是页面的定位问题，不是排版问题）
   *
   * magpie 的 Providers 页把五家画成五张独立卡片，每张各带一个「登录」按钮 ——
   * 用户实测的抱怨是「窗口太多了」。但**页面本身发不出登录**：桥只有
   * hello/theme/options.get/options.set/read 五个方法，没有一个是「让宿主去 signIn」，
   * 而且沙箱是 `connect-src 'none'`，连授权页都打不开。
   *
   * 所以这里能做的是**把五家收敛成一条有序队列**：一张卡片、一份「先登哪个」的次序、
   * 每个渠道只留一个「去登录」的落点（仍然是宿主的 Providers 页，因为只有那里能真登）。
   * 用户从一个入口看到「还有几家没登」，而不是在五张卡里自己找。
   *
   * ## 排序规则（越靠前越该先点）
   *
   * 1. 未注册到 magpie 的排最后 —— 它连按钮都点不了，放前面只会挡住能登的。
   * 2. 其中「支持签到 / 模型更多」的优先：这些渠道登录后的收益更高。
   * 3. 同一档内保持 PROVIDERS 的声明顺序，避免每次刷新次序乱跳（顺序跳动会让人
   *    误以为状态变了）。
   *
   * `registered` 为 `null`（读不到 providers:list）时不排序，原样输出并在
   * 卡片级说明里讲清楚「无法确认」，不假装算出了次序。
   */
  function loginQueue(state, t) {
    const known = state.providers
    const ids = new Set((known || []).map((p) => (p && typeof p.id === "string" ? p.id : "")))
    const rank = (p) => {
      if (known === null) return 1
      if (!ids.has(p.id)) return 3
      // 已注册：有签到能力的排前面（登录收益高），其余一档。
      return p.checkin ? 0 : 1
    }
    const rows = PROVIDERS.map((p, i) => ({
      i,
      p,
      known: known === null ? null : ids.has(p.id),
      order: rank(p),
    }))
    rows.sort((a, b) => (a.order === b.order ? a.i - b.i : a.order - b.order))

    const items = rows.map(({ p, known: isKnown }) => ({
      id: p.id,
      name: p.name,
      host: p.host,
      pid: p.id,
      login: p.login === "phone" ? t.loginPhone : t.loginBrowser,
      models: String(p.models),
      checkin: p.checkin,
      known: isKnown,
      // 状态徽标：与 cards() 同一套语汇，避免同一个页面对同一件事用两种说法。
      badge:
        isKnown === null
          ? { kind: "off", text: t.badgeUnknown }
          : isKnown
            ? { kind: "ok", text: t.badgeOn }
            : { kind: "dead", text: t.badgeOff },
    }))

    const total = PROVIDERS.length
    /** 已注册数：读不到时是 null，显示「?」而不是 0。 */
    const done = known === null ? null : items.filter((x) => x.known).length

    return {
      items,
      total,
      done,
      // 计数文案由纯函数算，渲染层不碰复数/语序。
      count: done === null ? t.queueUnknown(total) : t.queueCount(done, total),
      // 下一步该点哪个：只挑「已注册但还没登录的」没有意义（页面看不到登录态），
      // 所以给的是「能登的渠道里排第一的那个」—— 用户从它开始就行。
      hint: t.queueHint,
    }
  }

  /**
   * 记账段。
   *
   * 这里出现 `.bar` 的两个指标都是**真算出来的比例**：错误率与缓存命中。
   * `.hot`/`.full` 只用于错误率（越高越糟）；缓存命中越高越好，用普通 accent 色，
   * 不然会把好消息染成红色。
   */
  function usage(period, summary, t) {
    if (!summary) return null
    const calls = Number(summary.calls) || 0
    const errors = Number(summary.errors) || 0
    const input = Number(summary.input) || 0
    const output = Number(summary.output) || 0
    const cache = Number(summary.cacheRead) || 0
    const cost = Number(summary.cost) || 0

    const inS = split(input)
    const outS = split(output)

    /**
     * 数字格只放 5 个：调用 / 错误 / 输入 / 输出 / 成本。
     * 刻意**不**单列「缓存读」—— 它已经在下面的「缓存命中」量条里（含精确值 title），
     * 单列会让格子数变成 8 个，在常见宽度下最后一行挂一个孤零零的格子，很难看。
     */
    const tiles = [
      { k: t.uCalls, v: split(calls).v, u: split(calls).u },
      { k: t.uErrors, v: split(errors).v, u: split(errors).u },
      { k: t.uInput, v: inS.v, u: inS.u },
      { k: t.uOutput, v: outS.v, u: outS.u },
      { k: t.uCost, v: money(cost) },
    ]

    /** 量条左侧用紧凑写法（`209K / 541K`），精确值放 title —— 长数字会把条挤到第二行。 */
    const pair = (a, b) => {
      const x = split(a)
      const y = split(b)
      return `${x.v}${x.u} / ${y.v}${y.u}`
    }

    // 错误率：调用为 0 时没有分母，明确写「本区间没有调用」而不是 0%。
    const errRatio = calls > 0 ? errors / calls : 0
    const errorRatio = {
      k: t.rErrorRate,
      left: calls > 0 ? pair(errors, calls) : "—",
      title: `${num(errors)} / ${num(calls)}`,
      amt: calls > 0 ? pct(errRatio) : "—",
      width: Math.min(100, Math.round(errRatio * 100)),
      tone: errRatio >= 0.5 ? "full" : errRatio >= 0.2 ? "hot" : "",
      note: calls === 0 ? t.noteNoCalls : errRatio >= 0.5 ? t.noteErrorFull : errRatio >= 0.2 ? t.noteErrorHot : t.noteErrorLow,
    }

    // 缓存命中：cacheRead 与 input 互不包含（宿主的 Record 注释如此），故分母是两者之和。
    const cacheBase = input + cache
    const cacheRatio = {
      k: t.rCacheHit,
      left: cacheBase > 0 ? pair(cache, cacheBase) : "—",
      title: `${num(cache)} / ${num(cacheBase)}`,
      amt: cacheBase > 0 ? pct(cache / cacheBase) : "—",
      width: cacheBase > 0 ? Math.min(100, Math.round((cache / cacheBase) * 100)) : 0,
      tone: "",
      note: "",
    }

    // 宿主最多给 20 条模型（`if i == 20 { break }`），这里不再截断，如实画完。
    const rows = (Array.isArray(summary.models) ? summary.models : []).map((m) => {
      const c = Number(m && m.calls) || 0
      const i = Number(m && m.input) || 0
      const o = Number(m && m.output) || 0
      const k = Number(m && m.cost) || 0
      const tokens = split(i + o)
      return {
        name: String((m && m.model) || "?"),
        n1: split(c).v + split(c).u,
        n2: tokens.v + tokens.u,
        n3: money(k),
        t1: `${t.colCalls} ${num(c)}`,
        t2: `${t.colTokens} in ${num(i)} / out ${num(o)}`,
        t3: `${t.colCost} ${money(k)}`,
      }
    })

    return {
      period,
      tiles,
      ratios: [errorRatio, cacheRatio],
      rows,
      // 宿主一定给 since；给不出时宁可不写这一行，也不要显示「统计自 — 起」。
      since: summary.since ? t.since(stamp(summary.since)) : "",
      empty: calls === 0 && rows.length === 0,
    }
  }

  globalThis.VeyraPage = {
    VERSION,
    PERIODS,
    PROVIDERS,
    text,
    fmt: { num, split, pct, money, clock, stamp },
    overview,
    cards,
    loginQueue,
    usage,
  }
})()
