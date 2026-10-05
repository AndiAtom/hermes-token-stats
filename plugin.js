/**
 * Token Stats — statusbar chip + pane showing per-session token usage.
 *
 * Chip: compact live readout of the focused session. Every metric (tokens,
 * cache, context, cost, calls) is toggleable via a click menu on the chip;
 * the selection persists via ctx.storage across app restarts.
 *
 * Pane: table of all sessions with token totals, updated via session.usage events.
 *
 * Saves to: ~/.hermes/desktop-plugins/token-stats/plugin.js
 * Reload: ⌘K → "Reload desktop plugins"
 */

import { host, useValue, useQuery, atom } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'token-stats'

// ── Context breakdown (RPC) ─────────────────────────────────────────
// The streamed usage carries context fields only after a turn ran in THIS
// process (the gateway's compressor ledger); a resumed session reports none.
// The app's own statusbar gauge therefore merges session.context_breakdown
// over the streamed usage — we do the same. Read-only estimate, no provider
// call, no cache impact.
function useContextBreakdown(enabled) {
  // Both hooks MUST run unconditionally — an `||` between two useValue calls
  // short-circuits the second one whenever the first is truthy, changing the
  // hook count between renders ("Rendered more hooks than during the previous
  // render"), which crashes the chip on session switches.
  const focused = useValue(host.state.focusedSessionId)
  const active = useValue(host.state.activeSessionId)
  const focusedSid = focused || active
  const query = useQuery({
    queryKey: [ID, 'ctx', focusedSid],
    queryFn: async () => {
      try {
        const res = await host.request('session.context_breakdown', { session_id: focusedSid })
        return { ok: true, res }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    },
    // NO busy gate — the user looks at the statusbar exactly while a turn runs;
    // blocking the fetch then hid the context readout precisely when it mattered.
    enabled: enabled && Boolean(focusedSid),
    refetchInterval: 15_000,
    retry: false,
  })
  if (query.data && query.data.ok) return query.data.res
  return null
}

// ── Chip config (persisted via ctx.storage) ─────────────────────────

const SHOW_KEYS = ['tokens', 'cache', 'context', 'cost', 'calls']
const SHOW_LABELS = {
  tokens: '🪙 Tokens',
  cache: '⚡ Cache',
  context: '📊 Context',
  cost: '💰 Cost',
  calls: '🔁 API-Calls',
}
const DEFAULT_SHOW = { tokens: true, cache: true, context: true, cost: false, calls: false }

// Reactive visibility map; seeded from storage in register() below.
const showMap = atom({ ...DEFAULT_SHOW })

// Local menu-open flag (NOT persisted — just UI state).
const menuOpenMap = atom(false)

function toggleShow(key) {
  const next = { ...showMap.get() }
  next[key] = !next[key]
  // Never allow hiding everything — a fully hidden chip is undiscoverable.
  if (!SHOW_KEYS.some(k => next[k])) return
  showMap.set(next)
}

// ── Pane column widths (drag-resize, persisted) ─────────────────────
// Percentages, sum 100. Both pane tables (summary + session list) read the
// same atom so they stay column-aligned. Drag the handle at a header cell's
// right edge; native document listeners drive the drag, no hook churn.
const DEFAULT_COLW = [48, 14, 14, 13, 11]
const MIN_COLW = 5
const colWidths = atom(DEFAULT_COLW.map(Number))

let colDrag = null
function startColDrag(e, i) {
  e.preventDefault()
  e.stopPropagation()
  const table = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest('table') : null
  colDrag = {
    i,
    startX: e.clientX,
    startW: colWidths.get().map(Number),
    tableW: table ? table.getBoundingClientRect().width : 380,
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const move = (ev) => {
    if (!colDrag) return
    let delta = ((ev.clientX - colDrag.startX) / colDrag.tableW) * 100
    // Clamp so neither side drops below MIN_COLW (sum stays 100)
    delta = Math.max(MIN_COLW - colDrag.startW[colDrag.i],
            Math.min(colDrag.startW[colDrag.i + 1] - MIN_COLW, delta))
    const next = [...colDrag.startW]
    next[colDrag.i] += delta
    next[colDrag.i + 1] -= delta
    colWidths.set(next)
  }
  const up = () => {
    colDrag = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', up)
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', up)
}

// Header cell with a drag handle on its right edge (all but the last column).
// Reads the atom directly — TokenPane subscribes via useValue, so renders are
// always fresh. With a sortKey, the header also sorts: click toggles the
// direction; a pointerdown on the resize handle suppresses the sort click.
function Th(i, className, children, title, sortKey) {
  const W = colWidths.get()
  const active = Boolean(sortKey) && sortBy.get() === sortKey
  const dir = sortDir.get()
  const arrow = active
    ? jsx('span', { className: 'text-[0.5rem] leading-none', children: dir === 'asc' ? '▲' : '▼' })
    : null
  return jsxs('th', {
    className: className + ' relative' + (sortKey ? ' cursor-pointer select-none' : ''),
    style: { width: W[i] + '%' },
    title,
    ...(sortKey
      ? { onClick: () => {
          if (sortSuppressClick) { sortSuppressClick = false; return }
          onSortHeader(sortKey)
        } }
      : {}),
    children: [
      sortKey
        ? jsxs('span', { className: 'inline-flex items-center gap-0.5', children: [children, arrow] })
        : children,
      i < W.length - 1
        ? jsx('span', {
            className: 'absolute inset-y-0 right-0 w-[4px] cursor-col-resize z-20 hover:bg-(--ui-accent)/50',
            onPointerDown: (e) => { sortSuppressClick = true; startColDrag(e, i) },
          })
        : null,
    ],
  })
}

// ── Pricing table (USD per 1M tokens) ───────────────────────────────
// Client-side cost estimate — the gateway's pricing snapshot has no entry for
// custom providers (billing_mode=unknown), so we price locally. Extend the
// table when switching models. Cache reads are billed instead of full input.
const PRICES = {
  // ── Premier frontier (docs.mistral.ai/inference/pricing, verified 2026-09-19) ──
  'mistral-large-latest': { input: 0.50, cached: 0.05, output: 1.50 },    // Mistral Large 3
  'mistral-large-2512': { input: 0.50, cached: 0.05, output: 1.50 },
  'mistral-medium-latest': { input: 1.50, cached: 0.15, output: 7.50 },   // Mistral Medium 3.5
  'mistral-medium-2604': { input: 1.50, cached: 0.15, output: 7.50 },
  'mistral-medium-3-5': { input: 1.50, cached: 0.15, output: 7.50 },
  'mistral-medium-3.5': { input: 1.50, cached: 0.15, output: 7.50 },
  'mistral-medium': { input: 1.50, cached: 0.15, output: 7.50 },          // alias → 3.5
  'mistral-medium-3': { input: 0.40, cached: 0.04, output: 2.00 },         // Medium 3 legacy tier
  'mistral-small-latest': { input: 0.15, cached: 0.015, output: 0.60 },   // Mistral Small 4
  'mistral-small-2603': { input: 0.15, cached: 0.015, output: 0.60 },
  // ── Ministral 3 (official pricing page) ──
  'ministral-14b-latest': { input: 0.20, cached: 0.02, output: 0.20 },
  'ministral-14b-2512': { input: 0.20, cached: 0.02, output: 0.20 },
  'ministral-8b-latest': { input: 0.15, cached: 0.015, output: 0.15 },
  'ministral-8b-2512': { input: 0.15, cached: 0.015, output: 0.15 },
  'ministral-3b-latest': { input: 0.10, cached: 0.01, output: 0.10 },
  'ministral-3b-2512': { input: 0.10, cached: 0.01, output: 0.10 },
  // ── Codestral (official pricing page) ──
  'codestral-latest': { input: 0.30, cached: 0.03, output: 0.90 },
  'codestral-2508': { input: 0.30, cached: 0.03, output: 0.90 },
  'mistral-code-latest': { input: 0.30, cached: 0.03, output: 0.90 },     // Devstral-2-based
  'mistral-code-fim-latest': { input: 0.30, cached: 0.03, output: 0.90 }, // Codestral FIM
  'mistral-vibe-cli-latest': { input: 0.30, cached: 0.03, output: 0.90 }, // Devstral-2-based
  'mistral-vibe-cli-fast': { input: 0.30, cached: 0.03, output: 0.90 },
  'mistral-vibe-cli-with-tools': { input: 0.30, cached: 0.03, output: 0.90 },
  // ── Magistral (deprecated but live on the API; legacy list prices,
  //    no longer on the pricing page. Cache = 10% input, Mistral pattern) ──
  'magistral-medium-latest': { input: 2.00, cached: 0.20, output: 5.00 },
  'magistral-small-latest': { input: 0.50, cached: 0.05, output: 1.50 },
  // ── Third-party hosted on La Plateforme (official pricing page) ──
  'zai-glm-latest': { input: 1.40, cached: 0.14, output: 4.40 },  // Z.ai GLM 5.3/5.2 alias
  'zai-glm-5-3': { input: 1.40, cached: 0.14, output: 4.40 },
  'zai-glm-5-2': { input: 1.40, cached: 0.14, output: 4.40 },
  'zai-glm-5': { input: 1.40, cached: 0.14, output: 4.40 },      // API alias, same listing
  'glm-5-2': { input: 1.40, cached: 0.14, output: 4.40 },
  // Nous Inference API (inference-api.nousresearch.com) serves OpenRouter-style
  // model IDs. Andi decision 2026-09-30: price with MISTRAL's own list prices,
  // not OpenRouter's. Where Mistral hosts the same model, use its La Plateforme
  // price (docs.mistral.ai/inference/pricing, verified 2026-09-30); models
  // Mistral does NOT host stay unpriced ('—', never fabricate a number):
  'z-ai/glm-5.3': { input: 1.40, cached: 0.14, output: 4.40 },  // = Z.ai GLM 5.3 hosted on La Plateforme
  // 'openai/gpt-6-astra-pro': not hosted by Mistral → no Mistral price → unpriced ('—').
  // Voxtral Small (audio→text, token-priced; legacy list, secondary source Sep 2026 —
  // no longer on the official pricing page)
  'voxtral-small-latest': { input: 0.10, cached: 0.01, output: 0.30 },
  'voxtral-small-2507': { input: 0.10, cached: 0.01, output: 0.30 },
  // Embeddings: input-only, per 1M tokens (output n/a)
  'codestral-embed': { input: 0.15, cached: 0.015, output: 0.00 },
  'codestral-embed-2505': { input: 0.15, cached: 0.015, output: 0.00 },
  'mistral-embed': { input: 0.10, cached: 0.01, output: 0.00 },   // legacy list price
  'mistral-embed-2312': { input: 0.10, cached: 0.01, output: 0.00 },
  // ── Free / research (API returns usage but costs 0) ──
  'labs-leanstral-1-5': { input: 0.00, cached: 0.00, output: 0.00 },
  'labs-leanstral-1-5-1': { input: 0.00, cached: 0.00, output: 0.00 },
  'mistral-moderation-2603': { input: 0.00, cached: 0.00, output: 0.00 },
  'stepfun/step-3.7-flash:free': { input: 0.00, cached: 0.00, output: 0.00 },  // OpenRouter free tier
  // NOT priced here (non-token billing, can't map to token usage):
  //   voxtral-mini-* / *-transcribe-* ($/min), voxtral-mini-tts-* ($/M chars),
  //   mistral-ocr-* ($/1000 pages). estimateCost() returns null → pane shows '—'.
}

// ── Provider-aware pricing (v4.5.0) ─────────────────────────────────
// Lookup order in estimateCost():
//   1. PRICES_PROVIDER[billing_provider][model]  — exact provider match
//   2. PRICES[model]                              — model-only (provider unknown/other)
//   3. null → '—'                                 — never guess
// A user running zai-glm-latest through OpenRouter gets the OpenRouter
// price (it differs from Mistral's), not the Mistral list price from the
// model-only table. Provider keys match billing_provider from state.db
// EXACTLY ('openrouter', 'nous') — no prefix matching (custom:mistral
// variants must fall through to the model-only path).
//
// Nous does not publish a machine-readable price list (their portal API
// docs carry no pricing table); the Inference API serves OpenRouter-
// catalog-style model IDs. PRICES_NOUS documents the OpenRouter catalog
// price at generation time as the best available source — same policy as
// the GLM/Nous entry above. For models where Nous' own pricing deviates,
// override the entry here.
const PRICES_PROVIDER = {
  openrouter: null, // filled below with the generated OpenRouter catalog table
  nous: null,       // same source, separately maintained: Nous may deviate
}

// ── OpenRouter catalog prices (source: openrouter.ai/api/v1/models,
//    generated 2026-10-04 via scripts/gen_prices_openrouter.py —
//    USD per 1M tokens; cached = input_cache_read; 0.00 = free tier.)
//    459 curated models (text-in/text-out, priced or free, not expired,
//    OR routing models excluded — they carry no own price).
const PRICES_OPENROUTER = {
  'aion-labs/aion-2.0': { input: 0.8, cached: 0.2, output: 1.6 },
  'aion-labs/aion-3.0': { input: 3, cached: 0.75, output: 6 },
  'aion-labs/aion-3.0-mini': { input: 0.7, cached: 0.18, output: 1.4 },
  'aion-labs/aion-3.5': { input: 3, cached: 0.75, output: 6 },
  'aion-labs/aion-3.5-mini': { input: 0.7, cached: 0.18, output: 1.4 },
  'aion-labs/aion-rp-llama-3.1-8b': { input: 0.8, cached: 0, output: 1.6 },
  'amazon/nova-2-lite-v1': { input: 0.3, cached: 0, output: 2.5 },
  'amazon/nova-lite-v1': { input: 0.06, cached: 0, output: 0.24 },
  'amazon/nova-micro-v1': { input: 0.035, cached: 0, output: 0.14 },
  'amazon/nova-premier-v1': { input: 2.5, cached: 0.625, output: 12.5 },
  'amazon/nova-pro-v1': { input: 0.8, cached: 0, output: 3.2 },
  'anthracite-org/magnum-v4-72b': { input: 2.5, cached: 0, output: 5 },
  'anthropic/claude-fable-5': { input: 10, cached: 1, output: 50 },
  'anthropic/claude-fable-5.1': { input: 10, cached: 0.25, output: 50 },
  'anthropic/claude-fable-5.1:batch': { input: 5, cached: 0.125, output: 25 },
  'anthropic/claude-fable-5:batch': { input: 5, cached: 0.5, output: 25 },
  'anthropic/claude-haiku-4.5': { input: 1, cached: 0.1, output: 5 },
  'anthropic/claude-haiku-4.5:batch': { input: 0.5, cached: 0.05, output: 2.5 },
  'anthropic/claude-opus-4.1': { input: 15, cached: 1.5, output: 75 },
  'anthropic/claude-opus-4.1:batch': { input: 7.5, cached: 0.75, output: 37.5 },
  'anthropic/claude-opus-4.5': { input: 5, cached: 0.5, output: 25 },
  'anthropic/claude-opus-4.5:batch': { input: 2.5, cached: 0.25, output: 12.5 },
  'anthropic/claude-opus-4.6': { input: 5, cached: 0.5, output: 25 },
  'anthropic/claude-opus-4.6:batch': { input: 2.5, cached: 0.25, output: 12.5 },
  'anthropic/claude-opus-4.7': { input: 5, cached: 0.5, output: 25 },
  'anthropic/claude-opus-4.7:batch': { input: 2.5, cached: 0.25, output: 12.5 },
  'anthropic/claude-opus-4.8': { input: 5, cached: 0.5, output: 25 },
  'anthropic/claude-opus-4.8:batch': { input: 2.5, cached: 0.25, output: 12.5 },
  'anthropic/claude-opus-5': { input: 5, cached: 0.5, output: 25 },
  'anthropic/claude-opus-5.5': { input: 4, cached: 0.2, output: 20 },
  'anthropic/claude-opus-5.5:batch': { input: 2, cached: 0.1, output: 10 },
  'anthropic/claude-opus-5:batch': { input: 2.5, cached: 0.25, output: 12.5 },
  'anthropic/claude-sonnet-4': { input: 3, cached: 0.3, output: 15 },
  'anthropic/claude-sonnet-4.5': { input: 3, cached: 0.3, output: 15 },
  'anthropic/claude-sonnet-4.5:batch': { input: 1.5, cached: 0.15, output: 7.5 },
  'anthropic/claude-sonnet-4.6': { input: 3, cached: 0.3, output: 15 },
  'anthropic/claude-sonnet-4.6:batch': { input: 1.5, cached: 0.15, output: 7.5 },
  'anthropic/claude-sonnet-5': { input: 2, cached: 0.2, output: 10 },
  'anthropic/claude-sonnet-5.5': { input: 2, cached: 0.2, output: 10 },
  'anthropic/claude-sonnet-5.5:batch': { input: 1, cached: 0.1, output: 5 },
  'anthropic/claude-sonnet-5:batch': { input: 1, cached: 0.1, output: 5 },
  'apodex/apodex-1.1-mini:free': { input: 0, cached: 0, output: 0 },
  'arcee-ai/trinity-large-thinking': { input: 0.25, cached: 0.06, output: 0.8 },
  'baidu/ernie-4.5-vl-424b-a47b': { input: 0.42, cached: 0, output: 1.25 },
  'bytedance/ui-tars-1.5-7b': { input: 0.1, cached: 0.1, output: 0.2 },
  'bytedance-seed/seed-1.6': { input: 0.25, cached: 0, output: 2 },
  'bytedance-seed/seed-1.6-flash': { input: 0.075, cached: 0, output: 0.3 },
  'bytedance-seed/seed-2-1-turbo': { input: 0.5, cached: 0, output: 2.5 },
  'bytedance-seed/seed-2.0-code': { input: 0.5, cached: 0, output: 3 },
  'bytedance-seed/seed-2.0-lite': { input: 0.25, cached: 0, output: 2 },
  'bytedance-seed/seed-2.0-mini': { input: 0.1, cached: 0, output: 0.4 },
  'cognitivecomputations/dolphin-mistral-24b-venice-edition': { input: 0.2, cached: 0, output: 0.9 },
  'cohere/command-a': { input: 2.5, cached: 0, output: 10 },
  'cohere/command-a-plus': { input: 0.3, cached: 0.15, output: 1.5 },
  'cohere/command-r-08-2024': { input: 0.15, cached: 0, output: 0.6 },
  'cohere/command-r-plus-08-2024': { input: 2.5, cached: 0, output: 10 },
  'cohere/command-r7b-12-2024': { input: 0.0375, cached: 0, output: 0.15 },
  'cohere/north-mini-code:free': { input: 0, cached: 0, output: 0 },
  'deepseek/deepseek-chat': { input: 0.2574, cached: 0, output: 1.0287 },
  'deepseek/deepseek-chat-v3-0324': { input: 0.25, cached: 0, output: 1 },
  'deepseek/deepseek-chat-v3.1': { input: 0.25, cached: 0.13, output: 0.95 },
  'deepseek/deepseek-r1': { input: 0.7, cached: 0, output: 2.5 },
  'deepseek/deepseek-r1-0528': { input: 0.5, cached: 0.35, output: 2.15 },
  'deepseek/deepseek-v3.1-terminus': { input: 0.27, cached: 0, output: 1 },
  'deepseek/deepseek-v3.2': { input: 0.28, cached: 0.028, output: 0.42 },
  'deepseek/deepseek-v3.2-exp': { input: 0.27, cached: 0, output: 0.41 },
  'deepseek/deepseek-v4-flash': { input: 0.0224, cached: 0.0224, output: 1.28 },
  'deepseek/deepseek-v4-flash-0731': { input: 0.0152, cached: 0.0152, output: 1.28 },
  'deepseek/deepseek-v4-flash-vision-exp': { input: 0.2156, cached: 0.00686, output: 0.6468 },
  'deepseek/deepseek-v4-pro': { input: 0.2088, cached: 0.0174, output: 0.4176 },
  'deepseek/deepseek-v4-pro-0813': { input: 0.85, cached: 0.7, output: 5 },
  'deepseek/deepseek-v4.1-flash': { input: 0.003, cached: 0.003, output: 2.4 },
  'deepseek/deepseek-v4.1-flash:batch': { input: 0.112, cached: 0.00336, output: 0.336 },
  'dots-studio/dots-3-note-preview:free': { input: 0, cached: 0, output: 0 },
  'fireworks/ember-1': { input: 3, cached: 0.3, output: 15 },
  'google/gemini-2.5-flash': { input: 0.3, cached: 0.03, output: 2.5 },
  'google/gemini-2.5-flash-image': { input: 0.3, cached: 0.03, output: 2.5 },
  'google/gemini-2.5-flash-lite': { input: 0.1, cached: 0.01, output: 0.4 },
  'google/gemini-2.5-flash-lite:batch': { input: 0.05, cached: 0.01, output: 0.2 },
  'google/gemini-2.5-flash:batch': { input: 0.15, cached: 0.03, output: 1.25 },
  'google/gemini-2.5-pro': { input: 1.25, cached: 0.125, output: 10 },
  'google/gemini-2.5-pro-preview': { input: 1.25, cached: 0.125, output: 10 },
  'google/gemini-2.5-pro:batch': { input: 0.625, cached: 0.125, output: 5 },
  'google/gemini-3-flash-preview': { input: 0.5, cached: 0.05, output: 3 },
  'google/gemini-3-flash-preview:batch': { input: 0.25, cached: 0, output: 1.5 },
  'google/gemini-3-pro-image': { input: 2, cached: 0.2, output: 12 },
  'google/gemini-3-pro-image-preview': { input: 2, cached: 0.2, output: 12 },
  'google/gemini-3.1-flash-image': { input: 0.5, cached: 0, output: 3 },
  'google/gemini-3.1-flash-image-preview': { input: 0.5, cached: 0, output: 3 },
  'google/gemini-3.1-flash-lite': { input: 0.25, cached: 0.025, output: 1.5 },
  'google/gemini-3.1-flash-lite-image': { input: 0.25, cached: 0, output: 1.5 },
  'google/gemini-3.1-flash-lite-preview': { input: 0.25, cached: 0.025, output: 1.5 },
  'google/gemini-3.1-flash-lite:batch': { input: 0.125, cached: 0.0125, output: 0.75 },
  'google/gemini-3.1-pro-preview': { input: 2, cached: 0.2, output: 12 },
  'google/gemini-3.1-pro-preview-customtools': { input: 2, cached: 0.2, output: 12 },
  'google/gemini-3.1-pro-preview:batch': { input: 1, cached: 0, output: 6 },
  'google/gemini-3.5-flash': { input: 1.5, cached: 0.15, output: 9 },
  'google/gemini-3.5-flash-lite': { input: 0.3, cached: 0.03, output: 2.5 },
  'google/gemini-3.5-flash-lite:batch': { input: 0.15, cached: 0.015, output: 1.25 },
  'google/gemini-3.5-flash:batch': { input: 0.75, cached: 0.075, output: 4.5 },
  'google/gemini-3.6-flash': { input: 0.75, cached: 0.075, output: 3.75 },
  'google/gemini-3.6-flash:batch': { input: 0.375, cached: 0.0375, output: 1.875 },
  'google/gemini-3.7-flash': { input: 0.75, cached: 0.075, output: 3.75 },
  'google/gemini-3.7-flash:batch': { input: 0.375, cached: 0.0375, output: 1.875 },
  'google/gemini-3.8-flash': { input: 0.75, cached: 0.075, output: 3.75 },
  'google/gemini-3.8-flash:batch': { input: 0.375, cached: 0.0375, output: 1.875 },
  'google/gemma-2-27b-it': { input: 0.65, cached: 0, output: 0.65 },
  'google/gemma-3-12b-it': { input: 0.05, cached: 0, output: 0.15 },
  'google/gemma-3-27b-it': { input: 0.08, cached: 0.04, output: 0.45 },
  'google/gemma-3-4b-it': { input: 0.05, cached: 0, output: 0.1 },
  'google/gemma-4-26b-a4b-it': { input: 0.0675, cached: 0.0375, output: 0.225 },
  'google/gemma-4-26b-a4b-it:free': { input: 0, cached: 0, output: 0 },
  'google/gemma-4-31b-it': { input: 0.09, cached: 0.05, output: 0.34 },
  'google/gemma-4-31b-it:free': { input: 0, cached: 0, output: 0 },
  'google/lyria-3-clip-preview': { input: 0, cached: 0, output: 0 },
  'google/lyria-3-pro-preview': { input: 0, cached: 0, output: 0 },
  'gryphe/mythomax-l2-13b': { input: 0.08, cached: 0, output: 0.11 },
  'ibm-granite/granite-4.0-h-micro': { input: 0.017, cached: 0, output: 0.112 },
  'ibm-granite/granite-4.2-8b': { input: 0.06, cached: 0.015, output: 0.25 },
  'inception/mercury-2': { input: 0.25, cached: 0.025, output: 0.75 },
  'inception/mercury-2.5': { input: 0.04, cached: 0.004, output: 0.15 },
  'inclusionai/ling-3.0-flash': { input: 0.021, cached: 0.0042, output: 0.063 },
  'inclusionai/ling-3.0-flash-fin': { input: 0.042, cached: 0.0084, output: 0.1232 },
  'inclusionai/ling-3.0-flash-sante:free': { input: 0, cached: 0, output: 0 },
  'inclusionai/ling-3.0-flash-vl': { input: 0.021, cached: 0.0042, output: 0.0616 },
  'inclusionai/ling-3.1-flash': { input: 0, cached: 0, output: 0 },
  'inference-net/schematron-v2-small': { input: 0.05, cached: 0.05, output: 0.23 },
  'inference-net/schematron-v2-turbo': { input: 0.03, cached: 0.03, output: 0.15 },
  'kwaipilot/kat-coder-pro-v2.5': { input: 0.74, cached: 0.15, output: 2.96 },
  'liquid/lfm-2.5-2.6b:free': { input: 0, cached: 0, output: 0 },
  'mancer/weaver': { input: 0.4, cached: 0, output: 0.75 },
  'meituan/longcat-2.0': { input: 0.3, cached: 0.006, output: 1.2 },
  'meta/muse-glimmer-30b': { input: 0.35, cached: 0.04, output: 1.5 },
  'meta/muse-spark-1.1': { input: 1.25, cached: 0.15, output: 4.25 },
  'meta/muse-spark-1.2': { input: 1.25, cached: 0.15, output: 4.25 },
  'meta/muse-spark-1.2-contributor': { input: 0.1, cached: 0.002, output: 0.2 },
  'meta/muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'meta/muse-spark-1.3-contributor': { input: 0.1, cached: 0.002, output: 0.2 },
  'meta-llama/llama-3.1-70b-instruct': { input: 0.4, cached: 0, output: 0.4 },
  'meta-llama/llama-3.1-8b-instruct': { input: 0.05, cached: 0.025, output: 0.08 },
  'meta-llama/llama-3.2-1b-instruct': { input: 0.027, cached: 0, output: 0.201 },
  'meta-llama/llama-3.2-3b-instruct': { input: 0.05, cached: 0, output: 0.33 },
  'meta-llama/llama-3.3-70b-instruct': { input: 0.22, cached: 0.11, output: 0.5 },
  'meta-llama/llama-4-maverick': { input: 0.1875, cached: 0, output: 0.6525 },
  'meta-llama/llama-4-scout': { input: 0.1, cached: 0, output: 0.3 },
  'meta-llama/llama-guard-4-12b': { input: 0.18, cached: 0, output: 0.18 },
  'microsoft/phi-4': { input: 0.07, cached: 0, output: 0.14 },
  'microsoft/wizardlm-2-8x22b': { input: 0.62, cached: 0, output: 0.62 },
  'minimax/minimax-01': { input: 0.2, cached: 0, output: 1.1 },
  'minimax/minimax-m1': { input: 0.55, cached: 0, output: 2.2 },
  'minimax/minimax-m2': { input: 0.3, cached: 0, output: 1.2 },
  'minimax/minimax-m2-her': { input: 0.3, cached: 0.03, output: 1.2 },
  'minimax/minimax-m2.1': { input: 0.3, cached: 0.03, output: 1.2 },
  'minimax/minimax-m2.5': { input: 0.27, cached: 0.027, output: 1.08 },
  'minimax/minimax-m2.7': { input: 0.21, cached: 0.042, output: 0.84 },
  'minimax/minimax-m3': { input: 0.3, cached: 0.06, output: 1.2 },
  'mistralai/codestral-2508': { input: 0.3, cached: 0.03, output: 0.9 },
  'mistralai/codestral-2508:batch': { input: 0.15, cached: 0.015, output: 0.45 },
  'mistralai/devstral-2512': { input: 0.4, cached: 0.04, output: 2 },
  'mistralai/ministral-14b-2512': { input: 0.2, cached: 0.02, output: 0.2 },
  'mistralai/ministral-3b-2512': { input: 0.1, cached: 0.01, output: 0.1 },
  'mistralai/ministral-8b-2512': { input: 0.15, cached: 0.015, output: 0.15 },
  'mistralai/ministral-8b-2512:batch': { input: 0.075, cached: 0.0075, output: 0.075 },
  'mistralai/mistral-large': { input: 2, cached: 0.2, output: 6 },
  'mistralai/mistral-large-2407': { input: 2, cached: 0.2, output: 6 },
  'mistralai/mistral-large-2512': { input: 0.5, cached: 0.05, output: 1.5 },
  'mistralai/mistral-large-2512:batch': { input: 0.25, cached: 0.025, output: 0.75 },
  'mistralai/mistral-medium-3': { input: 0.4, cached: 0.04, output: 2 },
  'mistralai/mistral-medium-3-5': { input: 1.5, cached: 0, output: 7.5 },
  'mistralai/mistral-medium-3-5:batch': { input: 0.75, cached: 0, output: 3.75 },
  'mistralai/mistral-medium-3.1': { input: 0.4, cached: 0.04, output: 2 },
  'mistralai/mistral-medium-3.1:batch': { input: 0.2, cached: 0.02, output: 1 },
  'mistralai/mistral-nemo': { input: 0.019, cached: 0, output: 0.03 },
  'mistralai/mistral-saba': { input: 0.2, cached: 0.02, output: 0.6 },
  'mistralai/mistral-small-24b-instruct-2501': { input: 0.05, cached: 0, output: 0.08 },
  'mistralai/mistral-small-2603': { input: 0.15, cached: 0.015, output: 0.6 },
  'mistralai/mistral-small-2603:batch': { input: 0.075, cached: 0.0075, output: 0.3 },
  'mistralai/mistral-small-3.1-24b-instruct': { input: 0.351, cached: 0, output: 0.555 },
  'mistralai/mistral-small-3.2-24b-instruct': { input: 0.09375, cached: 0, output: 0.25 },
  'mistralai/mixtral-8x22b-instruct': { input: 2, cached: 0.2, output: 6 },
  'mistralai/voxtral-small-24b-2507': { input: 0.1, cached: 0.01, output: 0.3 },
  'moonshotai/kimi-k2': { input: 0.57, cached: 0, output: 2.3 },
  'moonshotai/kimi-k2-0905': { input: 0.6, cached: 0, output: 2.5 },
  'moonshotai/kimi-k2-thinking': { input: 0.6, cached: 0, output: 2.5 },
  'moonshotai/kimi-k2.5': { input: 0.45, cached: 0.07, output: 2.25 },
  'moonshotai/kimi-k2.6': { input: 0.95, cached: 0.16, output: 4 },
  'moonshotai/kimi-k2.7-code': { input: 0.6712, cached: 0.18, output: 3.35 },
  'moonshotai/kimi-k3': { input: 0.72, cached: 0.7, output: 13 },
  'moonshotai/kimi-k3:batch': { input: 2.28, cached: 0.228, output: 11.4 },
  'morph/morph-v3-fast': { input: 0.8, cached: 0, output: 1.2 },
  'morph/morph-v3-large': { input: 0.9, cached: 0, output: 1.9 },
  'nex-agi/nex-n2.5-mini': { input: 0.025, cached: 0.0025, output: 0.1 },
  'nex-agi/nex-n2.5-pro': { input: 0.075, cached: 0.015, output: 0.25 },
  'nousresearch/hermes-3-llama-3.1-405b': { input: 1, cached: 0, output: 1 },
  'nousresearch/hermes-3-llama-3.1-70b': { input: 0.7, cached: 0, output: 0.7 },
  'nousresearch/hermes-4-405b': { input: 1, cached: 0, output: 3 },
  'nvidia/nemotron-3-nano-30b-a3b': { input: 0.05, cached: 0.03, output: 0.2 },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': { input: 0, cached: 0, output: 0 },
  'nvidia/nemotron-3-super-120b-a12b': { input: 0.08, cached: 0, output: 0.45 },
  'nvidia/nemotron-3-super-120b-a12b:free': { input: 0, cached: 0, output: 0 },
  'nvidia/nemotron-3-ultra-550b-a55b': { input: 0.5, cached: 0.1, output: 2.2 },
  'nvidia/nemotron-3-ultra-550b-a55b:free': { input: 0, cached: 0, output: 0 },
  'nvidia/nemotron-3.5-content-safety': { input: 0.2, cached: 0, output: 0.2 },
  'nvidia/nemotron-3.5-content-safety:free': { input: 0, cached: 0, output: 0 },
  'nvidia/nemotron-3.5-lightning': { input: 0.0595, cached: 0.02975, output: 0.17 },
  'nvidia/nemotron-3.5-lightning:free': { input: 0, cached: 0, output: 0 },
  'openai/gpt-3.5-turbo': { input: 0.5, cached: 0, output: 1.5 },
  'openai/gpt-3.5-turbo-0613': { input: 1, cached: 0, output: 2 },
  'openai/gpt-3.5-turbo-16k': { input: 3, cached: 0, output: 4 },
  'openai/gpt-3.5-turbo-instruct': { input: 1.5, cached: 0, output: 2 },
  'openai/gpt-3.5-turbo:batch': { input: 0.25, cached: 0, output: 0.75 },
  'openai/gpt-4': { input: 30, cached: 0, output: 60 },
  'openai/gpt-4-turbo': { input: 10, cached: 0, output: 30 },
  'openai/gpt-4-turbo:batch': { input: 5, cached: 0, output: 15 },
  'openai/gpt-4.1': { input: 2, cached: 0.5, output: 8 },
  'openai/gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'openai/gpt-4.1-mini:batch': { input: 0.2, cached: 0.05, output: 0.8 },
  'openai/gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
  'openai/gpt-4.1-nano:batch': { input: 0.05, cached: 0.0125, output: 0.2 },
  'openai/gpt-4.1:batch': { input: 1, cached: 0.25, output: 4 },
  'openai/gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'openai/gpt-4o-2024-05-13': { input: 5, cached: 0, output: 15 },
  'openai/gpt-4o-2024-08-06': { input: 2.5, cached: 1.25, output: 10 },
  'openai/gpt-4o-2024-11-20': { input: 2.5, cached: 1.25, output: 10 },
  'openai/gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'openai/gpt-4o-mini-2024-07-18': { input: 0.15, cached: 0.075, output: 0.6 },
  'openai/gpt-4o-mini:batch': { input: 0.075, cached: 0.0375, output: 0.3 },
  'openai/gpt-4o:batch': { input: 1.25, cached: 0.625, output: 5 },
  'openai/gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'openai/gpt-5-image': { input: 10, cached: 1.25, output: 10 },
  'openai/gpt-5-image-mini': { input: 2.5, cached: 0.25, output: 2 },
  'openai/gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'openai/gpt-5-mini:batch': { input: 0.125, cached: 0.0125, output: 1 },
  'openai/gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'openai/gpt-5-nano:batch': { input: 0.025, cached: 0.0025, output: 0.2 },
  'openai/gpt-5-pro': { input: 15, cached: 0, output: 120 },
  'openai/gpt-5-pro:batch': { input: 7.5, cached: 0, output: 60 },
  'openai/gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'openai/gpt-5.1-codex': { input: 1.25, cached: 0.13, output: 10 },
  'openai/gpt-5.1-codex-max': { input: 1.25, cached: 0.125, output: 10 },
  'openai/gpt-5.1-codex-mini': { input: 0.25, cached: 0.03, output: 2 },
  'openai/gpt-5.1:batch': { input: 0.625, cached: 0.0625, output: 5 },
  'openai/gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
  'openai/gpt-5.2-chat': { input: 1.75, cached: 0.175, output: 14 },
  'openai/gpt-5.2-codex': { input: 1.75, cached: 0.175, output: 14 },
  'openai/gpt-5.2-pro': { input: 21, cached: 0, output: 168 },
  'openai/gpt-5.2-pro:batch': { input: 10.5, cached: 0, output: 84 },
  'openai/gpt-5.2:batch': { input: 0.875, cached: 0.0875, output: 7 },
  'openai/gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
  'openai/gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'openai/gpt-5.4-image-2': { input: 8, cached: 2, output: 15 },
  'openai/gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'openai/gpt-5.4-mini:batch': { input: 0.375, cached: 0.0375, output: 2.25 },
  'openai/gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'openai/gpt-5.4-nano:batch': { input: 0.1, cached: 0.01, output: 0.625 },
  'openai/gpt-5.4-pro': { input: 30, cached: 0, output: 180 },
  'openai/gpt-5.4-pro:batch': { input: 15, cached: 0, output: 90 },
  'openai/gpt-5.4:batch': { input: 1.25, cached: 0.125, output: 7.5 },
  'openai/gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'openai/gpt-5.5-pro': { input: 30, cached: 0, output: 180 },
  'openai/gpt-5.5-pro:batch': { input: 15, cached: 0, output: 90 },
  'openai/gpt-5.5:batch': { input: 2.5, cached: 0.25, output: 15 },
  'openai/gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'openai/gpt-5.6-luna-pro': { input: 0.2, cached: 0.02, output: 1.2 },
  'openai/gpt-5.6-luna-pro:batch': { input: 0.1, cached: 0.01, output: 0.6 },
  'openai/gpt-5.6-luna:batch': { input: 0.1, cached: 0.01, output: 0.6 },
  'openai/gpt-5.6-sol': { input: 2, cached: 0.2, output: 10 },
  'openai/gpt-5.6-sol-pro': { input: 4, cached: 0.4, output: 20 },
  'openai/gpt-5.6-sol-pro:batch': { input: 1, cached: 0.1, output: 5 },
  'openai/gpt-5.6-sol:batch': { input: 1, cached: 0.1, output: 5 },
  'openai/gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'openai/gpt-5.6-terra-pro': { input: 2, cached: 0.2, output: 12 },
  'openai/gpt-5.6-terra-pro:batch': { input: 1, cached: 0.1, output: 6 },
  'openai/gpt-5.6-terra:batch': { input: 1, cached: 0.1, output: 6 },
  'openai/gpt-5:batch': { input: 0.625, cached: 0.0625, output: 5 },
  'openai/gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'openai/gpt-6-astra-pro': { input: 10, cached: 1, output: 50 },
  'openai/gpt-6-astra-pro:batch': { input: 5, cached: 0.5, output: 25 },
  'openai/gpt-6-astra:batch': { input: 5, cached: 0.5, output: 25 },
  'openai/gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'openai/gpt-6-luna-pro': { input: 0.1, cached: 0.01, output: 0.5 },
  'openai/gpt-6-luna-pro:batch': { input: 0.05, cached: 0.005, output: 0.25 },
  'openai/gpt-6-luna:batch': { input: 0.05, cached: 0.005, output: 0.25 },
  'openai/gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
  'openai/gpt-6-sol-pro': { input: 2, cached: 0.2, output: 10 },
  'openai/gpt-6-sol-pro:batch': { input: 1, cached: 0.1, output: 5 },
  'openai/gpt-6-sol:batch': { input: 1, cached: 0.1, output: 5 },
  'openai/gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'openai/gpt-6.1-sol-pro': { input: 2, cached: 0.1, output: 10 },
  'openai/gpt-audio': { input: 2.5, cached: 0, output: 10 },
  'openai/gpt-audio-mini': { input: 0.6, cached: 0, output: 2.4 },
  'openai/gpt-chat-latest': { input: 5, cached: 0.5, output: 30 },
  'openai/gpt-oss-120b': { input: 0.037, cached: 0, output: 0.17 },
  'openai/gpt-oss-120b:batch': { input: 0.0296, cached: 0, output: 0.136 },
  'openai/gpt-oss-20b': { input: 0.018, cached: 0.009, output: 0.09 },
  'openai/gpt-oss-20b:batch': { input: 0.024, cached: 0, output: 0.112 },
  'openai/gpt-oss-safeguard-20b': { input: 0.075, cached: 0.0375, output: 0.3 },
  'openai/o1': { input: 15, cached: 7.5, output: 60 },
  'openai/o1-pro': { input: 150, cached: 0, output: 600 },
  'openai/o3': { input: 2, cached: 0.5, output: 8 },
  'openai/o3-mini': { input: 1.1, cached: 0.55, output: 4.4 },
  'openai/o3-mini-high': { input: 1.1, cached: 0.55, output: 4.4 },
  'openai/o3-mini:batch': { input: 0.55, cached: 0.275, output: 2.2 },
  'openai/o3-pro': { input: 20, cached: 0, output: 80 },
  'openai/o3:batch': { input: 1, cached: 0.25, output: 4 },
  'openai/o4-mini': { input: 1.1, cached: 0.275, output: 4.4 },
  'openai/o4-mini-high': { input: 1.1, cached: 0.275, output: 4.4 },
  'openai/o4-mini:batch': { input: 0.55, cached: 0.1375, output: 2.2 },
  'openrouter/free': { input: 0, cached: 0, output: 0 },
  'perceptron/perceptron-mk1': { input: 0.15, cached: 0, output: 1.5 },
  'perceptron/perceptron-mk1.5': { input: 0.15, cached: 0, output: 1.5 },
  'perplexity/sonar': { input: 1, cached: 0, output: 1 },
  'perplexity/sonar-deep-research': { input: 2, cached: 0, output: 8 },
  'perplexity/sonar-pro': { input: 3, cached: 0, output: 15 },
  'perplexity/sonar-pro-search': { input: 3, cached: 0, output: 15 },
  'perplexity/sonar-reasoning-pro': { input: 2, cached: 0, output: 8 },
  'poolside/laguna-s-2.1': { input: 0.09, cached: 0.009, output: 0.18 },
  'poolside/laguna-s-2.1:free': { input: 0, cached: 0, output: 0 },
  'poolside/laguna-xs-2.1': { input: 0.06, cached: 0.03, output: 0.12 },
  'poolside/laguna-xs-2.1:free': { input: 0, cached: 0, output: 0 },
  'prism-ml/ternary-bonsai-2-27b': { input: 0.075, cached: 0.0375, output: 0.5 },
  'qwen/qwen-2.5-72b-instruct': { input: 0.36, cached: 0, output: 0.4 },
  'qwen/qwen-2.5-7b-instruct': { input: 0.1, cached: 0, output: 0.2 },
  'qwen/qwen-2.5-coder-32b-instruct': { input: 0.66, cached: 0, output: 1 },
  'qwen/qwen-plus': { input: 0.26, cached: 0.052, output: 0.78 },
  'qwen/qwen-plus-2025-07-28': { input: 0.26, cached: 0, output: 0.78 },
  'qwen/qwen2.5-vl-72b-instruct': { input: 0.8, cached: 0.4, output: 1 },
  'qwen/qwen3-14b': { input: 0.12, cached: 0, output: 0.24 },
  'qwen/qwen3-235b-a22b': { input: 0.455, cached: 0, output: 1.82 },
  'qwen/qwen3-235b-a22b-2507': { input: 0.0875, cached: 0.0175, output: 0.35 },
  'qwen/qwen3-235b-a22b-thinking-2507': { input: 0.23, cached: 0, output: 2.3 },
  'qwen/qwen3-30b-a3b': { input: 0.12, cached: 0, output: 0.5 },
  'qwen/qwen3-30b-a3b-instruct-2507': { input: 0.04815, cached: 0, output: 0.19305 },
  'qwen/qwen3-30b-a3b-thinking-2507': { input: 0.2, cached: 0, output: 2.4 },
  'qwen/qwen3-32b': { input: 0.08, cached: 0, output: 0.28 },
  'qwen/qwen3-8b': { input: 0.117, cached: 0, output: 0.455 },
  'qwen/qwen3-coder': { input: 0.3, cached: 0.1, output: 1 },
  'qwen/qwen3-coder-30b-a3b-instruct': { input: 0.07, cached: 0, output: 0.28 },
  'qwen/qwen3-coder-flash': { input: 0.195, cached: 0.039, output: 0.975 },
  'qwen/qwen3-coder-next': { input: 0.12, cached: 0.07, output: 0.8 },
  'qwen/qwen3-coder-plus': { input: 0.65, cached: 0.13, output: 3.25 },
  'qwen/qwen3-max': { input: 0.78, cached: 0.156, output: 3.9 },
  'qwen/qwen3-max-thinking': { input: 0.78, cached: 0, output: 3.9 },
  'qwen/qwen3-next-80b-a3b-instruct': { input: 0.1, cached: 0.07, output: 1.1 },
  'qwen/qwen3-next-80b-a3b-thinking': { input: 0.15, cached: 0, output: 1.2 },
  'qwen/qwen3-vl-235b-a22b-instruct': { input: 0.21, cached: 0.1, output: 1.9 },
  'qwen/qwen3-vl-235b-a22b-thinking': { input: 0.4, cached: 0, output: 4 },
  'qwen/qwen3-vl-30b-a3b-instruct': { input: 0.15, cached: 0, output: 0.6 },
  'qwen/qwen3-vl-30b-a3b-thinking': { input: 0.2, cached: 0, output: 2.4 },
  'qwen/qwen3-vl-32b-instruct': { input: 0.104, cached: 0, output: 0.416 },
  'qwen/qwen3-vl-8b-instruct': { input: 0.117, cached: 0, output: 0.455 },
  'qwen/qwen3-vl-8b-thinking': { input: 0.18, cached: 0, output: 2.1 },
  'qwen/qwen3.5-122b-a10b': { input: 0.26, cached: 0, output: 2.08 },
  'qwen/qwen3.5-27b': { input: 0.195, cached: 0, output: 1.56 },
  'qwen/qwen3.5-35b-a3b': { input: 0.15, cached: 0.05, output: 1 },
  'qwen/qwen3.5-397b-a17b': { input: 0.55, cached: 0.225, output: 3.5 },
  'qwen/qwen3.5-9b': { input: 0.1, cached: 0, output: 0.15 },
  'qwen/qwen3.5-flash-02-23': { input: 0.065, cached: 0, output: 0.26 },
  'qwen/qwen3.5-plus-02-15': { input: 0.26, cached: 0, output: 1.56 },
  'qwen/qwen3.5-plus-20260420': { input: 0.3, cached: 0, output: 1.8 },
  'qwen/qwen3.6-27b': { input: 0.32, cached: 0, output: 3.2 },
  'qwen/qwen3.6-35b-a3b': { input: 0.15, cached: 0.05, output: 1 },
  'qwen/qwen3.6-flash': { input: 0.1875, cached: 0, output: 1.125 },
  'qwen/qwen3.6-max-preview': { input: 1.027, cached: 0, output: 6.162 },
  'qwen/qwen3.6-plus': { input: 0.325, cached: 0, output: 1.95 },
  'qwen/qwen3.7-flash': { input: 0.03, cached: 0.006, output: 0.13 },
  'qwen/qwen3.7-max': { input: 1.475, cached: 0.295, output: 4.425 },
  'qwen/qwen3.7-plus': { input: 0.32, cached: 0.064, output: 1.28 },
  'qwen/qwen3.8-2.4t-a95b': { input: 2, cached: 0.25, output: 6 },
  'qwen/qwen3.8-27b': { input: 0.425, cached: 0.085, output: 2.55 },
  'qwen/qwen3.8-27b:free': { input: 0, cached: 0, output: 0 },
  'qwen/qwen3.8-flash': { input: 0.15, cached: 0.016, output: 0.47 },
  'qwen/qwen3.8-max-0902': { input: 2, cached: 0.25, output: 6 },
  'qwen/qwen3.8-max-prime': { input: 4, cached: 0.5, output: 12 },
  'qwen/qwen3.8-omni-flash': { input: 0.15, cached: 0.016, output: 0.47 },
  'rekaai/reka-edge': { input: 0.1, cached: 0, output: 0.1 },
  'rekaai/reka-flash-3': { input: 0.1, cached: 0, output: 0.2 },
  'relace/relace-apply-3': { input: 0.85, cached: 0, output: 1.25 },
  'relace/relace-search': { input: 1, cached: 0, output: 3 },
  'sakana/fugu-max': { input: 2, cached: 0.25, output: 6 },
  'sakana/fugu-ultra': { input: 5, cached: 0.5, output: 30 },
  'sakana/fugu-ultra-v2': { input: 5, cached: 0.5, output: 30 },
  'sakana/sakana-namazu': { input: 0.95, cached: 0.15, output: 4 },
  'sao10k/l3-lunaris-8b': { input: 0.04, cached: 0, output: 0.05 },
  'sao10k/l3.1-euryale-70b': { input: 0.85, cached: 0, output: 0.85 },
  'sao10k/l3.3-euryale-70b': { input: 0.65, cached: 0, output: 0.75 },
  'stealth/space-bunny-alpha': { input: 0, cached: 0, output: 0 },
  'stepfun/step-3.5-flash': { input: 0.1, cached: 0, output: 0.3 },
  'stepfun/step-3.7-flash': { input: 0.2, cached: 0.04, output: 1.15 },
  'tencent/hunyuan-a13b-instruct': { input: 0.14, cached: 0, output: 0.57 },
  'tencent/hy-mt2-1.8b': { input: 0.044, cached: 0, output: 0.177 },
  'tencent/hy-mt2-30b-a3b': { input: 0.074, cached: 0, output: 0.295 },
  'tencent/hy-mt2-7b': { input: 0.074, cached: 0, output: 0.295 },
  'tencent/hy3': { input: 0.132, cached: 0.033, output: 0.528 },
  'tencent/hy3-preview': { input: 0.18, cached: 0.06, output: 0.6 },
  'tencent/hy4-preview': { input: 0.834, cached: 0.042, output: 2.501 },
  'thedrummer/cydonia-24b-v4.1': { input: 0.3, cached: 0.15, output: 0.5 },
  'thedrummer/skyfall-36b-v2': { input: 0.55, cached: 0.25, output: 0.8 },
  'thedrummer/unslopnemo-12b': { input: 0.4, cached: 0, output: 0.4 },
  'thinkingmachines/inkling': { input: 0.95, cached: 0.16, output: 4.05 },
  'thinkingmachines/inkling-small': { input: 0.45, cached: 0.1, output: 1.2 },
  'thinkingmachines/inkling-small:free': { input: 0, cached: 0, output: 0 },
  'thinkingmachines/inkling:free': { input: 0, cached: 0, output: 0 },
  'unbiased/pareto': { input: 2.5, cached: 0.25, output: 7.5 },
  'unbiased/pareto-26.10-preview': { input: 0.8, cached: 0.03, output: 3.2 },
  'undi95/remm-slerp-l2-13b': { input: 0.35, cached: 0, output: 0.65 },
  'upstage/solar-mini4': { input: 0.05, cached: 0.005, output: 0.2 },
  'upstage/solar-pro-3': { input: 0.15, cached: 0.015, output: 0.6 },
  'upstage/solar-pro4': { input: 0.09, cached: 0.018, output: 0.36 },
  'writer/palmyra-x5': { input: 0.6, cached: 0, output: 6 },
  'x-ai/grok-4.20': { input: 1.25, cached: 0.2, output: 2.5 },
  'x-ai/grok-4.20-multi-agent': { input: 1.25, cached: 0.2, output: 2.5 },
  'x-ai/grok-4.3': { input: 1.25, cached: 0.2, output: 2.5 },
  'x-ai/grok-4.3:batch': { input: 1, cached: 0.16, output: 2 },
  'x-ai/grok-4.5': { input: 2, cached: 0.3, output: 6 },
  'x-ai/grok-4.6': { input: 2, cached: 0.5, output: 6 },
  'x-ai/grok-4.7': { input: 2, cached: 0.5, output: 6 },
  'x-ai/grok-build-0.1': { input: 1, cached: 0.2, output: 2 },
  'xiaomi/mimo-v2.5': { input: 0.14, cached: 0.0028, output: 0.28 },
  'xiaomi/mimo-v2.5-pro': { input: 0.435, cached: 0.0036, output: 0.87 },
  'xiaomi/mimo-v2.6-flash': { input: 0.14, cached: 0.0028, output: 0.28 },
  'xiaomi/mimo-v2.6-pro': { input: 0.435, cached: 0.0036, output: 0.87 },
  'xiaomi/mimo-v2.6-pro-ultraspeed': { input: 4.35, cached: 0.036, output: 8.7 },
  'z-ai/glm-4.5': { input: 0.6, cached: 0.11, output: 2.2 },
  'z-ai/glm-4.5-air': { input: 0.13, cached: 0.025, output: 0.85 },
  'z-ai/glm-4.5v': { input: 0.6, cached: 0.11, output: 1.8 },
  'z-ai/glm-4.6': { input: 0.43, cached: 0.08, output: 1.75 },
  'z-ai/glm-4.6v': { input: 0.3, cached: 0.05, output: 0.9 },
  'z-ai/glm-4.7': { input: 0.6, cached: 0.11, output: 2.2 },
  'z-ai/glm-4.7-flash': { input: 0.0605, cached: 0, output: 0.4 },
  'z-ai/glm-5': { input: 0.6, cached: 0.12, output: 1.92 },
  'z-ai/glm-5-turbo': { input: 1.2, cached: 0.24, output: 4 },
  'z-ai/glm-5.1': { input: 1.4, cached: 0.26, output: 4.4 },
  'z-ai/glm-5.2': { input: 0.38, cached: 0.26, output: 3.49 },
  'z-ai/glm-5.3': { input: 1.4, cached: 0.14, output: 4.4 },
  'z-ai/glm-5.3-flash': { input: 0.15, cached: 0.03, output: 0.5 },
  'z-ai/glm-5.3-flash:batch': { input: 0.06, cached: 0.012, output: 0.2 },
  'z-ai/glm-5.3-flashx': { input: 0.37, cached: 0.09, output: 1.25 },
  'z-ai/glm-5.3-prime': { input: 2.8, cached: 0.56, output: 8.8 },
  'z-ai/glm-5.3:batch': { input: 0.45, cached: 0.1, output: 2 },
  'z-ai/glm-5v-turbo': { input: 1.2, cached: 0.24, output: 4 },
  '~anthropic/claude-fable-latest': { input: 10, cached: 0.25, output: 50 },
  '~anthropic/claude-haiku-latest': { input: 1, cached: 0.1, output: 5 },
  '~anthropic/claude-opus-latest': { input: 4, cached: 0.2, output: 20 },
  '~anthropic/claude-sonnet-latest': { input: 2, cached: 0.2, output: 10 },
  '~deepseek/deepseek-flash-latest': { input: 0.003, cached: 0.003, output: 2.4 },
  '~deepseek/deepseek-pro-latest': { input: 0.1901, cached: 0.19, output: 4.2 },
  '~deepseek/deepseek-v4-flash-latest': { input: 0.0152, cached: 0.0152, output: 1.28 },
  '~google/gemini-flash-latest': { input: 0.75, cached: 0.075, output: 3.75 },
  '~google/gemini-pro-latest': { input: 2, cached: 0.2, output: 12 },
  '~moonshotai/kimi-latest': { input: 0.6756, cached: 0.45, output: 13 },
  '~openai/gpt-astra-latest': { input: 10, cached: 1, output: 50 },
  '~openai/gpt-luna-latest': { input: 0.1, cached: 0.01, output: 0.5 },
  '~openai/gpt-mini-latest': { input: 0.75, cached: 0.075, output: 4.5 },
  '~openai/gpt-sol-latest': { input: 2, cached: 0.1, output: 10 },
  '~openai/gpt-terra-latest': { input: 2, cached: 0.2, output: 12 },
  '~x-ai/grok-latest': { input: 2, cached: 0.5, output: 6 },
  '~z-ai/glm-flash-latest': { input: 0.0352, cached: 0.0352, output: 0.5 },
  '~z-ai/glm-latest': { input: 0.05, cached: 0.04, output: 5 },
}

// Wiring (after the table declaration — TDZ-safe):
PRICES_PROVIDER.openrouter = PRICES_OPENROUTER
// Nous: Inference API serves OR-catalog-style IDs; the OR catalog price is
// the best documented source (Nous publishes no machine-readable list).
// Override individual entries in a separate PRICES_NOUS table when Nous'
// own pricing deviates.
PRICES_PROVIDER.nous = PRICES_OPENROUTER

// USD → EUR conversion factor (Mistral La Plateforme lists GLM 5.2 at
// $1.40 / €1.19 → 0.85). Update when the official EUR listing shifts.
const EUR_RATE = 0.85

// Estimate session cost from usage fields. Returns null when the model is
// unpriced (never fabricate a number) or usage is missing.
// v4.5.0: provider-aware lookup — exact billing_provider match first
// (PRICES_PROVIDER), then model-only (PRICES). Callers pass
// u.billing_provider when known (ledger rows + session meta carry it).
function estimateCost(u) {
  if (!u) return null
  const model = String(u.model || '').trim()
  let p = null
  const provider = String(u.billing_provider || '').trim().toLowerCase()
  if (provider && PRICES_PROVIDER[provider]) {
    p = PRICES_PROVIDER[provider][model] || null
  }
  if (!p) p = PRICES[model] || null
  if (!p) return null
  const input = Number(u.input) || 0
  const cached = Number(u.cache_read) || 0
  const output = Number(u.output) || 0
  if (!input && !cached && !output) return null
  // "input" from the gateway excludes cache reads (CanonicalUsage.input_tokens
  // is fresh input); bill cached tokens at the cheaper cache-read rate.
  const cost = (input * p.input + cached * p.cached + output * p.output) / 1_000_000
  return cost
}

// ── Helpers ────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function fmtFull(n) {
  if (n == null || isNaN(n)) return '—'
  return n.toLocaleString('de-DE')
}

// Per-session usage store: { [sessionId]: { input, output, total, cache_read, ... } }
// Updated by session.usage events; seeded by session.list + session.info.
const usageMap = atom({})

function mergeUsage(sid, usage) {
  if (!sid || !usage) return
  const cur = usageMap.get()[sid] || {}
  usageMap.set({ ...usageMap.get(), [sid]: { ...cur, ...usage } })
}

// History range presets for the pane — CALENDAR windows, not rolling:
//   day      = today 0:00 → open
//   workweek = Mon 0:00 → Sat 0:00 (exclusive, i.e. Mon–Fri 23:59:59)
//   week     = Mon 0:00 → open (full Mon–Sun calendar week)
//   month    = 1st of month 0:00 → open
//   all      = everything
// rollingDays maps each preset to the legacy usage.history fallback,
// which only understands rolling day windows.
const RANGE_PRESETS = [
  { key: 'day', label: '1d', rollingDays: 1,
    tip: 'Heute (ab 0:00 Uhr)' },
  { key: 'workweek', label: '5d', rollingDays: 5,
    tip: 'Laufende Arbeitswoche: Mo 0:00 – Fr 23:59:59' },
  { key: 'week', label: '7d', rollingDays: 7,
    tip: 'Laufende Kalenderwoche: Mo 0:00 – So 23:59:59' },
  { key: 'month', label: '30d', rollingDays: 30,
    tip: 'Laufender Monat (ab dem 1., 0:00 Uhr)' },
  { key: 'all', label: '∞', rollingDays: 0,
    tip: 'Alles' },
]
const historyRange = atom('month')

// Compute the calendar window for a preset in LOCAL time.
// Returns { since, until, rollingDays } — since/until epoch seconds,
// `since` inclusive, `until` EXCLUSIVE (0 = open-ended).
function windowFor(key) {
  const p = RANGE_PRESETS.find(p => p.key === key) || RANGE_PRESETS[3]
  if (p.key === 'all') return { since: 0, until: 0, rollingDays: 0 }
  const now = new Date()
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate()
  if (p.key === 'day') {
    return { since: Math.floor(new Date(y, mo, d).getTime() / 1000),
             until: 0, rollingDays: 1 }
  }
  if (p.key === 'month') {
    return { since: Math.floor(new Date(y, mo, 1).getTime() / 1000),
             until: 0, rollingDays: 30 }
  }
  // week / workweek: start of the current calendar week (Monday 0:00)
  const dow = (now.getDay() + 6) % 7 // Mon=0 … Sun=6
  const since = Math.floor(new Date(y, mo, d - dow).getTime() / 1000)
  if (p.key === 'workweek') {
    // Mon 0:00 → Sat 0:00 (exclusive) = Mon–Fri 23:59:59
    const until = Math.floor(new Date(y, mo, d - dow + 5).getTime() / 1000)
    return { since, until, rollingDays: 5 }
  }
  return { since, until: 0, rollingDays: 7 } // full week, open-ended
}

// ── Pane sort state ─────────────────────────────────────────────────
// Default: 'activity' desc (= server order, with day separators).
// Clicking a column header sorts by it; clicking again flips direction.
const sortBy = atom('activity') // activity | in | cached | out | cost
const sortDir = atom('desc')

// Collapsed day groups (activity sort): { dayKey: true }. Toggled by
// clicking a day separator row; the separator (with its totals) stays
// visible, only the group's session rows are hidden. Session-local.
const collapsedDays = atom({})

// Model list (footer toggle): true → the pane renders the per-model
// breakdown table above the session list. Session-local, default off.
const modelListOpen = atom(false)

// Subagent list (footer toggle): same UX as the model list — bottom-pinned
// breakdown over the active window. Session-local, default off.
const subListOpen = atom(false)

// Histogram metric (pane): 'tokens' | 'cost' — what the bar heights measure.
// Session-local, default tokens. Tooltip always shows BOTH values.
const histMetric = atom('tokens')

function toggleDayCollapse(key) {
  // Flip the RESOLVED state, not the raw override: default-collapsed
  // days (everything except today) have no entry yet, so a naive
  // "set true" would be a no-op and the day could never be expanded.
  const next = { ...collapsedDays.get() }
  const todayKey = dayKeyDate(new Date())
  const resolved = (key in next) ? Boolean(next[key]) : (key !== todayKey)
  next[key] = !resolved // always an explicit override
  collapsedDays.set(next)
}

const SORTS = {
  activity: { dir: 'desc', val: r => (r.lastActive == null ? -Infinity : r.lastActive) },
  in: { dir: 'desc', val: r => r.u.input || 0 },
  cached: { dir: 'desc', val: r => r.u.cache_read || 0 },
  out: { dir: 'desc', val: r => r.u.output || 0 },
  cost: { dir: 'desc', val: r => r.cost != null ? r.cost : -Infinity },
}

function onSortHeader(key) {
  if (sortBy.get() === key) {
    sortDir.set(sortDir.get() === 'asc' ? 'desc' : 'asc')
  } else {
    sortBy.set(key)
    sortDir.set(SORTS[key].dir)
  }
}

// Suppress a sort toggle when the click was actually a column-drag
// (pointerdown on the resize handle precedes the click event).
let sortSuppressClick = false

// ── Calendar-day helpers (local time) ───────────────────────────────
function _pad(n) { return String(n).padStart(2, '0') }
function dayKeyDate(d) {
  return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate())
}
function dayKeyTs(ts) { return dayKeyDate(new Date(ts * 1000)) }

// Label for a calendar-day key relative to today.
function dayLabel(key) {
  const now = new Date()
  if (key === dayKeyDate(now)) return 'Heute'
  if (key === dayKeyDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Gestern'
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

// Footer description of the active range preset's calendar window.
function windowLabel(range) {
  const win = windowFor(range)
  if (!win.since) return 'Alle Zeit'
  const since = new Date(win.since * 1000)
  const f = d => d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })
  if (range === 'day') return 'Heute'
  if (range === 'workweek') return f(since) + ' – ' + f(new Date((win.until - 1) * 1000))
  if (range === 'week') return 'ab ' + f(since)
  return 'ab ' + since.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

const EMPTY_MSG = {
  day: 'Noch keine Sitzungen heute',
  workweek: 'Keine Sitzungen in der Arbeitswoche (Mo–Fr)',
  week: 'Keine Sitzungen in dieser Kalenderwoche',
  month: 'Keine Sitzungen im laufenden Monat',
  all: 'Noch keine Sitzungen im Ledger',
}

// Per-day token totals over the window, for the mini histogram. A
// session's tokens are attributed to its last-active day (visual
// estimate — exact per-day splits would need per-message data).
// Live-only rows (no lastActive) count towards today. Capped at 30 bars.
// Each bucket also carries the day's estimated PAYG-equivalent cost
// (same estimateCost as everywhere; null-cost rows contribute 0).
function buildHistogram(rows, range) {
  const win = windowFor(range)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const end = win.until
    ? new Date(Math.min(today.getTime(), (win.until - 1) * 1000))
    : today
  const start = new Date(Math.max(
    win.since ? win.since * 1000 : end - 29 * 86400000,
    end - 29 * 86400000))
  const buckets = []
  const idx = {}
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = dayKeyDate(d)
    if (key in idx) continue // DST edge: 86400s steps can repeat a local day
    idx[key] = buckets.length
    buckets.push({ key, tokens: 0, cost: 0, sessions: 0 })
  }
  const todayKey = dayKeyDate(new Date())
  for (const r of rows) {
    const key = r.lastActive != null ? dayKeyTs(r.lastActive) : todayKey
    const i = idx[key]
    if (i == null) continue
    buckets[i].tokens += (r.u.input || 0) + (r.u.cache_read || 0) + (r.u.output || 0)
    const c = estimateCost({ input: r.u.input, cache_read: r.u.cache_read, output: r.u.output, model: r.u.model, billing_provider: r.u.billing_provider })
    if (c != null) buckets[i].cost += c
    buckets[i].sessions++
  }
  return buckets
}

// ctx.rest handle — set once in register(ctx); null = backend unavailable
// (plugin not loaded yet, OAuth remote → ctx.rest is a no-op there).
let restApi = null

// Ledger backend: fetch known (monotonic) data via ctx.rest. Returns
// null when the backend is unreachable → caller falls back to the
// usage.history RPC. ctx.rest throws/errors on: backend not enabled,
// remote OAuth host, gateway without plugin support.
async function fetchLedger(params) {
  if (!restApi) return null
  try {
    const q = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    return await restApi(`/ledger${q ? '?' + q : ''}`)
  } catch (e) {
    return null
  }
}

// ── Chip menu (popover) ─────────────────────────────────────────────

function ChipMenu() {
  const show = useValue(showMap)
  return jsxs('div', {
    className: 'flex flex-col gap-0.5 p-1.5 rounded-md border border-(--ui-stroke-secondary) bg-(--card) shadow-lg text-[0.75rem] min-w-[170px]',
    // stopPropagation so the chip's own onClick doesn't re-toggle the menu
    onClick: (e) => { e.stopPropagation() },
    children: [
      jsx('div', { className: 'px-2 py-1 text-[0.625rem] uppercase text-(--ui-text-quaternary)', children: 'Display' }),
      ...SHOW_KEYS.map(key => jsxs('button', {
        type: 'button',
        className: 'flex items-center justify-between gap-2 px-2 py-1 rounded-sm hover:bg-(--ui-stroke-secondary) text-left text-(--ui-text-secondary) cursor-pointer w-full',
        onClick: () => { toggleShow(key) },
        children: [
          jsx('span', { children: SHOW_LABELS[key] }),
          jsx('span', {
            className: show[key] ? 'text-(--ui-accent)' : 'text-(--ui-text-quaternary)',
            children: show[key] ? '●' : '○',
          }),
        ],
      })),
    ],
  })
}

// Persistent fallback for the chip: when the focused session has no live
// usage yet (old/resumed session, agent not loaded), fetch its totals
// from the KNOWN-LEDGER backend (monotonic, compression-safe). Falls back
// to the legacy usage.history deep-dive when the backend is unavailable.
// Runs only when needed.
function usePersistedUsage(enabled, sid) {
  const query = useQuery({
    queryKey: [ID, 'known', sid],
    queryFn: async () => {
      // 1st choice: known-ledger backend (ctx.rest namespace)
      const led = await fetchLedger({ session_id: sid, days: 0, limit: 1 })
      if (led && Array.isArray(led.sessions) && led.sessions.length) {
        return { ok: true, res: led, source: 'ledger' }
      }
      // 2nd choice: legacy usage.history RPC (old gateway / OAuth remote)
      try {
        const res = await host.request('usage.history', { session_id: sid, models: true })
        return { ok: true, res, source: 'rpc' }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    },
    enabled: enabled && Boolean(sid),
    refetchInterval: 60_000,
    retry: false,
  })
  if (query.data && query.data.ok) {
    const s = (query.data.res.sessions || [])[0]
    if (!s) return null
    return {
      input: s.input_tokens || 0,
      cache_read: s.cache_read_tokens || 0,
      output: s.output_tokens || 0,
      calls: s.api_call_count || 0,
      model: s.model || '',
      persisted: true,
    }
  }
  return null
}

// ── Statusbar Chip ─────────────────────────────────────────────────

function TokenChip() {
  // ALL hooks unconditionally first (short-circuiting between hooks changes
  // the hook count between renders → React crash on session switches).
  const usage = useValue(host.state.focusedUsage)
  const focusedSid = useValue(host.state.focusedSessionId)
  const activeSid = useValue(host.state.activeSessionId)
  const breakdown = useContextBreakdown(true)
  const show = useValue(showMap)
  const menuOpen = useValue(menuOpenMap)
  const sid = focusedSid || activeSid
  // Live usage covers sessions that ran a turn in THIS process. Older
  // sessions report nothing live — fall back to persistent DB totals.
  const hasLive = Boolean(usage && (usage.total || usage.input || usage.output || usage.calls))
  // After context compression the live ledger underflows (input =
  // prompt_total − cache_read − cache_write < 0 when pre-compaction cache
  // reads exceed the post-compaction prompt). Negative counters are garbage
  // — treat them like no-live and fall back to the cumulative DB totals.
  const negLive = hasLive && (
    (Number(usage.input) || 0) < 0 || (Number(usage.cache_read) || 0) < 0 ||
    (Number(usage.output) || 0) < 0 || (Number(usage.total) || 0) < 0)
  // Always fetch the persisted totals for the focused session — the
  // cumulative-monotonic merge below needs them even when live looks sane
  // (post-compaction live can be small-but-positive while the DB holds the
  // full cumulative history of the session).
  const persisted = usePersistedUsage(true, sid)
  // The breakdown wins whenever we have one — it reports the MEASURED
  // occupancy once the backend has it and is keyed to this session; the
  // streamed usage only carries context fields after a turn ran here.
  const u = breakdown
    ? { ...(usage || {}), ...breakdown }
    : (usage || {})
  // Merge — cumulative-monotonic: DB totals are cumulative and survive
  // compression; live counters are fresher but underflow/reset at compaction.
  // Take the LARGER of the two per field: live wins while it is genuinely
  // ahead (mid-turn), persisted wins after a compaction reset.
  const isPersisted = Boolean(persisted) && (
    (persisted.input || 0) > Math.max(0, Number(u.input) || 0) ||
    (persisted.cache_read || 0) > Math.max(0, Number(u.cache_read) || 0) ||
    (persisted.output || 0) > Math.max(0, Number(u.output) || 0) ||
    (persisted.calls || 0) > Math.max(0, Number(u.calls) || 0))
  const input = Math.max(Math.max(0, Number(u.input) || 0), persisted ? persisted.input : 0)
  const cached = Math.max(Math.max(0, Number(u.cache_read) || 0), persisted ? persisted.cache_read : 0)
  const out = Math.max(Math.max(0, Number(u.output) || 0), persisted ? persisted.output : 0)
  const calls = Math.max(Math.max(0, Number(u.calls) || 0), persisted ? persisted.calls : 0)
  const model = u.model || (persisted ? persisted.model : '')
  const total = Math.max(Math.max(0, Number(u.total) || 0), input + cached + out)
  const hitPctRaw = Number(u.cache_hit_pct)
  const hitPct = Number.isFinite(hitPctRaw) && hitPctRaw >= 0 ? hitPctRaw : null
  const ctxPct = u.context_percent
  const ctxUsed = u.context_used
  const ctxMax = u.context_max
  const cost = estimateCost({ input, cache_read: cached, output: out, model, billing_provider: u.billing_provider })

  return jsxs('div', {
    className: 'relative inline-flex h-full items-center',
    children: [
      jsxs('button', {
        type: 'button',
        className: 'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) tabular-nums cursor-pointer hover:text-(--ui-text-secondary)',
        title: `Token Stats v4.6.3 · Click: configure display · drag header edges to resize pane columns${isPersisted ? ' · 📚 Known-Ledger values (monotonic)' : ''}\n\nInput: ${fmtFull(input)} · Cached: ${fmtFull(cached)}${hitPct != null ? ` (${hitPct}%)` : ''} · Output: ${fmtFull(out)} · Total: ${fmtFull(total)}`
          + (ctxPct != null && ctxMax > 0 ? `\nContext: ${fmtFull(ctxUsed)} / ${fmtFull(ctxMax)} tokens (${ctxPct}%)` : '')
          + (cost != null ? `\nCost: ${(cost * EUR_RATE).toFixed(2)} €` : '')
          + (calls > 0 ? `\nAPI calls: ${fmtFull(calls)}` : ''),
        onClick: (e) => { e.stopPropagation(); menuOpenMap.set(!menuOpen) },
        children: [
          show.tokens
            ? jsxs('span', { children: [
                jsx('span', { className: 'text-(--ui-text-quaternary)', children: '🪙' }),
                total > 0
                  ? jsxs('span', { children: [
                      fmt(total),
                      jsx('span', { className: 'text-(--ui-text-quaternary) ml-0.5', children: 'tok' }),
                    ]})
                  : jsx('span', { className: 'text-(--ui-text-quaternary)', children: '—' }),
              ]})
            : null,
          show.cache && cached > 0
            ? jsxs('span', {
                className: 'text-(--ui-accent) ml-1',
                title: `Cached input: ${fmtFull(cached)} tokens${hitPct != null ? ` · Hit rate: ${hitPct}%` : ''}`,
                children: ['⚡', hitPct != null ? `${hitPct}%` : fmt(cached)],
              })
            : null,
          show.context && ctxPct != null && ctxMax > 0
            ? jsxs('span', {
                className: 'ml-1',
                title: `Context window: ${fmtFull(ctxUsed)} / ${fmtFull(ctxMax)} tokens (${ctxPct}%)${u.context_estimated ? ' · estimate' : ' · provider usage'}`,
                children: [
                  '📊',
                  jsx('span', {
                    className: ctxPct >= 90 ? 'text-red-400' : ctxPct >= 75 ? 'text-amber-400' : 'text-(--ui-text-tertiary)',
                    children: `${ctxPct}%`,
                  }),
                ],
              })
            : null,
          show.cost && cost != null
            ? jsxs('span', {
                className: 'ml-1 text-(--ui-text-quaternary)',
                title: `Estimated cost: ${(cost * EUR_RATE).toFixed(2)} € (USD ${cost.toFixed(4)})`,
                children: ['💰', (cost * EUR_RATE).toFixed(2), ' €'],
              })
            : null,
          show.calls && calls > 0
            ? jsxs('span', {
                className: 'ml-1 text-(--ui-text-quaternary)',
                title: `API calls: ${fmtFull(calls)}`,
                children: ['🔁', String(calls)],
              })
            : null,
        ],
      }),
      menuOpen
        ? jsx('div', {
            className: 'absolute bottom-full right-0 mb-2 z-50',
            children: jsx(ChipMenu, {}),
          })
        : null,
    ],
  })
}

// ── Pane ───────────────────────────────────────────────────────────
// Data model: the pane is backed by the KNOWN-LEDGER backend (monotonic
// known counters per session — compression/rewind-safe, delivered via
// ctx.rest from the token-stats plugin_api.py). Live session.usage events
// overlay the focused session. Fallback chain: legacy usage.history RPC
// (old gateway, OAuth remote) → live-event map only ("live only").
// Anomalies (DB resets) are flagged per session via /events (⚠ DB-Reset).

function HistoryQuery(range) {
  // Monotonic per-session totals + per-model rows from the ledger.
  // Calendar windows: since/until (epoch secs, until exclusive) to the
  // ledger backend; the legacy usage.history fallback only understands
  // rolling `days`, so it gets the preset's rollingDays approximation.
  const win = windowFor(range)
  return useQuery({
    queryKey: [ID, 'knownHistory', win.since, win.until],
    queryFn: async () => {
      // 1st choice: known-ledger backend (ctx.rest namespace)
      const led = await fetchLedger({ since: win.since, until: win.until, days: 0, limit: 200 })
      if (led && Array.isArray(led.sessions)) {
        return { ok: true, res: led, source: 'ledger' }
      }
      // 2nd choice: legacy usage.history RPC
      try {
        const res = await host.request('usage.history', { days: win.rollingDays, limit: 200, models: true })
        return { ok: true, res, source: 'rpc' }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    },
    refetchInterval: 30_000,
    retry: false,
  })
}

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

// Anomaly lookup: polls /events per session (once, cached by queryKey) and
// returns a Set of session IDs that have at least one decrease event.
// Only runs against the ledger backend; empty Set on fallback/legacy.
function useAnomalies(sids) {
  const [cache, setCache] = useState({})

  useEffect(() => {
    if (!restApi) return
    let cancelled = false
    ;(async () => {
      const next = {}
      for (const sid of sids) {
        if (sid in cache) { next[sid] = cache[sid]; continue }
        try {
          const q = `session_id=${encodeURIComponent(sid)}&limit=10`
          const ev = await restApi(`/events?${q}`)
          next[sid] = Boolean(ev && Array.isArray(ev.events)
            && ev.events.some(e => e.kind === 'decrease'))
        } catch (e) {
          next[sid] = false
        }
      }
      if (!cancelled) setCache(next)
    })()
    return () => { cancelled = true }
    // sids identity changes every render; depend on a stable join instead
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sids.join(',')])

  const out = new Set()
  for (const [sid, bad] of Object.entries(cache)) if (bad) out.add(sid)
  return out
}

function TokenPane() {
  const focusedSid = useValue(host.state.focusedSessionId)
  const allUsage = useValue(usageMap)
  const range = useValue(historyRange)
  const breakdown = useContextBreakdown(true)
  const W = useValue(colWidths)

  const hist = HistoryQuery(range)
  const histOk = hist.data && hist.data.ok
  const histSessions = histOk ? (hist.data.res.sessions || []) : []
  const histByModel = histOk ? (hist.data.res.model_usage || []) : []
  // model_usage rows → { [sid]: [modelRows] }
  const modelRowsBySid = {}
  for (const r of histByModel) {
    const sid = r.session_id
    if (!modelRowsBySid[sid]) modelRowsBySid[sid] = []
    modelRowsBySid[sid].push(r)
  }

  // Per-model aggregate over the active window (footer model list).
  // liveIn/liveCached/liveOut are the ledger's last-db-snapshot counters —
  // max'd against zero but NOT against live in-memory usage (no per-model
  // live mapping exists outside modelRows; window totals elsewhere in the
  // pane stay the authority). Sessions counted per distinct model.
  const modelAgg = {}
  for (const r of histByModel) {
    const m = modelAgg[r.model] || (modelAgg[r.model] = {
      model: r.model,
      in: 0, cached: 0, out: 0, calls: 0, sessions: new Set(), cost: 0, unpriced: false,
    })
    m.in += Math.max(r.input_tokens || 0, r.live_in || 0)
    m.cached += Math.max(r.cache_read_tokens || 0, r.live_cached || 0)
    m.out += Math.max(r.output_tokens || 0, r.live_out || 0)
    m.calls += Math.max(r.api_calls || 0, r.live_calls || 0)
    m.sessions.add(r.session_id)
    const c = estimateCost({ input: r.input_tokens, cache_read: r.cache_read_tokens, output: r.output_tokens, model: r.model, billing_provider: r.billing_provider })
    if (c != null) m.cost += c; else if ((r.input_tokens || 0) + (r.output_tokens || 0) > 0) m.unpriced = true
  }
  const modelAggList = Object.values(modelAgg)
    .sort((a, b) => ((b.in + b.cached + b.out) - (a.in + a.cached + a.out)))
  // Scale for the per-model relative bars (largest model in view = 100%)
  const maxModelTotal = modelAggList.reduce((m, e) => Math.max(m, e.in + e.cached + e.out), 0)

  // Subagent rows over the active window (ledger sessions flagged by the
  // backend via source='subagent' / $._delegate_from). Same display
  // semantics as the model list: known counters (already max'd with the
  // ledger's live-db snapshot per row inside the merge above).
  const subRows = histSessions
    .filter(s => s.is_subagent)
    .map(s => ({
      id: s.id,
      title: s.title || s.id.slice(0, 12),
      parent: s.parent_session_id || null,
      in: s.input_tokens || 0,
      cached: s.cache_read_tokens || 0,
      out: s.output_tokens || 0,
      calls: s.api_call_count || 0,
    }))
  // Subagent scale for the relative bars (largest subagent = 100%)
  const maxSubTotal = subRows.reduce((m, e) => Math.max(m, e.in + e.cached + e.out), 0)

  const { data: sessionList } = useQuery({
    queryKey: [ID, 'sessions'],
    queryFn: () => host.request('session.list', { limit: 200 }),
    refetchInterval: 10_000,
  })

  // Anomaly flags: fetched once per session ID (not per cell). A session
  // with a decrease event (DB reset/rewind) shows a ⚠ marker in the pane.
  const anomalySids = useAnomalies(histOk && hist.data.source === 'ledger'
    ? histSessions.map(s => s.id) : [])

  // Build the unified row set: persistent rows first (source of truth),
  // then any live session not yet in the history window appended live-only.
  const sessionTitles = {}
  for (const s of (sessionList?.sessions || [])) sessionTitles[s.id] = s.title

  const rows = []
  const seenIds = new Set()
  for (const h of histSessions) {
    const live = allUsage[h.id]
    // Live in-memory values are the freshest for a RUNNING session; the
    // ledger's known values are the monotonic floor. Merge per field:
    // max(known, live) — a live compression reset must never hide tokens
    // the ledger already knows (same semantics as the chip merge).
    const u = live
      ? {
          ...h,
          input_tokens: Math.max(h.input_tokens || 0, Number(live.input) || 0),
          cache_read_tokens: Math.max(h.cache_read_tokens || 0, Number(live.cache_read) || 0),
          output_tokens: Math.max(h.output_tokens || 0, Number(live.output) || 0),
          model: h.model || live.model,
          context_percent: live.context_percent,
          context_used: live.context_used,
          context_max: live.context_max,
          context_estimated: live.context_estimated,
          cache_hit_pct: live.cache_hit_pct,
        }
      : h
    rows.push({
      id: h.id,
      title: sessionTitles[h.id] || h.title || h.id.slice(0, 12),
      isLiveOnly: false,
      hadReset: anomalySids.has(h.id),
      lastActive: h.last_active,
      modelRows: modelRowsBySid[h.id] || [],
      u: {
        input: u.input_tokens != null ? u.input_tokens : (u.input || 0),
        cache_read: u.cache_read_tokens != null ? u.cache_read_tokens : (u.cache_read || 0),
        output: u.output_tokens != null ? u.output_tokens : (u.output || 0),
        context_percent: u.context_percent,
        context_used: u.context_used,
        context_max: u.context_max,
        context_estimated: u.context_estimated,
        cache_hit_pct: u.cache_hit_pct,
        model: u.model || '',
        billing_provider: h.billing_provider || '',
      },
    })
    seenIds.add(h.id)
  }
  for (const s of (sessionList?.sessions || [])) {
    if (seenIds.has(s.id)) continue
    const live = allUsage[s.id]
    if (!live) continue
    rows.push({
      id: s.id,
      title: s.title || s.id.slice(0, 12),
      isLiveOnly: true,
      lastActive: null,
      modelRows: [],
      u: {
        input: live.input || 0,
        cache_read: live.cache_read || 0,
        output: live.output || 0,
        context_percent: live.context_percent,
        context_used: live.context_used,
        context_max: live.context_max,
        context_estimated: live.context_estimated,
        cache_hit_pct: live.cache_hit_pct,
        model: live.model || '',
        billing_provider: live.billing_provider || '',
      },
    })
  }

  const usageFor = (row) => {
    if (row.id === focusedSid && breakdown) return { ...row.u, ...breakdown }
    return row.u
  }

  // Per-row cost (needed for the cost sort key; same estimate as the cell).
  for (const r of rows) {
    r.cost = estimateCost({ input: r.u.input, cache_read: r.u.cache_read, output: r.u.output, model: r.u.model, billing_provider: r.u.billing_provider })
  }

  // Sorted view (SORTS defaults = server's activity order).
  const curSort = useValue(sortBy)
  const curDir = useValue(sortDir)
  const dayCollapse = useValue(collapsedDays)
  const modelListOpenVal = useValue(modelListOpen)
  const subListOpenVal = useValue(subListOpen)
  // Resolved collapse state: explicit override if set, else default
  // (today expanded, every other day collapsed)
  const todayKey = dayKeyDate(new Date())
  const isDayCollapsed = (k) => (k in dayCollapse ? Boolean(dayCollapse[k]) : k !== todayKey)
  // Day keys in view (for the collapse-all toggle in the header)
  const dayKeys = []
  {
    const seen = new Set()
    for (const r of rows) {
      if (r.lastActive == null) continue
      const k = dayKeyTs(r.lastActive)
      if (!seen.has(k)) { seen.add(k); dayKeys.push(k) }
    }
  }
  const allDaysCollapsed = dayKeys.length > 0 && dayKeys.every(k => isDayCollapsed(k))
  const sortedRows = (() => {
    if (curSort === 'activity') return rows // server order + day separators
    const val = SORTS[curSort].val
    const s = [...rows].sort((a, b) => val(a) - val(b))
    return curDir === 'asc' ? s : s.reverse()
  })()

  // Mini-histogram scale: max daily token total in the window.
  const histBuckets = buildHistogram(rows, range)
  const histMetricVal = useValue(histMetric)
  // Both maxima are computed (cheap) so switching the metric never needs
  // a rebuild — and the tooltip can always show both values.
  const histMaxTokens = histBuckets.reduce((m, b) => Math.max(m, b.tokens), 0)
  const histMaxCost = histBuckets.reduce((m, b) => Math.max(m, b.cost), 0)
  const histMax = histMetricVal === 'cost' ? histMaxCost : histMaxTokens

  // Aggregate over the unified rows (persistent = all rows in window).
  const grandInput = rows.reduce((s, r) => s + (r.u.input || 0), 0)
  const grandCached = rows.reduce((s, r) => s + (r.u.cache_read || 0), 0)
  const grandOutput = rows.reduce((s, r) => s + (r.u.output || 0), 0)
  // Sum of per-row cost estimates (null-safe: unpriced models contribute 0,
  // but we remember whether ANY row was unpriced so the total can show a ≈).
  let grandCost = 0
  let unpricedRows = 0
  for (const r of rows) {
    const c = estimateCost({ input: r.u.input, cache_read: r.u.cache_read, output: r.u.output, model: r.u.model, billing_provider: r.u.billing_provider })
    if (c != null) grandCost += c; else if ((r.u.input || 0) + (r.u.output || 0) > 0) unpricedRows++
  }

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-xs overflow-hidden',
    children: [
      // Header + history window selector
      jsxs('div', {
        className: 'flex items-center justify-between shrink-0',
        children: [
          jsx('span', { className: 'font-medium text-sm', children: 'Token Stats' }),
          jsxs('div', { className: 'flex items-center gap-1.5', children: [
            histOk === false
              ? jsx('span', {
                  className: 'text-[0.625rem] text-amber-500',
                  title: 'Ledger backend AND usage.history RPC unavailable — live sessions only.\nBackend: ~/.hermes/plugins/token-stats/ (plugin_api.py) + daemon: systemctl status token-stats-ledger',
                  children: 'live only' })
              : null,
            curSort === 'activity' && dayKeys.length > 0
              ? jsx('button', {
                  type: 'button',
                  title: allDaysCollapsed
                    ? 'Alle Tagesgruppen aufklappen'
                    : 'Alle Tagesgruppen zuklappen (Summenzeilen bleiben sichtbar)',
                  className: 'text-(--ui-text-quaternary) hover:bg-(--ui-stroke-secondary) rounded-sm px-1.5 py-0.5 text-[0.625rem] cursor-pointer mr-1',
                  onClick: () => {
                    const next = {}
                    // allDaysCollapsed → explicitly EXPAND every day
                    // (setting {} would restore the default, which keeps
                    // non-today days collapsed); else collapse all.
                    for (const k of dayKeys) next[k] = !allDaysCollapsed
                    collapsedDays.set(next)
                  },
                  children: allDaysCollapsed ? '▸▸' : '▾▾',
                }, 'collapseAll')
              : null,
            ...RANGE_PRESETS.map(p => jsx('button', {
              type: 'button',
              title: p.tip,
              className: (p.key === range
                ? 'bg-(--ui-accent) text-(--card)'
                : 'text-(--ui-text-quaternary) hover:bg-(--ui-stroke-secondary)') +
                ' rounded-sm px-1.5 py-0.5 text-[0.625rem] cursor-pointer',
              onClick: () => { historyRange.set(p.key) },
              children: p.label,
            }, p.key)),
          ]}),
        ]
      }),

      // Aggregate summary — aligned to the session table below (same
      // table-fixed column widths), so each value sits over its column.
      jsx('div', {
        className: 'shrink-0 rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5',
        children: jsxs('table', {
          className: 'w-full table-fixed border-collapse',
          children: [
            jsx('tbody', {
              children: [
                jsxs('tr', { className: 'text-(--ui-text-quaternary) text-[0.625rem] uppercase', children: [
                  jsx('td', { style: { width: W[0] + '%' }, children: 'Total' }),
                  jsx('td', { className: 'text-right px-1 tabular-nums font-medium', style: { width: W[1] + '%' }, children: fmt(grandInput) }),
                  jsx('td', {
                    className: 'text-right px-1 tabular-nums font-medium text-(--ui-accent)', style: { width: W[2] + '%' },
                    title: grandCached > 0 && grandInput + grandCached > 0
                      ? `${grandCached} of ${grandInput + grandCached} prompt tokens served from cache (${Math.round(grandCached / (grandInput + grandCached) * 100)}%)`
                      : undefined,
                    children: fmt(grandCached) }),
                  jsx('td', { className: 'text-right px-1 tabular-nums font-medium', style: { width: W[3] + '%' }, children: fmt(grandOutput) }),
                  jsx('td', {
                    className: 'text-right pl-1 tabular-nums font-medium', style: { width: W[4] + '%' },
                    title: grandCost > 0
                      ? `Known-Ledger, monoton · Estimated: ${(grandCost * EUR_RATE).toFixed(2)} € (USD ${grandCost.toFixed(2)})${unpricedRows > 0 ? ` — ${unpricedRows} unpriced session(s) excluded` : ''}`
                      : 'Known-Ledger, monoton',
                    children: grandCost > 0
                      ? `${unpricedRows > 0 ? '≈ ' : ''}${(grandCost * EUR_RATE).toFixed(2)} €`
                      : '—' }),
                ]}),
              ]
            })
          ]
        })
      }),
      // Cache-hit bar: visual share of cached vs. uncached prompt tokens.
      // Geometry/colors as INLINE STYLES — the desktop runtime's utility
      // generation proved unreliable for this element's class set
      // (h-[3px] et al. rendered nothing; inline styles always paint).
      grandInput + grandCached > 0
        ? jsx('div', {
            className: 'shrink-0',
            style: { marginTop: '-2px', paddingLeft: 8, paddingRight: 8 },
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between text-[0.625rem] text-(--ui-text-quaternary) mb-0.5',
                children: [
                  jsx('span', {
                    title: `Anteil der Prompt-Tokens, die aus dem Prompt-Cache kamen (statt neu berechnet)`,
                    children: '⚡ Cache-Hit' }),
                  jsx('span', {
                    className: 'tabular-nums',
                    title: `${fmt(grandCached)} von ${fmt(grandInput + grandCached)} Prompt-Tokens aus dem Cache`,
                    children: Math.round(grandCached / (grandInput + grandCached) * 100) + '%' }),
                ],
              }),
              jsx('div', {
                style: {
                  height: 3,
                  width: '100%',
                  borderRadius: 9999,
                  overflow: 'hidden',
                  background: 'var(--ui-stroke-secondary)',
                  display: 'flex',
                },
                children: jsx('div', {
                  style: {
                    height: '100%',
                    background: 'var(--ui-accent)',
                    width: Math.min(100, grandCached / (grandInput + grandCached) * 100) + '%',
                  },
                }),
              }),
            ],
          })
        : null,
      // Mini histogram: tokens (or cost) per day over the active window.
      // Skipped ONLY for the 1d preset (range === 'day' — one bar at 100%
      // carries no information). Other presets always render, even when
      // the window currently spans a single day (e.g. 5d/7d on a Monday:
      // their calendar windows start today 0:00).
      // Metric toggle (🪙/€): bar heights measure tokens or estimated
      // PAYG-equivalent cost; the tooltip always shows both.
      histOk && rows.length > 0 && range !== 'day'
        ? jsxs('div', {
            className: 'shrink-0',
            children: [
            jsxs('div', {
              className: 'flex items-center justify-between text-[0.625rem] text-(--ui-text-quaternary) mb-0.5',
              children: [
                jsx('span', {
                  title: 'Tages-Balken: Höhe relativ zum stärksten Tag im Fenster',
                  children: histMetricVal === 'cost' ? '€ pro Tag' : 'Tokens pro Tag' }),
                jsxs('div', { className: 'flex items-center gap-0.5', children: [
                  jsx('button', {
                    type: 'button',
                    title: 'Balkenhöhe = Tokens pro Tag',
                    // Selected: subtle accent tint. INLINE STYLES — the runtime's
                    // utility generation proved unreliable for exotic class sets
                    // (opacity-modified CSS-var utilities may not paint at all;
                    // lesson from the cache-hit bar). color-mix is supported by
                    // the app's Chromium. Emoji can't be recolored — a 15% tint
                    // keeps the glyph readable while marking the active state.
                    className: (histMetricVal !== 'cost'
                      ? ''
                      : 'text-(--ui-text-quaternary) hover:bg-(--ui-stroke-secondary)') +
                      ' rounded-sm px-1 py-0 text-[0.625rem] cursor-pointer',
                    style: histMetricVal !== 'cost' ? {
                      background: 'color-mix(in srgb, var(--ui-accent) 15%, transparent)',
                      color: 'var(--ui-accent)',
                      fontWeight: 500,
                    } : undefined,
                    onClick: () => { histMetric.set('tokens') },
                    children: '🪙' }, 'histTok'),
                  jsx('button', {
                    type: 'button',
                    title: 'Balkenhöhe = geschätzte Kosten (PAYG-Äquivalent) pro Tag',
                    className: (histMetricVal === 'cost'
                      ? ''
                      : 'text-(--ui-text-quaternary) hover:bg-(--ui-stroke-secondary)') +
                      ' rounded-sm px-1 py-0 text-[0.625rem] cursor-pointer',
                    style: histMetricVal === 'cost' ? {
                      background: 'color-mix(in srgb, var(--ui-accent) 15%, transparent)',
                      color: 'var(--ui-accent)',
                      fontWeight: 500,
                    } : undefined,
                    onClick: () => { histMetric.set('cost') },
                    children: '€' }, 'histCost'),
                ]}),
              ],
            }),
            jsx('div', {
            className: 'rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5',
            children: jsxs('div', {
              className: 'flex items-end gap-[2px] h-8',
              children: histBuckets.map(b => {
                const v = histMetricVal === 'cost' ? b.cost : b.tokens
                const h = histMax ? Math.max(4, Math.round(v / histMax * 100)) : 0
                return jsx('div', {
                  className: 'flex-1 flex flex-col justify-end h-full',
                  title: `${dayLabel(b.key)} · ${fmt(b.tokens)} Tokens · ≈ ${(b.cost * EUR_RATE).toFixed(2)} € · ${b.sessions} Sitzung${b.sessions === 1 ? '' : 'en'}`,
                  children: jsx('div', {
                    className: 'w-full rounded-sm',
                    style: {
                      height: (v === 0 ? 3 : h) + '%',
                      background: v === 0
                        ? 'color-mix(in srgb, var(--ui-accent) 30%, transparent)'
                        : 'var(--ui-accent)',
                    },
                  }),
                }, b.key)
              }),
            }),
          }),
          ],
          })
        : null,

      // Session list — min-h-0 so it can shrink when the model list below
      // takes vertical space.
      jsx('div', {
        className: 'flex-1 min-h-0 overflow-auto',
        children: rows.length === 0
          ? jsxs('div', {
              className: 'text-(--ui-text-quaternary) text-center py-4',
              children: [
                jsx('div', { className: 'text-base mb-1', children: '🌫️' }),
                EMPTY_MSG[range] || 'No sessions',
              ],
            })
          : jsxs('table', {
              className: 'w-full table-fixed border-collapse',
              children: [
                jsxs('thead', {
                  className: 'sticky top-0 bg-(--card) z-10',
                  children: [
                    jsxs('tr', { className: 'text-(--ui-text-quaternary) text-[0.625rem] uppercase', children: [
                      Th(0, 'text-left py-1 pr-2 font-normal truncate', 'Session', 'Sortieren: letzte Aktivität', 'activity'),
                      Th(1, 'text-right py-1 px-1 font-normal', 'In', 'Sortieren: Input-Tokens', 'in'),
                      Th(2, 'text-right py-1 px-1 font-normal', '⚡', 'Sortieren: Cache-Reads · Cached input tokens', 'cached'),
                      Th(3, 'text-right py-1 px-1 font-normal', 'Out', 'Sortieren: Output-Tokens', 'out'),
                      Th(4, 'text-right py-1 pl-1 font-normal', '💰', 'Sortieren: geschätzte Kosten · Estimated cost (client-side pricing table)', 'cost'),
                    ]})
                  ]
                }),
                jsx('tbody', {
                  children: (() => {
                    // Day separators (with per-day totals) only in the
                    // default activity sort — any other sort interleaves
                    // days, separators would lie.
                    const showDays = curSort === 'activity'
                    const out = []
                    let lastDay = null
                    const maxOut = sortedRows.reduce((m, r) => Math.max(m, r.u.output || 0), 0)
                    // Per-day aggregates for the separator totals row
                    const dayAgg = {}
                    if (showDays) {
                      for (const row of sortedRows) {
                        if (row.lastActive == null) continue
                        const k = dayKeyTs(row.lastActive)
                        const a = dayAgg[k] || (dayAgg[k] = { in: 0, cached: 0, out: 0, cost: 0, unpriced: 0 })
                        a.in += row.u.input || 0
                        a.cached += row.u.cache_read || 0
                        a.out += row.u.output || 0
                        if (row.cost != null) a.cost += row.cost
                        else if ((row.u.input || 0) + (row.u.output || 0) > 0) a.unpriced++
                      }
                    }
                    for (const row of sortedRows) {
                      if (showDays && row.lastActive != null) {
                        const key = dayKeyTs(row.lastActive)
                        if (key !== lastDay) {
                          lastDay = key
                          const a = dayAgg[key]
                          const daySessions = sortedRows.filter(r => r.lastActive != null && dayKeyTs(r.lastActive) === key).length
                          const isCollapsed = isDayCollapsed(key)
                          out.push(jsxs('tr', {
                            className: 'text-[0.625rem] text-(--ui-text-quaternary) border-b border-(--ui-stroke-secondary)/50 cursor-pointer select-none',
                            onClick: () => toggleDayCollapse(key),
                            title: `${dayLabel(key)} — ${fmtFull(a.in)} in · ${fmtFull(a.cached)} ⚡ · ${fmtFull(a.out)} out${a.cost > 0 ? ` · ${(a.cost * EUR_RATE).toFixed(2)} €` : ''}\n${isCollapsed ? 'Aufklappen' : 'Zuklappen'} (${daySessions} Sitzung${daySessions === 1 ? '' : 'en'})`,
                            children: [
                              jsxs('td', {
                                className: 'py-1 pr-2 font-medium',
                                children: [
                                  jsx('span', { className: 'inline-block w-2 mr-1 text-[0.5rem] leading-none', children: isCollapsed ? '▸' : '▾' }),
                                  dayLabel(key),
                                  isCollapsed
                                    ? jsx('span', { className: 'ml-1 font-normal', children: `(${daySessions})` })
                                    : null,
                                ] }),
                              jsx('td', { className: 'text-right px-1 py-1 tabular-nums', title: `Input gesamt: ${fmtFull(a.in)}`, children: fmt(a.in) }),
                              jsx('td', { className: 'text-right px-1 py-1 tabular-nums text-(--ui-accent)', title: `Cache-Reads gesamt: ${fmtFull(a.cached)}`, children: fmt(a.cached) }),
                              jsx('td', { className: 'text-right px-1 py-1 tabular-nums', title: `Output gesamt: ${fmtFull(a.out)}`, children: fmt(a.out) }),
                              jsx('td', {
                                className: 'text-right pl-1 py-1 tabular-nums',
                                title: a.cost > 0
                                  ? `Geschätzt: ${(a.cost * EUR_RATE).toFixed(2)} € (USD ${a.cost.toFixed(2)})${a.unpriced > 0 ? ` — ${a.unpriced} unbepreis${a.unpriced === 1 ? 'te Sitzung' : 'te Sitzungen'} ausgeschlossen` : ''}`
                                  : 'Keine Kosten für diesen Tag',
                                children: a.cost > 0
                                  ? `${a.unpriced > 0 ? '≈ ' : ''}${(a.cost * EUR_RATE).toFixed(2)} €`
                                  : '—' }),
                            ],
                          }, 'day-' + key))
                        }
                      }
                      // Skip session rows of collapsed day groups
                      if (showDays && row.lastActive != null && isDayCollapsed(dayKeyTs(row.lastActive))) continue
                      const u = usageFor(row)
                      const isFocused = row.id === focusedSid
                      const cached = u.cache_read || 0
                      const cost = estimateCost({ input: u.input, cache_read: cached, output: u.output, model: u.model, billing_provider: u.billing_provider })
                      // Per-model tooltip from persistent model rows (when present)
                      const modelTip = row.modelRows.length
                        ? '\nModelle: ' + row.modelRows
                            .map(m => `${m.model}${m.task ? ' (' + m.task + ')' : ''}: in ${fmt(m.input_tokens)}, ⚡ ${fmt(m.cache_read_tokens)}, out ${fmt(m.output_tokens)}`)
                            .join(' · ')
                        : ''
                      const resetTip = row.hadReset
                        ? '\n⚠ DB-Reset erkannt — Werte aus dem Known-Ledger (monoton)'
                        : ''
                      // Relative-size bar behind the Out cell (vs. the
                      // largest session in view). INLINE STYLES — opacity-
                      // modified CSS-var utilities don't reliably paint in
                      // the desktop runtime (same lesson as cache-hit bar).
                      const outBar = maxOut > 0 && (u.output || 0) > 0
                        ? jsx('div', {
                            className: 'absolute inset-y-[3px] right-0 rounded-sm z-0',
                            style: {
                              width: Math.max(4, (u.output / maxOut) * 100) + '%',
                              background: 'color-mix(in srgb, var(--ui-accent) 10%, transparent)',
                            },
                          })
                        : null
                      out.push(jsxs('tr', {
                        className: isFocused
                          ? 'border-l-2 border-(--ui-accent)'
                          : 'border-b border-(--ui-stroke-secondary)/50',
                        // Focused-row tint as INLINE STYLE — the /10 opacity
                        // utility doesn't reliably paint (same lesson).
                        style: isFocused
                          ? { background: 'color-mix(in srgb, var(--ui-accent) 10%, transparent)' }
                          : undefined,
                        children: [
                          jsxs('td', {
                            className: 'py-1 pr-2 truncate',
                            title: (row.title || row.id) + (row.lastActive ? ` (${fmtDate(row.lastActive)})` : '') + resetTip + modelTip,
                            children: [
                              row.hadReset
                                ? jsx('span', { className: 'text-amber-500 mr-1', title: 'DB-Reset/Anomalie im Ledger verzeichnet — known-Werte bleiben monoton', children: '⚠' })
                                : null,
                              row.isLiveOnly
                                ? jsx('span', { className: 'text-(--ui-text-quaternary) mr-1', title: 'Live session (not yet persisted)', children: '●' })
                                : null,
                              row.title || row.id.slice(0, 12),
                            ]
                          }),
                          jsx('td', { className: 'text-right py-1 px-1 tabular-nums text-(--ui-text-secondary)', children: fmt(u.input || 0) }),
                          jsx('td', {
                            className: 'text-right py-1 px-1 tabular-nums text-(--ui-text-secondary)',
                            title: cached > 0
                              ? `Cached: ${fmtFull(cached)}${u.cache_hit_pct != null ? ` · Hit: ${u.cache_hit_pct}%` : ''}`
                              : undefined,
                            children: cached > 0
                              ? jsx('span', { className: 'text-(--ui-accent)', children: fmt(cached) })
                              : jsx('span', { className: 'text-(--ui-text-quaternary)', children: '—' }),
                          }),
                          jsxs('td', {
                            className: 'relative text-right py-1 px-1 tabular-nums text-(--ui-text-secondary)',
                            title: maxOut > 0 ? `Output relativ zur größten Session (${fmt(maxOut)})` : undefined,
                            children: [
                              outBar,
                              jsx('span', { className: 'relative z-10', children: fmt(u.output || 0) }),
                            ]
                          }),
                          jsx('td', {
                            className: 'text-right py-1 pl-1 tabular-nums text-(--ui-text-quaternary)',
                            title: cost != null
                              ? `Estimated: ${(cost * EUR_RATE).toFixed(2)} € (USD ${cost.toFixed(4)})${modelTip}`
                              : 'No price for ' + (u.model || 'this model'),
                            children: cost != null
                              ? (cost * EUR_RATE).toFixed(2) + ' €'
                              : jsx('span', { className: 'text-(--ui-text-quaternary)', children: '—' }),
                          }),
                        ]
                      }, row.id))
                    }
                    return out
                  })()
                })
              ]
            })
      }),
      // Per-model breakdown (footer "N Modelle" toggle). Pinned to the
      // BOTTOM of the pane, directly above the footer — the session list
      // above shrinks instead. Compact rows: one total-token number (the
      // breakdown ⚡/In/Out lives in the tooltip).
      modelListOpenVal && histOk && modelAggList.length > 0
        ? jsxs('div', {
            className: 'shrink-0',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between text-[0.625rem] text-(--ui-text-quaternary) mb-0.5 px-0.5',
                children: [
                  jsx('span', { className: 'uppercase', children: 'Modelle' }),
                  jsx('span', { className: 'tabular-nums', children: `${modelAggList.length} Modell${modelAggList.length === 1 ? '' : 'e'}` }),
                ],
              }),
              jsxs('div', {
                className: 'rounded-md border border-(--ui-stroke-secondary) divide-y divide-(--ui-stroke-secondary)/50 max-h-40 overflow-auto',
                children: modelAggList.map(m => {
                  const total = m.in + m.cached + m.out
                  const mCost = m.cost > 0 ? (m.cost * EUR_RATE).toFixed(2) + ' €' : null
                  const tip = m.sessions.size === 1 ? '1 Sitzung' : `${m.sessions.size} Sitzungen`
                  // Relative-size bar behind the row (vs. the largest model
                  // in view) — same visual as the session-table Out bars.
                  // INLINE-STYLES (thin deco element, see AI-HELPER lesson).
                  const bar = maxModelTotal > 0 && total > 0
                    ? jsx('div', {
                        style: {
                          position: 'absolute', top: 3, bottom: 3, left: 0,
                          borderRadius: 2,
                          background: 'var(--ui-accent)', opacity: 0.1,
                          width: Math.max(4, total / maxModelTotal * 100) + '%',
                        },
                      })
                    : null
                  return jsxs('div', {
                    className: 'relative flex items-center justify-between gap-2 px-2 py-1 overflow-hidden',
                    title: `${m.model}\nIn: ${fmtFull(m.in)} · ⚡: ${fmtFull(m.cached)} · Out: ${fmtFull(m.out)}\nGesamt: ${fmtFull(total)} Tokens · Calls: ${fmtFull(m.calls)} · ${tip}${mCost != null ? ` · Geschätzt: ${(m.cost * EUR_RATE).toFixed(2)} € (USD ${m.cost.toFixed(2)})` : (m.unpriced ? ' · kein Preis' : '')}`,
                    children: [
                      bar,
                      jsxs('div', { className: 'relative z-10 flex items-baseline gap-1.5 min-w-0', children: [
                        jsx('span', { className: 'truncate font-medium', children: m.model }),
                        jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary) shrink-0', children: tip }),
                      ]}),
                      jsxs('div', { className: 'relative z-10 flex items-center gap-2 shrink-0 tabular-nums text-(--ui-text-secondary)', children: [
                        jsx('span', { title: `Gesamttokens: ${fmtFull(total)}`, children: fmt(total) }),
                        jsx('span', {
                          className: 'text-(--ui-text-quaternary) min-w-[3.5rem] text-right',
                          children: mCost != null ? (m.unpriced ? '≈ ' : '') + mCost : '—',
                        }),
                      ]}),
                    ],
                  }, m.model)
                }),
              }),
            ],
          })
        : null,

      // Subagent breakdown (footer "N Subagenten" toggle). Same pattern as
      // the model list: bottom-pinned, compact total-token rows with
      // relative bars, breakdown in the tooltip.
      subListOpenVal && histOk && subRows.length > 0
        ? jsxs('div', {
            className: 'shrink-0',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between text-[0.625rem] text-(--ui-text-quaternary) mb-0.5 px-0.5',
                children: [
                  jsx('span', { className: 'uppercase', children: 'Subagenten' }),
                  jsx('span', { className: 'tabular-nums', children: `${subRows.length} Subagent${subRows.length === 1 ? '' : 'en'}` }),
                ],
              }),
              jsxs('div', {
                className: 'rounded-md border border-(--ui-stroke-secondary) divide-y divide-(--ui-stroke-secondary)/50 max-h-40 overflow-auto',
                children: subRows.map(sr => {
                  const total = sr.in + sr.cached + sr.out
                  const bar = maxSubTotal > 0 && total > 0
                    ? jsx('div', {
                        style: {
                          position: 'absolute', top: 3, bottom: 3, left: 0,
                          borderRadius: 2,
                          background: 'var(--ui-accent)', opacity: 0.1,
                          width: Math.max(4, total / maxSubTotal * 100) + '%',
                        },
                      })
                    : null
                  return jsxs('div', {
                    className: 'relative flex items-center justify-between gap-2 px-2 py-1 overflow-hidden',
                    title: `${sr.title}\n${sr.id}${sr.parent ? `\nParent: ${sr.parent}` : ''}\nIn: ${fmtFull(sr.in)} · ⚡: ${fmtFull(sr.cached)} · Out: ${fmtFull(sr.out)}\nGesamt: ${fmtFull(total)} Tokens · Calls: ${fmtFull(sr.calls)}`,
                    children: [
                      bar,
                      jsxs('div', { className: 'relative z-10 flex items-baseline gap-1.5 min-w-0', children: [
                        jsx('span', { className: 'truncate font-medium', children: sr.title }),
                        sr.parent ? jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary) shrink-0', children: '↳ Parent' }) : null,
                      ]}),
                      jsxs('div', { className: 'relative z-10 flex items-center gap-2 shrink-0 tabular-nums text-(--ui-text-secondary)', children: [
                        jsx('span', { title: `Gesamttokens: ${fmtFull(total)}`, children: fmt(total) }),
                      ]}),
                    ],
                  }, sr.id)
                }),
              }),
            ],
          })
        : null,

      // Footer: session/model counts + active calendar window. The model
      // count is a toggle for the per-model list above.
      jsxs('div', {
        className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary) text-center pt-1',
        children: [
          `${rows.length} Sitzung${rows.length === 1 ? '' : 'en'} · `,
          jsxs('button', {
            type: 'button',
            title: modelListOpenVal
              ? 'Modell-Liste zuklappen'
              : 'Modell-Liste aufklappen (auf- und absteigend über das aktive Fenster)',
            className: (modelListOpenVal
              ? 'text-(--ui-text-secondary) font-medium'
              : 'hover:text-(--ui-text-secondary)') +
              ' cursor-pointer underline decoration-(--ui-stroke-secondary) decoration-dotted underline-offset-2',
            onClick: () => { modelListOpen.set(!modelListOpenVal) },
            children: `${modelAggList.length} Modell${modelAggList.length === 1 ? '' : 'e'}`,
          }, 'modelToggle'),
          subRows.length > 0
            ? [' · ',
               jsxs('button', {
                 type: 'button',
                 title: subListOpenVal
                   ? 'Subagenten-Liste zuklappen'
                   : 'Subagenten-Liste aufklappen (delegierte Tasks im aktiven Fenster)',
                 className: (subListOpenVal
                   ? 'text-(--ui-text-secondary) font-medium'
                   : 'hover:text-(--ui-text-secondary)') +
                   ' cursor-pointer underline decoration-(--ui-stroke-secondary) decoration-dotted underline-offset-2',
                 onClick: () => { subListOpen.set(!subListOpenVal) },
                 children: `${subRows.length} Subagent${subRows.length === 1 ? '' : 'en'}`,
               }, 'subToggle')]
            : null,
          histOk ? ` · ${windowLabel(range)}` : '',
        ],
      }),
    ]
  })
}

