# hermes-token-stats

Hermes Desktop plugin: statusbar chip + pane for per-session token usage.

**Private repo — personal setup for [AndiAtom](https://github.com/AndiAtom).**

## Features

**Statusbar chip** (live readout of the focused session):
- 🪙 **Tokens** — session lifetime total (input/cached/output in tooltip)
- ⚡ **Cache** — prompt-cache hit rate (from `cache_read` / prompt tokens)
- 📊 **Context** — context window fill % (amber ≥75%, red ≥90%), merged from
  `session.context_breakdown` RPC so resumed sessions show a value too
- 💰 **Cost** — client-side EUR estimate (USD table × 0.85), 2 decimals;
  `null` (no display) for unpriced models — never a fabricated number
- 🔁 **API-Calls** — lifetime provider request count

Every metric is toggleable via a click menu on the chip (popover, ●/○ state);
the selection persists via `ctx.storage` (`hermes.plugin.token-stats.chipShow`)
across app restarts. At least one metric stays visible — hiding all is blocked.

**Pane** (`panes` area): table of all recent sessions with per-session token
counts, cache read, context fill and totals, plus a grand aggregate summary.
Seeded from `session.info` events, kept live via `session.usage` /
`message.complete`.

**Drag-resizable columns (v3.9)**: grab the right edge of any header cell
(except the last) and drag — the neighbor column gives/takes the space, widths
are percentage-based (sum always 100%, min 5% per column), and the aggregate
summary row stays column-aligned. Your widths persist across app restarts via
`ctx.storage` (`hermes.plugin.token-stats.colWidths`).

![Pane example with persistent history, aggregate summary and focused-session highlight](docs/pane-example.png)

*Example rendering with sample data — focused session highlighted with the
accent left border, `●` marks a live-only session, `≈` on the total indicates
unpriced rows excluded, `—` marks missing values (unpriced model / no cache).*

## Install

**Requires the companion gateway module**
[hermes-usage-history-rpc](https://github.com/AndiAtom/hermes-usage-history-rpc):
the pane's persistent history (sessions from other clients, pre-restart
sessions, the aggregate summary) is fed by the custom `usage.history` /
`usage.totals` JSON-RPC methods that module adds to the gateway. Without it
the plugin runs, but the pane degrades to live-only sessions (marked
`live only`) and the chip shows no DB fallback for old sessions. Install it
FIRST on the machine running the gateway/dashboard service, then:

```bash
mkdir -p ~/.hermes/desktop-plugins/token-stats
cp plugin.js ~/.hermes/desktop-plugins/token-stats/plugin.js
```

Then in the app: ⌘K → **Reload desktop plugins**.

> The app loads plugins from ITS OWN disk — editing a copy on a remote gateway
> host does nothing for a desktop running on another machine.

## Pricing table

`cost_usd` never arrives from the gateway for `custom:` providers
(`billing_mode=unknown`, `estimated_cost_usd` stays 0.0), so the plugin prices
locally in a labeled `PRICES` map (USD per 1M tokens). Full coverage of all
token-billed models on La Plateforme, cross-checked against the live
`/v1/models` API (53 models, 2026-09-19):

| Family | Model | Input | Cached | Output |
|---|---|---|---|---|
| Premier | Mistral Large 3 (`mistral-large-latest`) | 0.50 | 0.05 | 1.50 |
| | Mistral Medium 3.5 (`mistral-medium-latest`) | 1.50 | 0.15 | 7.50 |
| | Mistral Small 4 (`mistral-small-latest`) | 0.15 | 0.015 | 0.60 |
| Edge | Ministral 3 14B / 8B / 3B (`ministral-*-latest`) | 0.20 / 0.15 / 0.10 | 10% of input | = input |
| Code | Codestral (`codestral-latest`) + `mistral-code-*` / `mistral-vibe-cli-*` | 0.30 | 0.03 | 0.90 |
| Reasoning | Magistral Medium (`magistral-medium-latest`)¹ | 2.00 | 0.20 | 5.00 |
| | Magistral Small (`magistral-small-latest`)¹ | 0.50 | 0.05 | 1.50 |
| Audio | Voxtral Small (`voxtral-small-latest`)¹ | 0.10 | 0.01 | 0.30 |
| Third-party | Z.ai GLM 5.3 / 5.2 (`zai-glm-latest`) | 1.40 | 0.14 | 4.40 |
| Embeddings | Codestral Embed / Mistral Embed | 0.15 / 0.10 | 10% of input | — (input-only) |
| Free | Leanstral 1.5, Mistral Moderation 2 | 0.00 | 0.00 | 0.00 |

Fixed-version API aliases (e.g. `mistral-medium-2604`, `ministral-8b-2512`,
`codestral-2508`, `zai-glm-5-3`) are priced identically to their `-latest`
aliases — 39 entries total in `PRICES`.

¹ *Magistral is deprecated on the API (replacements: Medium 3.5 / Small 4) —
legacy list prices, no longer on the official page. Voxtral Small likewise
removed from the page; last verified list price (Sep 2026).*

**Not priced** (non-token billing, `estimateCost()` → `null` → pane shows `—`):
Voxtral Mini Transcribe ($/min), Voxtral TTS ($/M chars), Mistral OCR ($/1000
pages). Devstral was fully retired from the API and is absent.

Verified against <https://docs.mistral.ai/inference/pricing> (2026-09-19).
The gateway's `input` already **excludes** cached tokens
(`input = prompt_total − cache_read − cache_write`), so the estimate is
`input×in + cache_read×cached + output×out`, EUR = USD × 0.85
(Mistral's own GLM listing: $1.40 ↔ €1.19).

## Known pitfalls (encoded in blood)

- The plugin loader scans for imports with a **regex over raw source** — a
  `from "word"` pattern inside a COMMENT or string literal fails the load with
  `unsupported import: <word>`. Never write import-looking prose in comments.
- **Never short-circuit hooks**: `useValue(a) || useValue(b)` changes the hook
  count between renders → React throws "Rendered more hooks than during the
  previous render" → the chip degrades to the ⚠ `token-stats:chip` fallback
  until clicked. Call both hooks, combine the values.
- Resumed sessions report no `context_*` fields in the streamed usage; merge the
  `session.context_breakdown` RPC over it (what core's statusbar gauge does).

## License

Private. All rights reserved.
