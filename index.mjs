/**
 * magpie-veyra-auth —— magpie 缺的那几家，一家一个 provider。
 *
 * ## 为什么是这五家
 *
 * 覆盖范围刻意**只做 magpie 自己的空白**（`magpie-community/plugins` 里已有
 * cline / trae / qoder / zcode / workbuddy / raccoon / opencode / zen-free 等的
 * 认证插件），重复实现只会让同一个 provider id 有两个插件抢着签名：
 *
 * | 本包导出 | provider id | 厂商 | 为什么不能靠社区插件 |
 * | --- | --- | --- | --- |
 * | `CodeBuddyPlugin` | `codebuddy` | 腾讯 CodeBuddy（copilot.tencent.com） | 社区 `workbuddy` 插件只覆盖 workbuddy 与 workbuddy-ai，没有 codebuddy 这个 id |
 * | `CodeBuddyIntlPlugin` | `codebuddy-intl` | 腾讯 CodeBuddy 国际版（www.codebuddy.ai） | 同上，另一套端点与模型表 |
 * | `LobsterAIPlugin` | `lobsterai` | 有道 LobsterAI | magpie 里 grep 不到任何 lobster |
 * | `CodeArtsPlugin` | `codearts` | 华为云 CodeArts | magpie 里只有一句无关注释 |
 * | `LoomyPlugin` | `loomy` | 讯飞 Loomy | 全空白 |
 *
 * ## 装法
 *
 * ```bash
 * magpie plugin add /path/to/magpie-veyra-auth     # 本地目录
 * magpie plugin add <npm 包名>                      # 发布之后
 * ```
 *
 * 装完在 Providers 页逐个登录。`codebuddy` / `codebuddy-intl` 走浏览器轮询，
 * `lobsterai` / `codearts` 开本地回调服务器，`loomy` 是短信验证码。
 *
 * ⚠️ **一个模块只能导出一个工厂函数的说法是错的**：`host.js` 的 `servers()`
 * 会把每个导出函数都当工厂调用一次（`for (const fn of fns) hooks.push(...)`），
 * 所以这里五个导出 = 五次加载、五个 provider。代价是每个工厂都会拿到同一份
 * `config`，故各插件只碰自己那一个 `config.provider[id]`，绝不遍历改写别人。
 */

export { CodeBuddyPlugin, CodeBuddyIntlPlugin } from "./src/codebuddy.mjs"
export { default as LobsterAIPlugin } from "./src/lobsterai.mjs"
export { default as CodeArtsPlugin } from "./src/codearts.mjs"
export { default as LoomyPlugin } from "./src/loomy.mjs"

/**
 * 第六个导出：**只挂工具，不注册 provider**。
 *
 * 插件页被沙箱钉死（`connect-src 'none'`，`PageReads` 只有 `providers:list` 与
 * `usage:summary`），读不到账号与签到实况，也发不出请求。tool 钩子经 magpie 的
 * plugin-tools MCP server 暴露给每个 agent，跑在宿主进程里，能自由读盘 —— 这是把
 * 「列账号 / 与 Veyra 互通」交出去的唯一通道。它的 `auth` 不存在，所以不会出现在
 * Providers 页，也不会和上面五家抢 provider id。
 */
export { VeyraToolsPlugin } from "./src/tool.mjs"

/**
 * 版本号：`package.json` 是唯一真源，这里只做一次导出方便自检。
 *
 * ⚠️ 不在运行时读 `package.json` —— 插件是被 magpie 从 node_modules 里 import
 * 的，`fs` 读相对路径依赖 `import.meta.url` 的解析方式，Bun 下与 Node 下对
 * 打包目录的处置不同，读失败会让整个插件加载失败（代价远大于收益）。
 */
export const VERSION = "0.2.3"
