<p align="center">
  <a href="README.md"><img src="docs/btn-en-off.svg" alt="English"></a>
  <a href="README.zh-CN.md"><img src="docs/btn-zh-on.svg" alt="简体中文"></a>
</p>

# pi-cache-warm

让 [pi](https://pi.dev) 的提示缓存突破内置上限持续保温,附中英双语 TUI。

<img src="docs/overview.zh.svg" alt="概览" width="100%">

## 功能

- **持续保温**:覆盖 pi 内置预热的决策,内置预热停止后由插件接管(Anthropic Messages、OpenAI Responses / Chat Completions)。
- **按模型强制保温**:显式开启后保留固定思考预算与原会话前缀,收到流式缓存用量即断流。
- **ask 联动**:rpiv `ask_user_question` 问答窗口等待回复时持续保温,记录中标记 `ask`。
- **预热记录**:预热、重建、停止及其费用,图表加列表,点击记录查看详情。初始化重建仅保留在原始日志中,不展示、不计入统计。
- **模型设置**:编辑 `models.json` 中的 `promptCache` 与价格;按模型开启 Claude 官方订阅(不计缓存读取费)。
- **TUI**:中文 / English,Unicode 字符图标(任何终端都能显示),支持鼠标与键盘。

<img src="docs/history.zh.svg" alt="记录" width="100%">
<img src="docs/models.zh.svg" alt="模型设置" width="100%">

## 预热限制

Anthropic Messages 接口的固定预算思考无法用很小的输出上限安全预热:`max_tokens` 必须大于 `budget_tokens`,降低预算会改变消息缓存,保留预算则可能生成大量 token。Pi 内置预热也有相同限制。

### 强制会话缓存保温(默认关闭)

在 `/cachewarm models` 的模型设置中开启「强制保温」并 Ctrl+S 保存,或对当前 Anthropic Messages 模型运行 `/cachewarm force on`。同时会开启该模型的普通保温;`/cachewarm force off` 只关闭强制模式。仍需配置缓存时长,并捕获一次带输入用量的真实请求。

固定预算思考下,强制模式携带**原始工具、系统提示、消息、缓存标记、思考预算、输出上限及会话请求头**,不是独立的 `ping`。使用流式请求,收到 `message_start` 缓存用量就立即中断。仅当读取缓存达到重放输入与原请求输入的至少 90% 时确认成功;缓存寿命从请求开始计时。心跳 `ping` 与 HTTP 200 均不代表续期。缺少用量、仅部分前缀命中、非流式响应、错误或超过 30 秒会停止自动强制保温,不反复付费重试。总开关、模型开关、最长保温限制仍有效;强制模型跳过收益判断。

**提前断流不保证网关会立即停止生成或计费。**记录标记「强制」「部分用量」,展示的用量与费用仅来自首包,最终计费可能更高。缓存命中仅能确认服务端使用了该前缀,第三方网关是否遵守声明的缓存寿命仍取决于服务端。生成内容不会进入会话或执行工具。

不使用强制模式时,可在 `/thinking` 关闭思考后发送新消息;或**确认服务端支持 adaptive thinking 后**,在 `models.json` 设置 `compat.forceAdaptiveThinking: true`,重新加载并发送新消息。插件不会自动改变思考设置。

参考:[Anthropic 提示缓存文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。

## 安装与使用

```bash
pi install git:github.com/dibin666/pi-cache-warm
```

`/cachewarm` 打开面板:`←→` 切换页 · `↑↓` 选择 · `Enter` 修改 · `Ctrl+S` 保存 · `Esc` 关闭。
全屏模式(pi 默认)下也可以直接点击底栏的「缓存保温 · 下次 …」打开。
