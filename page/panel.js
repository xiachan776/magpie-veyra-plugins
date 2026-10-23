/**
 * Veyra 的 provider 面板（`magpie.panels` 的 `slot: "provider"`）。
 *
 * ## 它只回答一个问题：这一行是什么、现在通不通
 *
 * 宿主把它挂在**每个已存 provider 的编辑页**底部，并通过 `magpie.context.provider`
 * 告诉它「现在在谁家」。所以同一个文件服务五家，各自只画自己那一行 —— 这一行的
 * 模型数、登录方式、签到状态、在 magpie 记账里有没有流量。
 *
 * ## 不重复大页面做的事
 *
 * 侧边栏的「Veyra 账号」页负责**总览**（五家并排、记账段、区间切换）。
 * 这里刻意只放**与当前 provider 有关**的三四行：在编辑页里滚到一屏总览，
 * 等于让用户离开正在改的那一行。
 *
 * ## 权限
 *
 * 沙箱是 `allow-scripts`，读不到网络也读不到 magpie 的 API；一切都走
 * `magpie.read`，而它只放行 `package.json` 里声明过的
 * `providers:list` 与 `usage:summary`。少声明一项，这里就是 403，
 * 所以两处必须同时改。
 */
;(() => {
  "use strict"

  const $ = (id) => document.getElementById(id)

  /** 五家的静态资料（与大页面同源，避免两处各写一份）。 */
  const KNOWN = {
    codebuddy: { name: "CodeBuddy", login: "browser", checkin: true },
    "codebuddy-intl": { name: "CodeBuddy Intl", login: "browser", checkin: true },
    lobsterai: { name: "LobsterAI", login: "browser", checkin: false },
    codearts: { name: "CodeArts", login: "browser", checkin: false },
    loomy: { name: "Loomy", login: "phone", checkin: false },
  }

  const LANGS = {
    en: {
      badgeOn: "registered",
      badgeOff: "not registered",
      badgeUnknown: "unknown",
      badgeForeign: "not Veyra",
      hintOwned: "Served by this plugin. Accounts and sign-in are on magpie's Providers page.",
      hintForeign:
        "This provider isn't one of Veyra's five — nothing here applies to it.",
      fModels: "models",
      fLogin: "sign-in",
      fCheckin: "check-in",
      loginBrowser: "browser",
      loginPhone: "phone code",
      on: "on",
      off: "off",
      noteUnreadable: "providers:list couldn't be read: ",
      noteNoBridge:
        "This panel only works inside magpie (it needs magpie.context to know which provider it is in).",
      refresh: "Refresh",
    },
    zh: {
      badgeOn: "已注册",
      badgeOff: "未注册",
      badgeUnknown: "未知",
      badgeForeign: "非 Veyra 渠道",
      hintOwned: "由本插件提供。账号与登录在 magpie 的 Providers 页上。",
      hintForeign: "这一行不属于 Veyra 的五家渠道，这里的内容与它无关。",
      fModels: "模型",
      fLogin: "登录",
      fCheckin: "签到",
      loginBrowser: "浏览器",
      loginPhone: "短信码",
      on: "开",
      off: "关",
      noteUnreadable: "读不到 providers:list：",
      noteNoBridge: "这个面板只在 magpie 里有效（它靠 magpie.context 知道自己在谁家）。",
      refresh: "刷新",
    },
  }

  const zh = () => /^zh/i.test(document.documentElement.lang || "") || (navigator.language || "").startsWith("zh")
  const t = () => LANGS[zh() ? "zh" : "en"]
  const text = (v) => (v === undefined || v === null ? "" : String(v))

  /** 面板高度由 magpie 按内容裁剪，改动后要重新量一次。 */
  function resize() {
    // bridge.js 自己会盯 ResizeObserver；这里只负责让内容真正变高/变矮。
    document.body.style.minHeight = "0px"
  }

  function setBadge(state, label) {
    const b = $("badge")
    b.dataset.state = state
    b.textContent = label
  }

  function fact(k, v) {
    const row = document.createElement("div")
    row.className = "fact"
    const kk = document.createElement("span")
    kk.className = "k"
    kk.textContent = k
    const vv = document.createElement("span")
    vv.className = "v"
    vv.textContent = v
    row.append(kk, vv)
    return row
  }

  function draw(pid, pname, row, err) {
    const L = t()
    const known = KNOWN[pid]
    $("who").textContent = pname || pid || "Veyra"
    $("refresh").textContent = L.refresh

    if (!known) {
      setBadge("foreign", L.badgeForeign || L.badgeUnknown)
      $("hint").textContent = L.hintForeign
      $("facts").replaceChildren()
      return
    }

    const registered = row ? true : err ? null : false
    setBadge(
      registered === null ? "off" : registered ? "ok" : "dead",
      registered === null ? L.badgeUnknown : registered ? L.badgeOn : L.badgeOff,
    )
    $("hint").textContent = L.hintOwned

    const models = row && Number.isFinite(Number(row.models)) ? String(row.models) : "—"
    const frag = document.createDocumentFragment()
    frag.append(
      fact(L.fModels, models),
      fact(L.fLogin, known.login === "phone" ? L.loginPhone : L.loginBrowser),
      fact(L.fCheckin, known.checkin ? L.on : L.off),
    )
    $("facts").replaceChildren(frag)

    const note = $("note")
    if (err) {
      note.hidden = false
      note.textContent = L.noteUnreadable + text(err)
    } else {
      note.hidden = true
      note.textContent = ""
    }
  }

  let busy = false
  async function load() {
    if (busy) return
    busy = true
    $("refresh").disabled = true
    try {
      const ctx = (magpie && magpie.context) || {}
      const pid = text(ctx.provider && ctx.provider.id)
      const pname = text(ctx.provider && ctx.provider.name) || pid

      // 没在 provider 编辑页里（例如有人直接打开本文件）：明说，而不是白屏。
      if (!magpie || typeof magpie.read !== "function") {
        setBadge("off", t().badgeUnknown)
        $("who").textContent = pname || "Veyra"
        $("hint").textContent = t().noteNoBridge
        return
      }

      let row = null
      let err = null
      try {
        const list = await magpie.read("providers:list")
        const arr = Array.isArray(list) ? list : []
        row = arr.find((p) => p && p.id === pid) || null
      } catch (e) {
        err = (e && e.message) || String(e)
      }
      draw(pid, pname, row, err)
      resize()
    } finally {
      busy = false
      $("refresh").disabled = false
    }
  }

  $("refresh").addEventListener("click", () => {
    load()
  })

  // magpie.context 是 hello 应答的一部分：等它，不要抢跑。
  if (typeof magpie !== "undefined" && magpie && magpie.ready) {
    magpie.ready.then(() => {
      load()
    })
    if (typeof magpie.onTheme === "function") {
      magpie.onTheme((next) => {
        document.documentElement.dataset.theme = next && next.dark ? "dark" : "light"
      })
    }
  } else {
    load()
  }
})()
