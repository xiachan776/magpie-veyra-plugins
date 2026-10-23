/**
 * 五个渠道各自的 `auth.icon`：data URI 常量。
 *
 * ## 为什么必须有
 *
 * magpie 的 `internal/plugin/host.js` 里 `iconOf()` 只认两处：
 *
 * 1. `auth.icon` —— 供应商自己的图标；
 * 2. `package.json` 的 `magpie.icon` —— 插件图标，作为**兜底**。
 *
 * 不设 `auth.icon` 时，五个供应商行**全部**挂同一个 Veyra 蓝 V，用户在
 * Providers 页看到五张一模一样的卡片，只能靠文字区分 codebuddy 和 loomy。
 * 这既是可读性问题，也会让人误以为「这个插件只做了一个东西」。
 *
 * ## 分工（和根目录 icon.svg 的关系）
 *
 * | 位置 | 表达什么 | 长什么样 |
 * | --- | --- | --- |
 * | `magpie.icon`（根 `icon.svg`） | **插件自己**，发现卡片与已安装那一行 | 品牌蓝底 + 白 V + 波浪 |
 * | `auth.icon`（本文件） | **某一家渠道** | 同形状语言（圆角方块、同笔画粗细），换颜色与记号 |
 *
 * 所以五个渠道图标刻意共用一套视觉语言 —— 都是圆角方块、白色字形、
 * 各家的品牌色底 —— 但颜色和记号不同，扫一眼就能分开。
 *
 * ## 硬约束（与 magpie.icon 相同）
 *
 * - 必须以 `data:image/` 或 `https://` 开头，否则 `iconOf()` 静默丢弃；
 * - `≤ 3 << 19` 字节（1.5 MB）；
 * - 固定配色，不用 `currentColor`：它渲染在 `<img>` 里，没有继承色。
 *
 * ## 颜色来源
 *
 * 品牌色取自各厂商公开的标识色（CodeBuddy 蓝、LobsterAI 橙红、CodeArts 红、
 * Loomy 青、CodeBuddy Intl 深靛）。**不用渐变** —— 五个图标都要在 16–20 px
 * 的行内尺寸里认出来，渐变到这个尺寸只剩一片糊。
 *
 * ## 改这里要同步
 *
 * 这些字符串由 `scripts/icon.mjs` 生成到本文件（`npm run icon`）。
 * 手改本文件后跑一次 `npm run icon:check` 会失败，迫使你回去改 `icons/*.svg`
 * 的源文件 —— 单一真源是那五个 SVG，不是这里的 base64。
 */

/** CodeBuddy CN：青蓝底 + 方块记号（腾讯 CodeBuddy 主色）。 */
export const CODEBUDDY_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IkNvZGVCdWRkeSI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTUiIGZpbGw9IiMxRThGRTQiLz48cGF0aCBkPSJNMTUgMjQgTDE1IDE5IEwyMCAxOSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjQuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTIwIDQwIEwxNSA0MCBMMTUgNDUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI0LjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxwYXRoIGQ9Ik00NCAxOSBMNDkgMTkgTDQ5IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNC40IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNNDkgNDAgTDQ5IDQ1IEw0NCA0NSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjQuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PGNpcmNsZSBjeD0iMzIiIGN5PSIyNyIgcj0iMy40IiBmaWxsPSIjZmZmIi8+PHBhdGggZD0iTTMyIDMzIEwzMiA0MiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjQuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+"

/** CodeBuddy Intl：深靛底 + 同一记号，靠底色区分国内版与国际版。 */
export const CODEBUDDY_INTL_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IkNvZGVCdWRkeSBJbnRsIj48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0iIzJCM0E4RiIvPjxwYXRoIGQ9Ik0xNSAyNCBMMTUgMTkgTDIwIDE5IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNC40IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMjAgNDAgTDE1IDQwIEwxNSA0NSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjQuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTQ0IDE5IEw0OSAxOSBMNDkgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI0LjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxwYXRoIGQ9Ik00OSA0MCBMNDkgNDUgTDQ0IDQ1IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNC40IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjI3IiByPSIzLjQiIGZpbGw9IiNmZmYiLz48cGF0aCBkPSJNMzIgMzMgTDMyIDQyIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNC40IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4="

/** LobsterAI：橙红底 + 龙虾螯形折线。 */
export const LOBSTERAI_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IkxvYnN0ZXJBSSI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTUiIGZpbGw9IiNFODYyMkMiLz48cGF0aCBkPSJNMTQgMjAgQzIwIDE3IDI1IDIwIDI0IDI2IEMyMCAyOSAxNSAyNiAxNCAyMCBaIiBmaWxsPSIjZmZmIi8+PHBhdGggZD0iTTUwIDIwIEM0NCAxNyAzOSAyMCA0MCAyNiBDNDQgMjkgNDkgMjYgNTAgMjAgWiIgZmlsbD0iI2ZmZiIvPjxyZWN0IHg9IjI2IiB5PSIyMiIgd2lkdGg9IjEyIiBoZWlnaHQ9IjE2IiByeD0iNiIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik0yOCA0MiBMMzYgNDIiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIzLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxwYXRoIGQ9Ik0yOSA0NyBMMzUgNDciIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIzLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxwYXRoIGQ9Ik0zMSA1MiBMMzMgNTIiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIzLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg=="

/** CodeArts（华为云）：正红底 + 尖括号。 */
export const CODEARTS_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IkNvZGVBcnRzIj48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0iI0M3MDAwQiIvPjxwYXRoIGQ9Ik0yNCAyMCBMMTQgMzIgTDI0IDQ0IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNC42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48cGF0aCBkPSJNNDAgMjAgTDUwIDMyIEw0MCA0NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjQuNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PHBhdGggZD0iTTMyIDE4IEwzMiA0NiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjQuNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+"

/** Loomy（讯飞）：青绿底 + 同心弧。 */
export const LOOMY_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByb2xlPSJpbWciIGFyaWEtbGFiZWw9Ikxvb215Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0iIzBGQTNBMyIvPjxwYXRoIGQ9Ik0xOCA0MCBDMTggMzAgMjQgMjQgMzIgMjQgQzQwIDI0IDQ2IDMwIDQ2IDQwIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNC40IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMjQgNDQgQzI0IDM4IDI3IDM0IDMyIDM0IEMzNyAzNCA0MCAzOCA0MCA0NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjQuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBvcGFjaXR5PSIwLjc1Ii8+PGNpcmNsZSBjeD0iMzIiIGN5PSIyMCIgcj0iMy42IiBmaWxsPSIjZmZmIi8+PC9zdmc+"

/**
 * provider id → 图标。供测试核对「每个导出的 provider 都有 icon」，
 * 也供 `scripts/icon.mjs` 决定每个图标该写回哪个常量。
 */
export const PROVIDER_ICONS = {
  codebuddy: "CODEBUDDY_ICON",
  "codebuddy-intl": "CODEBUDDY_INTL_ICON",
  lobsterai: "LOBSTERAI_ICON",
  codearts: "CODEARTS_ICON",
  loomy: "LOOMY_ICON",
}
