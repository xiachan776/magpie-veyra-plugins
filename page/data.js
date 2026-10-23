/**
 * Veyra · magpie 页面的**纯逻辑层**：只做取数与视图模型转换，一个 DOM 都不碰。
 *
 * 为什么单独拆一层（而不是都塞进 app.js）：
 * - 页面要能在 `connect-src 'none'` 的沙箱里跑，逻辑一旦写进渲染层就只能靠肉眼
 *   验证；拆出来后 `.sync/check-page.mjs` 能把它整段载入执行，文案、格式化、
 *   视图模型都是可断言的纯函数。
 * - 纯逻辑层不读 `window`/`document`，所以它同时能在 Node 里被真跑，不需要 jsdom。
 *
 * ## 数据来源（本页面最重要的一条约束，改动前必读）
 *
 * magpie 宿主把页面能读的东西**硬编码成白名单**：
 *
 *   // internal/plugin/page.go
 *   var PageReads = []string{"usage:summary", "providers:list"}
 *
 * 未声明的 key 在 `WindowPage()` 里被静默丢弃，页面调用时 `/api/plugin-pages/read`
 * 直接 403。所以**不存在**「本插件自定义一个读权限」这条路。
 *
 * 而需要的东西恰好就在 `providers:list` 里 —— 它返回 magpie **当前认识的全部
 * provider**（`provider.All()`），也就是供应商页那份列表本身。所以：
 *
 *   state.providers = null   读不到（桥挂了 / 宿主报错）
 *   state.providers = []     读到了，但一家都没有
 *   state.providers = [...]  真名单，**长度与顺序都由宿主决定**
 *
 * 这解决了曾经那个致命不一致：页面以前只画 `PROVIDERS` 里写死的五家，而供应商页
 * 有二十家，于是「插件里 0 个号、供应商页 11 个号」。现在名册以宿主为准，`PROVIDERS`
 * 退化成**覆盖表**（补主机名/登录方式/签到能力这类宿主管不到的信息），
 * 不在表里的家照样出现，只是那几项显示为「—」。
 *
 * 页面仍然**读不到账号与凭据**（`providers:list` 只给 `{id, name}`，注释写明
 * "no key, no account, no address"）。所以本页的口径始终是：
 * 「有几家、叫什么、哪些已注册到本插件、宿主的记账」，账号明细留给供应商页。
 */
