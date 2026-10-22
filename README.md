# magpie-veyra-auth

给 [magpie](https://github.com/yetone/magpie) 用的 provider 插件，覆盖 **Veyra 已经能登录、而 magpie 本身还没有 provider** 的五家订阅。

| provider id | 厂商 | 网关 base | 登录方式 | 自动签到 |
| --- | --- | --- | --- | --- |
| `codebuddy` | 腾讯 CodeBuddy（国内，copilot.tencent.com） | `https://copilot.tencent.com/v2` | 浏览器轮询 | ✅ |
| `codebuddy-intl` | 腾讯 CodeBuddy（国际版，www.codebuddy.ai） | `https://www.codebuddy.ai/v2` | 浏览器轮询 | — |
| `lobsterai` | 有道 LobsterAI | `https://lobsterai-server.youdao.com/api/proxy/v1` | 浏览器回调 | ✅ |
| `codearts` | 华为云 CodeArts（snap-access） | `https://snap-access.cn-north-4.myhuaweicloud.com/api/v2` | 浏览器 OAuth（PKCE + DPoP） | ✅ |
| `loomy` | 讯飞 Loomy | `https://loomyad.xunfei.cn/api/v1` | 手机短信验证码 | ✅ |

不在表里的那几家（cline / raccoon / trae / qoder / zcode / workbuddy / opencode-zen …）已经由 [`magpie-community/plugins`](https://github.com/magpie-community/plugins) 提供，本插件**刻意不重复实现**，否则同一个 provider id 会有两个插件抢登录（宿主按 `plugins.json` 的 `prefer` 裁决，用户会莫名其妙看到两家都要登录）。

`codebuddy-intl` 没有签到：签到活动只在腾讯国内站点挂着，国际版调同一个端点回的是「活动不存在」。

## 安装

```sh
magpie plugin add github:xiachan776/magpie-veyra-plugins
# 或者本地调试：
magpie plugin add D:\path\to\magpie-veyra-plugins
```

装完在 magpie 的 **Providers** 页会多出五行（卡片上有本包的图标，颜色是插件自带的 `magpie.icon` data URI，不联网拉图）；点进去用各自的方式登录，多账号就是多登几次（magpie 原生账号池，账号存在 `plugin-auth.json`，同一 provider 下多个 key）。

## 自动签到

签到不是本插件自己发明的机制，而是 magpie 的 `auth.checkin` 钩子（`magpie ≥ v0.1.1083`）：插件替厂商按签到，magpie 按它自己的方式跑 —— 每个账号每个北京日一次，开着的才跑，失败当天稍后再试一次。

**开关**在 Usage 页的 Plugins 区块里（每个 provider 一行），也可以用命令：

```sh
magpie accounts checkin          # 现在就签一遍（含本包四家）
magpie accounts checkin --json   # 同上，机器可读
```

第三方插件默认是**关**的（`PluginCheckinOn()` 对一个没设过的 id 回 `false`），装完记得打开。

结果会显示成 `Checked in today +320 · 7-day streak` 这种样子。四家能做到的程度不一样，如实说明：

| provider | 签到端点 | `credit` | `streak` |
| --- | --- | --- | --- |
| `codebuddy` | `checkin-activity-status` 查状态 → `daily-checkin` 领取 | 领取响应里的 `credit` | **能拿到** `streak_days`（只要远端给） |
| `lobsterai` | 查槽位 → 查上下文 → `actions/check_in`，**领完再复核一次** | `creditsGranted` / `rewardCredits` / `credits` 三级回退 | 远端没有这个概念，不填 |
| `codearts` | `/v1/ops/delivery` 找 `DAILY_LOGIN` 活动 → `claim` → `confirm` | `benefitAmount` 等六字段回退 | 不填 |
| `loomy` | `POST /points/first-login`（**触发每日额度重置**，不是「+5000 积分」） | `dailyQuota - dailyConsumed` | 不填 |

几条来自实测的判据：

- CodeBuddy 必须查 `checkin-activity-status`，不能用 `checkin-status` —— 后者返回占位数据（`active:false`、`checkin_dates:null`），会让人误判成「活动没开」。
- CodeBuddy 的业务码要分清楚：`10001`/`1001` 是「今天已领」→ `done`；`1002`（无资格）/`1003`（活动结束）→ `inactive`；别的一律 `failed`。
- LobsterAI 的领取接口可能回 200 但什么都没发（幂等命中、活动刚改配置）。所以领完**再拉一次 context 复核**，只有 `claimedToday` 真的变成 `true` 才算 `claimed`（这个做法抄自 [`L0NE-6/LobsterAI-AutoCheckin`](https://github.com/L0NE-6/LobsterAI-AutoCheckin)）。复核请求本身失败不算签到失败，退回领取接口的结果。
- Loomy 重复调用回同样 HTTP 200，判据是响应体的 `alreadyProcessed`，重复处理映射成 `done` 而不是 `claimed` —— 否则用户会以为每天都在真的加额度。
- 签到有代价的渠道（不是所有厂商都白送）本插件一律不做：只按各厂商官方客户端会按的那几下。

## 给 agent 用的工具

插件页被 magpie 沙箱钉死（`connect-src 'none'`，`magpie.permissions` 只认 `providers:list` 与 `usage:summary`），页面读不到账号列表、额度明细、签到实况，也发不出任何网络请求。要读本地账号库，得走另一条通道：**tool 钩子**（经 magpie 的 plugin-tools MCP server 暴露给每个 agent，跑在宿主进程里）。

本包第六个导出 `VeyraToolsPlugin` 只挂工具、不注册 provider，所以它不会出现在 Providers 页，也不会和上面五家抢 id。提供 `veyra_accounts`：

| action | 做什么 | 联网 |
| --- | --- | --- |
| `list` | 列出本包五家的账号：key、账号 id、到期时间、**今日签到结果**（含 credit 与 streak） | 否 |
| `import` | 把 Veyra（`~/.dsh`）里的五家账号搬进 `plugin-auth.json`；幂等，`dryRun: true` 只报告不写盘 | 否 |
| `export` | 把本包账号导成能直接贴进 Veyra 的 `refs` 行与 `accounts[]` 条目 | 否 |

刻意**没有**「立即签到」这个 action：magpie 自己已经有三个入口（`magpie accounts checkin`、Usage 页的手动按钮、`KeepPluginsCheckedIn` 的每小时循环），再包一层只会让「这号是谁签的」有两个说法。

## 与 Veyra 互通

两边都登录同一批订阅时，不需要重新扫码。`veyra_accounts` 的 `import` 会读 Veyra 的 `.credentials.yaml` 与 `veyra/state.json`，把本包负责的五家转成 magpie 的账号写进 `plugin-auth.json`：同 `accountId` 或同凭据即视为**已在库**，不重复添加，也不动 Veyra 的任何文件（它自己是单一副本，抓一次不影响它继续用）。

反方向 `export` **只产出清单，不写 Veyra 的文件** —— Veyra 也持有一份内存/磁盘状态，外部悄悄改它的 `state.json` 与 `.credentials.yaml`，它下次保存就会把改动覆盖掉。所以导出的是「可以贴进去的 `refs` 行 + 账号条目」，贴不贴由人决定，这也符合「备份导出」的字面意思。

`refs` 的键照 Veyra 自己的形状：`BUDDY_ACCOUNT_<8 位大写 hex>`、`BUDDY_INTL_…`、`LOBSTERAI_…`、`LOOMY_…`。CodeArts 那三家在 Veyra 侧引用的凭据本体已经不在 `.credentials.yaml` 里（`CODEARTS_ACCOUNT_*` 全部找不到对应值），所以它们只会被报成「需重新登录」，不会被硬塞进 magpie。

## 每家实现了什么

一个 provider 插件在 magpie 里能挂的钩子就那几个，本包用到的是：

- `config` —— 往 `config.provider[id]` 填 `npm` / `api` / `models` 兜底表。
- `provider.models` —— 登录后拉**远端真实模型目录**（每家一个端点），失败或空列表一律回退 `config` 里的兜底表，绝不把 Providers 页清空。
- `auth` —— `provider`（决定这个 provider id 归谁）、`methods`（登录方式）、`loader`（每个请求的改写点）、`refresh` + `refreshLead`（静默续期）、`usage`（积分/额度窗口）、`checkin`（每日签到）。
- `loader().fetch` —— 最强改写点：拿到最终 URL 和已装配的 `Headers`，可以重写鉴权头、改 body、甚至直接返回自制 `Response`。华为云的 SDK-HMAC-SHA256 签名、讯飞的 `account {ak}:{sig}` 签名、腾讯系的归属头全部在这里落地。
- `tool` —— 见上一节，只由第六个导出挂着。

各家协议细节（都已在源码注释里写明出处与实测结论）：

- **CodeBuddy / CodeBuddy Intl**：腾讯同一套 `external-link` 轮询登录；对话走 `/v2/chat/completions`，必须带 `X-Domain` / `X-Product` / `X-Product-Code` / `X-Agent-Purpose` / `X-IDE-*` 一串归属头，少一个就可能被后台归因失败或 400。三枚 `X-Conversation-*` 头**按账号**才必需（不校验值语义，但填空串会 400），所以无条件发。
- **LobsterAI**：`stream` 恒 `true`（传 `false` 上游 500），不支持 `tool_choice`、不支持图片；登录是本地回调 `?code=` 后立刻换 token。凭据是一整份 JSON 压在 `access` 字段里。
- **CodeArts**：华为云 **SDK-HMAC-SHA256** 逐请求签名（`Content-MD5`/`Date`/`Nonce` 那套），登录是 IAM OAuth + PKCE + DPoP（ES256）。签名有两个坑：`Agent-Type`/`X-Language` 这类头**必须在签名之后追加**，进了 canonical request 会回 `APIG.0301 verify ak sk signature fail`；refresh_token 的 `exp` 恒为登录日 +30 天、续期不延长，所以续期判定要同时看 access 过期和 refresh 死线。
- **Loomy**：讯飞 CAccount **HMAC-SHA1** 签名（待签串 9 段，最后两段恒空 ⇒ 以 `\n\n` 结尾）；业务失败恒返回 HTTP 200，只能读 body 的 `code`；`/chat/completions` 只认 `Authorization: Bearer`，`/models` 和 `/points/*` 只认 `token`，两个头都发才不会撞 `100002 缺少 token`；**没有 refresh 端点**，登录声明的 14 天到期就得重登。

## 与 Veyra 的关系

代码不是从 Veyra 复制来的 —— Veyra 是 DSH 插件（`registerProviderRuntime` 那套），magpie 插件是 OpenCode 的 `{config, provider, auth}` 形状，两者形状不通。本仓库复刻的是**协议**：端点、请求头、签名算法、模型目录、兜底模型表、积分与签到端点，逐条对照 Veyra 的 `src/` 实现。

`.github/workflows/upstream-drift.yml` 每天比对一次 Veyra 仓库里那些协议源文件的哈希，变了就开 issue —— 只报警，不改代码、不自动合并。

## 开发

```sh
node --test      # 36 个测试，宿主契约 + 五个插座 + 工具
node scripts/icon.mjs          # icon.svg → package.json 的 magpie.icon（data URI）
node scripts/icon.mjs --check  # 只校验是否同步
```

测试是按宿主的方式真调工厂函数（复刻 `internal/plugin/host.js` 的 `loadPlugins` input 形状），锁住几件容易静默失效的事：

- `hooks.auth.provider` 必须等于 provider id —— 缺了它插件照样加载成功，只是 Providers 页永远不多出一行，且没有任何错误；
- `config` 写出的模型条目必须能被宿主读成目录，`variants` 的键必须是 magpie 认的档位名（`none`…`ultra`），写错会被原样透传成客户端不认识的档位；
- 未登录时 `loader` 返回 `{}` 而不是抛错；`usage` 必须说没登录并打 `signIn: "kept"`，不打会让 magpie 把账号标成过期；
- `auth.checkin` 只许报宿主认的六个 outcome（`claimed` / `done` / `ineligible` / `inactive` / `captcha` / `failed`），其它值会被降级成 `failed` 并附一句「the plugin answered no outcome」；
- 第六个导出不能有 `auth` 钩子（有的话会抢五家的 provider id）；
- 工具的 `args` 是纯 JSON Schema，而宿主对 JSON Schema **不做**参数校验，所以参数检查必须在 `execute` 里自己做。

## License

MIT
