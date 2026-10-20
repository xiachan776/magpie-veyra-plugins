# magpie-veyra-auth

给 [magpie](https://github.com/yetone/magpie) 用的 provider 插件，覆盖 **Veyra 已经能登录、而 magpie 本身还没有 provider** 的五家订阅。

| provider id | 厂商 | 网关 base | 登录方式 | 自动签到 |
| --- | --- | --- | --- | --- |
| `codebuddy` | 腾讯 CodeBuddy（国内，copilot.tencent.com） | `https://copilot.tencent.com/v2` | 浏览器轮询 | ✅ |
| `codebuddy-intl` | 腾讯 CodeBuddy（国际版，www.codebuddy.ai） | `https://www.codebuddy.ai/v2` | 浏览器轮询 | ✅ |
| `lobsterai` | 有道 LobsterAI | `https://lobsterai-server.youdao.com/api/proxy/v1` | 浏览器回调 | ✅ |
| `codearts` | 华为云 CodeArts（snap-access） | `https://snap-access.cn-north-4.myhuaweicloud.com/api/v2` | 浏览器 OAuth（PKCE + DPoP） | ✅ |
| `loomy` | 讯飞 Loomy | `https://loomyad.xunfei.cn/api/v1` | 手机短信验证码 | ✅ |

不在表里的那几家（cline / raccoon / trae / qoder / zcode / workbuddy / opencode-zen …）已经由 [`magpie-community/plugins`](https://github.com/magpie-community/plugins) 提供，本插件**刻意不重复实现**，否则同一个 provider id 会有两个插件抢登录（宿主按 `plugins.json` 的 `prefer` 裁决，用户会莫名其妙看到两家都要登录）。

## 安装

```sh
magpie plugin add github:xiachan776/magpie-veyra-plugins
# 或者本地调试：
magpie plugin add D:\path\to\magpie-veyra-plugins
```

装完在 magpie 的 **Providers** 页会多出五行；点进去用各自的方式登录，多账号就是多登几次（magpie 原生账号池，账号存在 `plugin-auth.json`，同一 provider 下多个 key）。

## 每家实现了什么

一个 provider 插件在 magpie 里能挂的钩子就那几个，本包用到的是：

- `config` —— 往 `config.provider[id]` 填 `npm` / `api` / `models` 兜底表。
- `provider.models` —— 登录后拉**远端真实模型目录**（每家一个端点），失败或空列表一律回退 `config` 里的兜底表，绝不把 Providers 页清空。
- `auth` —— `provider`（决定这个 provider id 归谁）、`methods`（登录方式）、`loader`（每个请求的改写点）、`refresh` + `refreshLead`（静默续期）、`usage`（积分/额度窗口）、`checkin`（每日签到）。
- `loader().fetch` —— 最强改写点：拿到最终 URL 和已装配的 `Headers`，可以重写鉴权头、改 body、甚至直接返回自制 `Response`。华为云的 SDK-HMAC-SHA256 签名、讯飞的 `account {ak}:{sig}` 签名、腾讯系的归属头全部在这里落地。

各家协议细节（都已在源码注释里写明出处与实测结论）：

- **CodeBuddy / CodeBuddy Intl**：腾讯同一套 `external-link` 轮询登录；对话走 `/v2/chat/completions`，必须带 `X-Domain` / `X-Product` / `X-Product-Code` / `X-Agent-Purpose` / `X-IDE-*` 一串归属头，少一个就可能被后台归因失败或 400。三枚 `X-Conversation-*` 头**按账号**才必需（不校验值语义，但填空串会 400），所以无条件发。
- **LobsterAI**：`stream` 恒 `true`（传 `false` 上游 500），不支持 `tool_choice`、不支持图片；登录是本地回调 `?code=` 后立刻换 token。
- **CodeArts**：华为云 **SDK-HMAC-SHA256** 逐请求签名（`Content-MD5`/`Date`/`Nonce` 那套），登录是 IAM OAuth + PKCE + DPoP（ES256）。签名有两个坑：`Agent-Type`/`X-Language` 这类头**必须在签名之后追加**，进了 canonical request 会回 `APIG.0301 verify ak sk signature fail`；refresh_token 的 `exp` 恒为登录日 +30 天、续期不延长，所以续期判定要同时看 access 过期和 refresh 死线。
- **Loomy**：讯飞 CAccount **HMAC-SHA1** 签名（待签串 9 段，最后两段恒空 ⇒ 以 `\n\n` 结尾）；业务失败恒返回 HTTP 200，只能读 body 的 `code`；`/chat/completions` 只认 `Authorization: Bearer`，`/models` 和 `/points/*` 只认 `token`，两个头都发才不会撞 `100002 缺少 token`；**没有 refresh 端点**，登录声明的 14 天到期就得重登。

## 与 Veyra 的关系

代码不是从 Veyra 复制来的 —— Veyra 是 DSH 插件（`registerProviderRuntime` 那套），magpie 插件是 OpenCode 的 `{config, provider, auth}` 形状，两者形状不通。本仓库复刻的是**协议**：端点、请求头、签名算法、模型目录、兜底模型表、积分与签到端点，逐条对照 Veyra 的 `src/` 实现。

`.github/workflows/upstream-drift.yml` 每天比对一次 Veyra 仓库里那些协议源文件的哈希，变了就开 issue —— 只报警，不改代码、不自动合并。

## 开发

```sh
node --test          # 22 个测试，宿主契约 + 五个插件的形状
```

测试是按宿主的方式真调工厂函数（复刻 `internal/plugin/host.js` 的 `loadPlugins` input 形状），锁住四件容易静默失效的事：`hooks.auth.provider` 必须等于 provider id、`config` 写出的模型条目必须能被宿主读成目录、未登录时 `loader` 返回 `{}` 而不是抛错、`usage` 未登录必须说没登录并打 `signIn: "kept"`。

## License

MIT
