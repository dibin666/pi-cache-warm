<p align="center">
  <a href="README.md"><img src="docs/btn-en-off.svg" alt="English"></a>
  <a href="README.zh-CN.md"><img src="docs/btn-zh-on.svg" alt="简体中文"></a>
</p>

# pi-cache-warm

让 [pi](https://pi.dev) 的提示缓存突破内置上限持续保温,附中英双语 TUI。

<img src="docs/overview.zh.svg" alt="概览" width="100%">

## 功能

- **持续保温**:覆盖 pi 内置预热的决策,内置预热停止后由插件接管(Anthropic Messages、OpenAI Responses / Chat Completions)。
- **ask 联动**:rpiv `ask_user_question` 问答窗口等待回复时持续保温,记录中标记 `ask`。
- **预热记录**:预热、重建、停止及其费用,图表加列表,点击记录查看详情。初始化重建仅保留在原始日志中,不展示、不计入统计。
- **模型设置**:编辑 `models.json` 中的 `promptCache` 与价格;按模型开启 Claude 官方订阅(不计缓存读取费)。
- **TUI**:中文 / English,Unicode 字符图标(任何终端都能显示),支持鼠标与键盘。

<img src="docs/history.zh.svg" alt="记录" width="100%">
<img src="docs/models.zh.svg" alt="模型设置" width="100%">

## 预热限制

Anthropic Messages 接口的固定预算思考无法用很小的输出上限安全预热:`max_tokens` 必须大于 `budget_tokens`,降低预算会改变消息缓存,保留预算则可能生成大量 token。Pi 内置预热也有相同限制。

可在 `/thinking` 关闭思考后发送一条新消息。另一种方式是**确认服务端支持 adaptive thinking 后**,在 `models.json` 为该模型设置 `compat.forceAdaptiveThinking: true`,重新加载并发送新消息。插件不会自动改变思考设置。

## 安装与使用

```bash
pi install git:github.com/dibin666/pi-cache-warm
```

`/cachewarm` 打开面板:`←→` 切换页 · `↑↓` 选择 · `Enter` 修改 · `Ctrl+S` 保存 · `Esc` 关闭。
全屏模式(pi 默认)下也可以直接点击底栏的「缓存保温 · 下次 …」打开。