// ── Plugin export ───────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Token Stats',
  register(ctx) {
    // Known-ledger backend handle (namespace /api/plugins/token-stats/ —
    // our own ID, so ctx.rest can reach it). Null-safe: fetchLedger falls
    // back to the usage.history RPC when this is unset or errors (OAuth
    // remotes resolve ctx.rest to a no-op).
    restApi = (path, opts) => ctx.rest(path, opts)

    // Load persisted chip visibility (sync seed before first render)
    const saved = ctx.storage.get('chipShow', null)
    if (saved && typeof saved === 'object') {
      const next = { ...DEFAULT_SHOW }
      for (const k of SHOW_KEYS) if (k in saved) next[k] = Boolean(saved[k])
      showMap.set(next)
    }
    // Persist on every toggle
    showMap.listen(map => { ctx.storage.set('chipShow', map) })

    // Column widths: seed from storage, persist on change
    const savedW = ctx.storage.get('colWidths', null)
    if (Array.isArray(savedW) && savedW.length === DEFAULT_COLW.length && savedW.every(n => Number.isFinite(n))) {
      colWidths.set(savedW.map(Number))
    }
    colWidths.listen(w => { ctx.storage.set('colWidths', w) })

    // Seed usage from session.info events (covers sessions that have been active)
    host.onEvent('session.info', (ev) => {
      const sid = ev?.session_id
      const usage = ev?.payload?.usage
      if (sid && usage) mergeUsage(sid, usage)
    })

    // Live usage updates during turns
    host.onEvent('session.usage', (ev) => {
      const sid = ev?.session_id
      const usage = ev?.payload?.usage
      if (sid && usage) mergeUsage(sid, usage)
    })

    // Also listen to message.complete for final usage of a turn
    host.onEvent('message.complete', (ev) => {
      const sid = ev?.session_id
      const usage = ev?.payload?.usage
      if (sid && usage) mergeUsage(sid, usage)
    })

    // Statusbar chip — compact live token counter with config menu
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(TokenChip, {})
    })

    // Pane — full session table
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Token Stats',
      data: { placement: 'right', width: '380px' },
      render: () => jsx(TokenPane, {})
    })
  }
}
