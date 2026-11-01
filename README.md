<p align="center">
  <a href="README.md"><img src="docs/btn-en-on.svg" alt="English"></a>
  <a href="README.zh-CN.md"><img src="docs/btn-zh-off.svg" alt="简体中文"></a>
</p>

# pi-cache-warm

Keeps [pi](https://pi.dev)'s prompt cache warm beyond its built-in limits, with a bilingual TUI.

<img src="docs/overview.en.svg" alt="Overview" width="100%">

## Features

- **Keep warm** – overrides pi's built-in warming decisions and takes over when it stops (Anthropic Messages, OpenAI Responses / Chat Completions).
- **Per-model forced warming** – opt in to replaying a fixed thinking budget and cancelling the stream after initial cache usage, without changing the cached prefix.
- **Ask-aware** – keeps warming while an rpiv `ask_user_question` dialog waits for you; tagged `ask` in history.
- **History** – warms, rebuilds and stops with their costs, as a chart and a list; click a record for details. Initialization rebuilds stay in the raw log but are excluded from the views and statistics.
- **Model settings** – edit pi's `promptCache` and prices in `models.json`; per-model Claude subscription switch (cache reads not billed).
- **TUI** – English / 中文, plain-text Unicode icons that work in any terminal, mouse and keyboard.

<img src="docs/history.en.svg" alt="History" width="100%">
<img src="docs/models.en.svg" alt="Model settings" width="100%">

## Warming limits

Fixed-budget thinking on the Anthropic Messages API cannot be safely replayed with a tiny output cap: `max_tokens` must exceed `budget_tokens`, changing the budget changes the message cache, and keeping it may generate many tokens. Pi's built-in warmer has the same restriction.

### Forced session-cache warming (opt-in)

Enable **Force warming** in a model's settings (`/cachewarm models`), then save with Ctrl+S; or run `/cachewarm force on` for the current Anthropic Messages model. This also enables normal keep-warm for that model. `/cachewarm force off` disables only forced mode. A known cache lifetime and a captured real request with input usage are still required.

For fixed-budget thinking, forced mode sends the **original tools, system, messages, cache markers, thinking budget, output limit and session headers**, not a standalone `ping`. It requests a stream and aborts it as soon as `message_start` reports cache usage. It only reports success when cache reads cover at least 90% of both the replay input and the captured real-request input. Cache TTL is measured from request start. Heartbeat `ping` events and HTTP 200 alone never count as a refresh. Missing usage, partial-prefix hits, non-streaming responses, errors or a 30-second timeout stop automatic forced warming rather than repeatedly spending money. The normal max keep-warm limit and master/model switches still apply; forced models skip the savings check.

**Early cancellation does not guarantee that a proxy stops generation or billing.** History marks these attempts as forced and partial; displayed usage/cost only reflect the initial report and may be lower than final charges. A cache hit confirms that the provider used that prefix; a third-party gateway may not honor the declared TTL. No generated output is added to the conversation or executed as tools.

Without forced mode, turn thinking off with `/thinking` and send a new message, or set `compat.forceAdaptiveThinking: true` **only if the endpoint is confirmed to support it**, then reload and send a new message. The extension never changes thinking settings automatically.

Reference: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Install & use

```bash
pi install git:github.com/dibin666/pi-cache-warm
```

`/cachewarm` opens the panel: `←→` tabs · `↑↓` select · `Enter` change · `Ctrl+S` save · `Esc` close.
In fullscreen mode (pi's default) you can also click the `cache warm · next …` status in the footer.
