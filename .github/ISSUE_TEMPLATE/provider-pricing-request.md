name: Provider pricing request
description: Request cost estimates for a provider not yet in the catalog tables
labels: ["provider-pricing"]
body:
  - type: markdown
    attributes:
      value: |
        The plugin prices models via provider-aware catalog tables
        (`PRICES_PROVIDER` in `plugin.js`). Currently covered: Mistral,
        OpenRouter, Nous (via the OpenRouter catalog). Adding a new provider
        is a small, exact-match table addition.

        **Source requirement:** prices must come from the provider's OWN price
        list (official pricing page or public pricing API) — no third-party
        aggregators or search-engine snippets, they are frequently stale or
        mixed across endpoints.
  - type: input
    id: provider
    attributes:
      label: Provider name
      description: As it appears in `billing_provider` (state.db) or the provider's API docs
      placeholder: e.g. groq, together, deepseek
    validations:
      required: true
  - type: input
    id: provider-id
    attributes:
      label: Exact `billing_provider` value
      description: Run `sqlite3 ~/.hermes/state.db "SELECT DISTINCT billing_provider FROM session_model_usage;"` and paste the exact string — the lookup matches exactly (no prefix matching)
      placeholder: e.g. groq
    validations:
      required: true
  - type: textarea
    id: models
    attributes:
      label: Models you use
      description: Model IDs as they appear in your usage rows
      placeholder: |
        e.g.
        - llama-4-maverick-17b-128e-instruct
        - qwen3-235b-a22b
    validations:
      required: true
  - type: input
    id: price-source
    attributes:
      label: Link to the provider's official price list
      description: Official pricing page or public pricing API endpoint — must be the provider's own source
      placeholder: https://
    validations:
      required: true
  - type: checkboxes
    id: cache-pricing
    attributes:
      label: Cache pricing
      options:
        - label: The provider bills prompt-cache reads at a separate (cheaper) rate, documented at the source above
  - type: markdown
    attributes:
      value: |
        **Not priceable via token counts** (stays `—` by design, never a
        fabricated number): per-minute audio, per-page OCR, per-character TTS.
        If your provider only bills those, the pane will show `—` for those
        models — that's correct behavior.