(() => {
  "use strict"

  /** 与 `index.mjs` 的 `VERSION`、`package.json` 的 `version` 三处一致（由 check 脚本锁）。 */
  const VERSION = "0.2.4"

  /** 与宿主 `usage.Summarize` 认的区间一致；顺序即 tab 顺序。 */
  const PERIODS = ["today", "7d", "30d"]

  /**
   * **本包负责的五个渠道**，同时充当名册的覆盖表。
   *
   * 字段逐条对应工厂里真写出的东西：
   * - `name` / `models` ← `config.provider[id].name` 与 `.models` 的条数（兜底表，非远端目录）
   * - `host` ← `config.provider[id].api` 的主机名
   * - `login` ← `auth.methods[0]` 是浏览器轮询还是手机验证码
   * - `checkin` ← 工厂是否真的挂了 `auth.checkin`（**不是**协议上有没有这个端点）
   *
   * `.sync/check-page.mjs` 会按宿主的方式真跑五个工厂逐字段比对，漂移即报错，
   * 所以这张表跟着 src 走，不会静默过期。
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

  /** 覆盖表按 id 索引；`undefined` 表示「不是本包的家」。 */
  const COVER = new Map(PROVIDERS.map((p) => [p.id, p]))

  /**
   * 宿主名册 → 页面名册。
   *
   * 两件事必须守住：
   * 1. **顺序跟宿主**。宿主是 `provider.All()` 的次序，供应商页也是这个次序；自己再排
   *    一次会让人在两个页面之间对不上号。
   * 2. **重复 id 只留第一条**。宿主理论上不会给重复，但一份坏的 `providers:list`
   *    不该让同一家画两次（那看起来像「多出来一个供应商」，正是之前被吐槽的问题）。
   *
   * `state.providers === null` 时返回 `null`，调用方据此走「读不到」分支 ——
   * 不要退化成空数组，那会把「不知道」说成「一家都没有」。
   */
  function roster(state) {
    const list = state && Array.isArray(state.providers) ? state.providers : null
    if (list === null) return null
    const seen = new Set()
    const out = []
    for (const raw of list) {
      const id = String((raw && raw.id) || "").trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      const cover = COVER.get(id)
      out.push({
        id,
        // 宿主给的 name 优先：那是供应商页显示的名字，两边一致比我们自己的写死更可信。
        name: String((raw && raw.name) || (cover && cover.name) || id),
        cover: cover || null,
        mine: Boolean(cover),
      })
    }
    return out
  }

  /* ---- 文案 -------------------------------------------------------------- */

  const TEXT = {
    zh: {
      tagline: "全部供应商的账号归属、登录方式、签到能力与 magpie 记账",
      overview: "总览",
      providers: "Provider",
      usage: "magpie 记账",
      refresh: "刷新",
      refreshed: "更新于",
      periodsLabel: "统计区间",
      period: { today: "今天", "7d": "7 天", "30d": "30 天" },
      loginBrowser: "浏览器授权",
      loginPhone: "手机验证码",
      loginUnknown: "登录方式未知",
      dash: "—",

      // 总览 tiles
      tChannels: "供应商",
      tMine: "本包负责",
      tRegistered: "已注册到 magpie",
      tModels: "兜底模型",
      tCheckin: "支持签到",
      tModelsHint: "本包五家渠道内置的兜底模型表条数；真实目录可能更多（登录后由远端刷新）",
      tChannelsHint: "magpie 当前认识的 provider 总数，与供应商页同一份名单",
      tMineHint: "本插件负责登录与签到的渠道数（另外的由别的插件或内置提供）",

      overviewNote: (n, mine) => `${n} 家供应商，其中 ${mine} 家由本插件负责`,

      // 聚合登录队列
      queueTitle: "账号登录",
      queueCount: (done, total) => `已注册 ${done} / ${total}`,
      queueUnknown: (total) => `共 ${total} 家 · 注册状态未知`,
      queueHint:
        "一个入口列出本包负责的渠道，按建议顺序排好；点任一行右侧的「去登录」会在 magpie 的 Providers 页定位到该渠道，那里才能真完成授权。",
      queueLogin: "去登录",
      queueGoHint: "在 magpie 的 Providers 页登录",
      queueEmpty: "本包负责的渠道一家都没注册上 —— 先看下面的 Provider 段是否报错。",

      // provider 段
      providersNote:
        "本页只读得到 provider 的 id 与名字；账号、额度、签到实况请在 magpie 的 Providers 页查看",
      errNotRegistered: "magpie 里没有这个 provider",
      errRead: "读不到 provider 列表",
      errUsage: "读不到记账数据",

      // provider 卡片
      pMine: "本插件",
      pForeign: "其他",
      pLogin: "登录",
      pModelsFallback: "兜底模型",
      pNotApplicable: "不支持",
      pLoginDash: "登录方式未知",
      pSub: (host) => host || "magpie 里注册的 provider",
      pCheckinOn: "本插件已接签到",
      pCheckinOff: "本插件未接签到",
      pCheckinForeign: "签到由提供它的插件决定",

      // 账号段（与 magpie 的 Providers 页同一批账号）
      accountsTitle: "全部账号",
      accountsNote: (accounts, signed, total) =>
        `${accounts} 个账号 · ${signed} / ${total} 家已登录 · 与 magpie 的供应商页同一份数据`,
      accountsHint: "",
      accountsEmpty: "",
      accountsLoading: "正在读账号…",
      accNoAccounts: "未登录",
      accUnsigned: "有账号但未标记登录",
      accModel: (n) => `${n} 个模型`,
      accCheckin: "可签到",
      accDetails: "详情",

      // 签到段：说清“怎么签的”与“去哪看结果”，页面本身读不到结果
      ckTitle: "每日签到",
      ckNote: (can, all) => `本包 ${can} / ${all} 家有签到`,
      ckBadgeOn: "可签到",
      ckBadgeOff: "无签到",
      crTitle: "积分",
      crNote: "余额不在这一页",
      crWhere:
        "每家的积分余额出自它自己的用量接口，只有 magpie 读得到 —— 在 magpie 的 Providers 页看。这里能给的是签到进账：让 agent 调 veyra_accounts 的 action=credits，会把今日进账、连续天数、到期日按账号列出来。",
      crByCheckin: "签到有进账，可用 action=credits 汇总",
      crNoCheckin: "无签到，也就没有签到进账",
      ckHow:
        "签到由 magpie 自己每天自动跑一次：按北京日、每个账号各签一次，当天失败稍后重投；开关在「设置 → 签到」里按 provider 控制。要立刻跑一轮，用 magpie 用量页的签到按钮。",
      ckWhere:
        "这一页读不到签到结果（页面沙箱只允许读用量汇总）。要看「今天谁签了、谁没签、失败原因」，让 agent 调 veyra_accounts 的 action=checkin。",
      ckBrowser: "浏览器授权 · 自动签到",
      ckPhone: "手机验证码 · 自动签到",
      ckUnsupported: "这家没有签到接口",
      accHintRead: "插件页读不到 token；展开后是账号名、类型与模型数",
      badgeOn: "已注册",
      badgeOff: "未注册",
      badgeUnknown: "无法确认",

      // 空态 / 错误
      cardsEmptyUnknown: "读不到 provider 列表：这一页只能显示 magpie 认识的供应商。",
      cardsEmpty: "magpie 还没有任何 provider。",
      failing: "页面渲染出错，请看开发者工具。",
      noHost: "这个页面要靠 magpie 的 bridge 才能读数据 —— 直接打开 HTML 时没有宿主，读不到任何东西。",

      // 记账
      uCalls: "调用",
      uErrors: "错误",
      uInput: "输入",
      uOutput: "输出",
      uCost: "成本",
      rErrorRate: "错误率",
      rCacheHit: "缓存命中",
      since: (s) => `统计自 ${s}`,
      usageEmpty: "本区间没有调用。",
      usageFailed: "读不到记账：",
      noteNoCalls: "本区间没有调用",
      noteErrorLow: "错误率正常",
      noteErrorHot: "错误率偏高，值得看一眼",
      noteErrorFull: "一半以上的调用在报错",
      colCalls: "次",
      colTokens: "token",
      colCost: "成本",
      footer: (v) => `Veyra for magpie v${v} · 账号与签到由本插件提供，记账来自 magpie`,
    },
    en: {
      tagline: "Accounts, sign-in methods, check-in support and magpie's ledger, for every provider",
      overview: "Overview",
      providers: "Providers",
      usage: "magpie's ledger",
      refresh: "Refresh",
      refreshed: "updated",
      periodsLabel: "Period",
      period: { today: "Today", "7d": "7 days", "30d": "30 days" },
      loginBrowser: "browser sign-in",
      loginPhone: "phone code",
      loginUnknown: "sign-in method unknown",
      dash: "—",

      tChannels: "Providers",
      tMine: "Ours",
      tRegistered: "Known to magpie",
      tModels: "Built-in models",
      tCheckin: "With check-in",
      tModelsHint: "models in the built-in tables of our five channels; the real catalogue may be larger",
      tChannelsHint: "every provider magpie knows, the same list its Providers page shows",
      tMineHint: "channels this plugin signs in and checks in; the rest come from other plugins",

      overviewNote: (n, mine) => `${n} providers, ${mine} of them ours`,

      queueTitle: "Sign in",
      queueCount: (done, total) => `${done} / ${total} known`,
      queueUnknown: (total) => `${total} channels · registration unknown`,
      queueHint:
        "One entry lists the channels this plugin serves, in a sensible order. The button on a row takes you to that provider on magpie's Providers page, where signing in actually happens.",
      queueLogin: "Go sign in",
      queueGoHint: "Sign in on magpie's Providers page",
      queueEmpty: "None of our channels registered — see whether the Providers section below reports an error.",

      providersNote:
        "This page reads a provider's id and name only; accounts, quotas and check-in live on magpie's Providers page",
      errNotRegistered: "magpie has no such provider",
      errRead: "Could not read the provider list",
      errUsage: "Could not read the ledger",

      pMine: "this plugin",
      pForeign: "other",
      pLogin: "sign-in",
      pModelsFallback: "built-in models",
      pNotApplicable: "n/a",
      pLoginDash: "sign-in method unknown",
      pSub: (host) => host || "a provider registered in magpie",
      pCheckinOn: "check-in wired by this plugin",
      pCheckinOff: "no check-in from this plugin",
      pCheckinForeign: "check-in depends on the plugin providing it",

      accountsTitle: "All accounts",
      accountsNote: (accounts, signed, total) =>
        `${accounts} accounts · ${signed} of ${total} providers signed in · same data as magpie's Providers page`,
      accountsHint: "",
      accountsEmpty: "",
      accountsLoading: "reading accounts…",
      accNoAccounts: "not signed in",
      accUnsigned: "accounts but not marked signed in",
      accModel: (n) => `${n} models`,
      accCheckin: "check-in",
      accDetails: "details",
      accHintRead: "the page cannot read tokens; rows show account name, type and model count",

      // check-in: how it runs and where its result is, since this page cannot read the result
      ckTitle: "Daily check-in",
      ckNote: (can, all) => `${can} of this plugin's ${all} providers check in`,
      ckBadgeOn: "check-in",
      ckBadgeOff: "none",
      crTitle: "Credits",
      crNote: "balances are not on this page",
      crWhere:
        "Each provider's balance comes from its own usage endpoint, which only magpie reads — see magpie's Providers page. What is here is check-in credit: have the agent call veyra_accounts with action=credits to list today's credit, the streak and the expiry per account.",
      crByCheckin: "check-in credit usable, add it up with action=credits",
      crNoCheckin: "no check-in, so no check-in credit",
      ckHow:
        "Check-in runs by itself once a day inside magpie: every account once per Beijing day, a failure tried again later that day. Per-provider switches live in Settings → Check-in; magpie's Usage page has the button to run it now.",
      ckWhere:
        "This page cannot read check-in results — its sandbox only allows the usage summary. To see who is in today, who is not, and why a run failed, have the agent call veyra_accounts with action=checkin.",
      ckBrowser: "browser sign-in · daily check-in",
      ckPhone: "SMS code · daily check-in",
      ckUnsupported: "no check-in endpoint",
      badgeOn: "known",
      badgeOff: "not registered",
      badgeUnknown: "unknown",

      cardsEmptyUnknown: "Could not read the provider list: this page can only show what magpie knows.",
      cardsEmpty: "magpie has no providers yet.",
      failing: "The page failed to render; see the developer console.",
      noHost: "This page needs magpie's bridge to read data — opening the HTML directly has no host, so nothing loads.",

      uCalls: "calls",
      uErrors: "errors",
      uInput: "input",
      uOutput: "output",
      uCost: "cost",
      rErrorRate: "error rate",
      rCacheHit: "cache hits",
      since: (s) => `since ${s}`,
      usageEmpty: "No calls in this period.",
      usageFailed: "Could not read the ledger: ",
      noteNoCalls: "no calls in this period",
      noteErrorLow: "error rate is fine",
      noteErrorHot: "error rate is high; worth a look",
      noteErrorFull: "more than half of the calls fail",
      colCalls: "calls",
      colTokens: "tokens",
      colCost: "cost",
      footer: (v) => `Veyra for magpie v${v} · accounts and check-in by this plugin, ledger by magpie`,
    },
  }

  /** 语言标记 → 词典。繁体与日语都落中文（宿主 `lang` 目前只给 zh/en/zh-TW）。 */
  function text(lang) {
    const s = String(lang || "").toLowerCase()
    if (s.startsWith("zh")) return TEXT.zh
    return TEXT.en
  }

  /* ---- 数字格式 ---------------------------------------------------------- */

  function num(n) {
    const v = Number(n) || 0
    return v.toLocaleString("en-US")
  }

  /** 拆成「数值 + 量级后缀」，好让 `K`/`M` 用 `.u` 小字排（`209K` 里的 K 不该跟数字一样大）。 */
  function split(n) {
    const v = Number(n) || 0
    const a = Math.abs(v)
    if (a >= 1e9) return { v: (v / 1e9).toFixed(a >= 1e10 ? 0 : 1), u: "B" }
    if (a >= 1e6) return { v: (v / 1e6).toFixed(a >= 1e7 ? 0 : 1), u: "M" }
    if (a >= 1e3) return { v: (v / 1e3).toFixed(a >= 1e4 ? 0 : 1), u: "K" }
    return { v: String(Math.round(v)), u: "" }
  }

  function pct(x) {
    const v = Math.max(0, Math.min(1, Number(x) || 0))
    if (v === 0) return "0%"
    // 低于 0.1%：写「<0.1%」，因为「0.00%」会被读成完全没有错误。
    if (v < 0.001) return "<0.1%"
    if (v < 0.01) return `${(v * 100).toFixed(1)}%`
    return `${(v * 100).toFixed(0)}%`
  }

  /** 成本用美元；不足一分钱时写「<$0.01」，因为「$0.0010」会被读成接近免费。 */
  function money(x) {
    const v = Number(x) || 0
    if (v === 0) return "$0"
    if (v < 0.01) return "<$0.01"
    if (v < 0.15) return `$${v.toFixed(3).replace(/0+$/, "")}`
    return `$${v.toFixed(2)}`
    return `$${v.toFixed(2)}`
  }

  function clock(d) {
    const t = d instanceof Date ? d : new Date(d)
    if (Number.isNaN(t.getTime())) return ""
    const p = (n) => String(n).padStart(2, "0")
    return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
  }

  function stamp(iso) {
    const t = iso instanceof Date ? iso : new Date(iso)
    if (Number.isNaN(t.getTime())) return ""
    const p = (n) => String(n).padStart(2, "0")
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
  }

  /* ---- 视图模型 ---------------------------------------------------------- */

  /**
   * 总览四格。
   *
   * 「已注册」与「供应商数」现在是同一件事（名册就是 `providers:list`），所以不再
   * 分成两个格子报同一个数 —— 那会让人以为它们是两个不同的指标。
   * 换成了「本包负责几家」，这才是插件页该回答的问题。
   */
  function overview(state, t) {
    const rows = roster(state)
    const mine = rows === null ? null : rows.filter((r) => r.mine).length

    const tiles = [
      {
        k: t.tChannels,
        v: rows === null ? "?" : String(rows.length),
        title: t.tChannelsHint,
      },
      {
        k: t.tMine,
        v: mine === null ? "?" : String(mine),
        title: t.tMineHint,
      },
      {
        k: t.tModels,
        v: String(PROVIDERS.reduce((n, p) => n + p.models, 0)),
        title: t.tModelsHint,
      },
      {
        k: t.tCheckin,
        v: String(PROVIDERS.filter((p) => p.checkin).length),
        u: `/ ${PROVIDERS.length}`,
        title: t.tModelsHint,
      },
    ]
    return tiles
  }

  function overviewNote(state, t) {
    const rows = roster(state)
    if (rows === null) return ""
    return t.overviewNote(rows.length, rows.filter((r) => r.mine).length)
  }

  /**
   * Provider 卡片：**每一家都画**，顺序跟宿主。
   *
   * 不在覆盖表里的家（别的插件负责的那些）照样出现 —— 这正是用户要的「插件页显示
   * 所有账号系统」的名册部分。它们的登录方式、兜底模型条数宿主管不到，如实写「—」，
   * 而不是编一个 0（0 会被读成「没有模型」，那是假信息）。
   */
  function cards(state, t) {
    const rows = roster(state)
    if (rows === null) return []
    return rows.map((r) => {
      const c = r.cover
      // 覆盖表里的家给真数字；别家的给「—」并说明为什么 —— 写 0 会被读成
      // 「没有模型」，那是编的。
      const facts = c
        ? [
            { k: t.pModelsFallback, v: String(c.models), title: t.tModelsHint },
            {
              k: t.pLogin,
              v: c.login === "phone" ? t.loginPhone : t.loginBrowser,
            },
          ]
        : [
            { k: t.pModelsFallback, v: t.dash, title: t.pCheckinForeign },
            { k: t.pLogin, v: t.dash, title: t.loginUnknown },
          ]
      return {
        pid: r.id,
        title: r.name,
        sub: t.pSub(c ? c.host : ""),
        badge: r.mine
          ? { kind: "ok", text: t.pMine }
          : { kind: "other", text: t.pForeign },
        facts,
        checkin: r.mine
          ? { on: Boolean(c && c.checkin), said: c && c.checkin ? t.pCheckinOn : t.pCheckinOff }
          : { on: false, said: t.pCheckinForeign },
        error: null,
      }
    })
  }

  /**
   * 聚合登录队列：**只列本包负责的渠道**。
   *
   * 为什么不再列全部：队列的动作是「去登录」，而只有本包的五家有我们的登录流程；
   * 把别家的二十家也塞进来会变成一份什么都点不动的清单。名册的完整性由上面的
   * Provider 段负责，这里只负责「本包这五家，下一步点哪」。
   *
   * 排序：已注册且能签到 → 已注册不能签到 → 未注册。同档内保持 `PROVIDERS` 声明
   * 次序（不按名字排，避免刷新时行跳位）。
   */
  function loginQueue(state, t) {
    const rows = roster(state)
    const known = rows === null ? null : new Set(rows.map((r) => r.id))
    const rank = (p) => {
      if (known === null) return 0
      return known.has(p.id) ? (p.checkin ? 0 : 1) : 2
    }
    const items = PROVIDERS.map((p) => ({ p, order: rank(p) }))
      .sort((a, b) => a.order - b.order)
      .map(({ p, order }) => {
        const isKnown = known === null ? null : order < 2
        return {
          pid: p.id,
          name: p.name,
          login: p.login === "phone" ? t.loginPhone : t.loginBrowser,
          checkin: p.checkin,
          known: isKnown,
          badge:
            isKnown === null
              ? { kind: "off", text: t.badgeUnknown }
              : isKnown
                ? { kind: "ok", text: t.badgeOn }
                : { kind: "dead", text: t.badgeOff },
        }
      })
    const total = PROVIDERS.length
    const done = known === null ? null : items.filter((x) => x.known).length
    return {
      items,
      total,
      done,
      count: done === null ? t.queueUnknown(total) : t.queueCount(done, total),
      hint: t.queueHint,
      empty: done === 0,
    }
  }

  /**
   * 账号段 —— 页面**读不到账号**，所以这一段恒为错误态。
   *
   * 保留函数是为了让渲染层与测试不必分叉；文案已改成说明「为什么读不到」，
   * 而不是假装自己有一次读取（上一版就是这样，注释还写着「数据来自
   * plugin-providers.json」，那是错的：页面桥没有文件通道）。
   */
  function accounts(state, t) {
    return {
      note: "",
      hint: t.accountsHint,
      groups: [],
      error: t.accountsEmpty,
      summary: null,
    }
  }

  /**
   * 记账段。
   *
   * 两个比例都是**真算出来的**：错误率与缓存命中。`.hot`/`.full` 只用于错误率
   * （越高越糟）；缓存命中越高越好，用普通 accent 色，不然会把好消息染成红色。
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
      note:
        calls === 0
          ? t.noteNoCalls
          : errRatio >= 0.5
            ? t.noteErrorFull
            : errRatio >= 0.2
              ? t.noteErrorHot
              : t.noteErrorLow,
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
      since: summary.since ? t.since(stamp(summary.since)) : "",
      empty: calls === 0 && rows.length === 0,
    }
  }

  /**
   * 每日签到：**页面能看到什么、看不到什么都照实说**。
   *
   * magpie 自己每天自动签（`internal/provider/plugin_checkin.go:216`
   * 的 `KeepPluginsCheckedIn`：按北京日逐号签、当天失败稍后重试，结果写进
   * `plugin-checkin.json`），手动触发在 Usage 页。
   *
   * 但插件页是沙箱页（`connect-src 'none'`，只能 `providers:list` /
   * `usage:summary`），**读不到那份文件、也发不出请求**。所以这里不编造
   * “今天已签 3 个”，只做三件真能做的事：
   *
   * 1. 说清签到是怎么发生的（自动 + 手动在哪）；
   * 2. 逐家列出本包这五家哪些有签到能力（静态能力，来自 PROVIDERS）；
   * 3. 指路：要看“今天谁签到了”，用 `veyra_accounts action=checkin`。
   */
  function checkin(state, t) {
    const r = roster(state)
    const known = r === null ? PROVIDERS : PROVIDERS.filter((p) => (r ?? []).some((x) => x.id === p.id))
    const rows = known.map((p) => ({
      pid: p.id,
      name: p.name,
      on: Boolean(p.checkin),
      // 有签到能力的家，登录方式不同，签到的失败模式也不同（loomy 要手机验证码）。
      said: p.checkin ? (p.login === "phone" ? t.ckPhone : t.ckBrowser) : t.ckUnsupported,
    }))
    const can = rows.filter((x) => x.on).length
    return {
      note: t.ckNote(can, rows.length),
      how: t.ckHow,
      where: t.ckWhere,
      rows,
    }
  }

  /**
   * 积分：这一页能说与不能说的。
   *
   * 余额不在这里，而且不可能在这里：每家的余额出自 auth.usage
   * (internal/plugin/host.js:2228 的 balance 与 windows[].amount/limit)，
   * 那份数据只在宿主里经过一次就丢掉了，插件进程拿不到；页面沙箱也只被允许读
   * usage:summary 与 providers:list 两个 key (internal/plugin/page.go:77)，
   * 没有任何一条路能把余额送进来。
   *
   * 所以这一段只做指路：余额去哪儿看，签到进账去哪儿算。写一个假的
   * "积分 5000" 比不写更糟 —— 用户会拿它跟供应商页对账。
   */
  function credits(state, t) {
    const r = roster(state)
    const rows = (r === null ? PROVIDERS : PROVIDERS.filter((p) => r.some((x) => x.id === p.id))).map((p) => ({
      pid: p.id,
      name: p.name,
      on: Boolean(p.checkin),
      said: p.checkin ? t.crByCheckin : t.crNoCheckin,
    }))
    return { note: t.crNote, where: t.crWhere, rows }
  }
  globalThis.VeyraPage = {
    VERSION,
    PERIODS,
    PROVIDERS,
    COVER,
    roster,
    text,
    fmt: { num, split, pct, money, clock, stamp },
    overview,
    overviewNote,
    cards,
    loginQueue,
    accounts,
    checkin,
    credits,
    usage,
  }
})()
