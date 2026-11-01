<p align="center">
  <a href="README.md"><img src="docs/btn-en-on.svg" alt="English"></a>
  <a href="README.zh-CN.md"><img src="docs/btn-zh-off.svg" alt="简体中文"></a>
</p>

# pi-cache-warm

Keeps [pi](https://pi.dev)'s prompt cache warm beyond its built-in limits, with a bilingual TUI.

<img src="docs/overview.en.svg" alt="Overview" width="100%">

## Features

- **Keep warm** – overrides pi's built-in warming decisions and takes over when it stops (Anthropic Messages, OpenAI Responses / Chat Completions).
- **Ask-aware** – keeps warming while an rpiv `ask_user_question` dialog waits for you; tagged `ask` in history.
- **History** – warms, rebuilds and stops with their costs, as a chart and a list; click a record for details. Initialization rebuilds stay in the raw log but are excluded from the views and statistics.
- **Model settings** – edit pi's `promptCache` and prices in `models.json`; per-model Claude subscription switch (cache reads not billed).
- **TUI** – English / 中文, plain-text Unicode icons that work in any terminal, mouse and keyboard.

<img src="docs/history.en.svg" alt="History" width="100%">
<img src="docs/models.en.svg" alt="Model settings" width="100%">

## Warming limits

Fixed-budget thinking on the Anthropic Messages API cannot be safely replayed with a tiny output cap: `max_tokens` must exceed `budget_tokens`, changing the budget changes the message cache, and keeping it may generate many tokens. Pi's built-in warmer has the same restriction.

To warm such a model, turn thinking off with `/thinking` and send a new message. Alternatively, set `compat.forceAdaptiveThinking: true` for the model in `models.json` **only if the endpoint is confirmed to support adaptive thinking**; reload and send a new message. The extension never changes thinking settings automatically.

## Install & use

```bash
pi install git:github.com/dibin666/pi-cache-warm
```

`/cachewarm` opens the panel: `←→` tabs · `↑↓` select · `Enter` change · `Ctrl+S` save · `Esc` close.
In fullscreen mode (pi's default) you can also click the `cache warm · next …` status in the footer.
