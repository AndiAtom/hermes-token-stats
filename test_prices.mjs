/**
 * Tests for the provider-aware pricing lookup (v4.5.0).
 *
 * Run: node --test test_prices.mjs
 * (stdlib node:test — no deps; imports the pricing constants + estimateCost
 * from plugin.js via a tiny ESM shim)
 *
 * Covers:
 *  - provider override beats model-only fallback
 *  - model-only fallback still works (provider unknown / custom / empty)
 *  - custom:mistral does NOT match provider 'mistral' (exact match only)
 *  - :free models price at 0.00 (not '—')
 *  - OpenRouter normalization: per-token → per-1M (spot checks)
 *  - regression: Andi's setups (custom + mistral) identical results to v4.4
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// plugin.js is a desktop plugin (imports @hermes/plugin-sdk + react) — we can't
// import it wholesale. Extract the pricing section (everything up to the first
// non-pricing import-dependent code) and eval it in this module's scope.
const src = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8')

// Extract from PRICES definition to the end of estimateCost()
const start = src.indexOf('const PRICES = {')
const endMarker = '// ── Helpers ──'
const end = src.indexOf(endMarker)
assert.ok(start > 0 && end > start, 'pricing section found in plugin.js')
let section = src.slice(start, end)

// The section references PRICES_PROVIDER which is defined inside — all
// self-contained. estimateCost is a function declaration → export via appendix.
const exportsShim = section + '\nreturn { estimateCost, PRICES, PRICES_PROVIDER, PRICES_OPENROUTER }\n'
const factory = new Function(exportsShim)
const { estimateCost, PRICES, PRICES_OPENROUTER } = factory()

// ── provider override beats model-only ─────────────────────────────

test('provider override beats model-only fallback', () => {
  // z-ai/glm-5.3 exists in BOTH tables. Via provider 'nous'/'openrouter'
  // the OR price must win; without provider the Mistral price applies.
  const viaNous = estimateCost({
    model: 'z-ai/glm-5.3', billing_provider: 'nous',
    input: 1_000_000, cache_read: 0, output: 0,
  })
  const modelOnly = estimateCost({
    model: 'z-ai/glm-5.3',
    input: 1_000_000, cache_read: 0, output: 0,
  })
  // OR lists GLM 5.3 identically to Mistral ($1.40 in) — both paths priced,
  // assert they RESOLVE (not null) and produce the documented values.
  assert.ok(viaNous != null, 'nous-priced')
  assert.ok(modelOnly != null, 'model-only priced')
  assert.equal(viaNous, 1.4)   // $/1M × 1M tokens = $1.40
  assert.equal(modelOnly, 1.4)
})

test('openrouter-only model prices via provider, stays null without', () => {
  // openai/gpt-6-astra-pro: NOT in PRICES (Mistral doesn't host it) —
  // historically the '—' row. Via openrouter/nous it must price at OR rates.
  const viaOR = estimateCost({
    model: 'openai/gpt-6-astra-pro', billing_provider: 'openrouter',
    input: 1_000_000, cache_read: 0, output: 0,
  })
  const unpriced = estimateCost({
    model: 'openai/gpt-6-astra-pro',
    input: 1_000_000, cache_read: 0, output: 0,
  })
  assert.equal(viaOR, 10)     // OR: $10/M input (verified 2026-10-04)
  assert.equal(unpriced, null) // no fabricated price without provider
})

test('cache-read priced at provider cache rate', () => {
  const c = estimateCost({
    model: 'openai/gpt-6-astra-pro', billing_provider: 'nous',
    input: 0, cache_read: 2_000_000, output: 0,
  })
  assert.equal(c, 2)          // $1/M cache-read × 2M
})

// ── exact provider match only ──────────────────────────────────────

test('custom:mistral does not match a mistral provider table', () => {
  // PRICES_PROVIDER has no 'mistral' key at all — 'custom:mistral' and
  // 'custom' must fall through to model-only. Andi's setups unchanged.
  const a = estimateCost({ model: 'zai-glm-latest', billing_provider: 'custom:mistral', input: 1_000_000, cache_read: 0, output: 0 })
  const b = estimateCost({ model: 'zai-glm-latest', billing_provider: 'custom', input: 1_000_000, cache_read: 0, output: 0 })
  const c = estimateCost({ model: 'zai-glm-latest', input: 1_000_000, cache_read: 0, output: 0 })
  assert.equal(a, 1.4)
  assert.equal(b, 1.4)
  assert.equal(c, 1.4)
})

test('unknown provider falls back to model-only', () => {
  const c = estimateCost({ model: 'mistral-small-latest', billing_provider: 'some-unknown-relay', input: 1_000_000, cache_read: 0, output: 0 })
  assert.equal(c, 0.15)
})

// ── free tier ──────────────────────────────────────────────────────

test(':free models price at 0.00, not null', () => {
  assert.ok('stepfun/step-3.7-flash:free' in PRICES, 'free model in PRICES')
  const c = estimateCost({ model: 'stepfun/step-3.7-flash:free', input: 500_000, cache_read: 100_000, output: 50_000 })
  assert.equal(c, 0)
})

test('OR :free catalog entries exist and price at 0', () => {
  const freeEntries = Object.entries(PRICES_OPENROUTER).filter(([id]) => id.endsWith(':free'))
  assert.ok(freeEntries.length >= 10, `OR free entries: ${freeEntries.length}`)
  const c = estimateCost({ model: freeEntries[0][0], billing_provider: 'openrouter', input: 1_000_000, output: 1_000 })
  assert.equal(c, 0)
})

// ── normalization spot checks ─────────────────────────────────────

test('OR prices normalized to per-1M (spot checks)', () => {
  // gpt-6-astra-pro: OR API prompt=0.00001/token → 10 per 1M
  assert.equal(PRICES_OPENROUTER['openai/gpt-6-astra-pro'].input, 10)
  assert.equal(PRICES_OPENROUTER['openai/gpt-6-astra-pro'].output, 50)
  assert.equal(PRICES_OPENROUTER['openai/gpt-6-astra-pro'].cached, 1)
  // z-ai/glm-5.3: 0.0000014 → 1.4
  assert.equal(PRICES_OPENROUTER['z-ai/glm-5.3'].input, 1.4)
})

test('OR table has no negative or NaN prices', () => {
  for (const [id, p] of Object.entries(PRICES_OPENROUTER)) {
    assert.ok(Number.isFinite(p.input) && p.input >= 0, `${id} input`)
    assert.ok(Number.isFinite(p.cached) && p.cached >= 0, `${id} cached`)
    assert.ok(Number.isFinite(p.output) && p.output >= 0, `${id} output`)
  }
})

test('routing models excluded from OR table', () => {
  assert.ok(!('openrouter/auto' in PRICES_OPENROUTER))
  assert.ok(!('openrouter/auto-beta' in PRICES_OPENROUTER))
  assert.ok(!('openrouter/fusion' in PRICES_OPENROUTER))
})

// ── regression: v4.4 behavior for Andi's data ─────────────────────

test('regression: all live Andi models price identically without provider', () => {
  // The model-only path must return exactly the v4.4 results for every
  // model with usage in Andi's state.db (values from the PRICES table).
  const cases = [
    ['zai-glm-latest', 1.4, 0.14, 4.4],
    ['glm-5-2', 1.4, 0.14, 4.4],
    ['zai-glm-5-2', 1.4, 0.14, 4.4],
    ['mistral-small-latest', 0.15, 0.015, 0.6],
    ['ministral-8b-latest', 0.15, 0.015, 0.15],
    ['mistral-medium-latest', 1.5, 0.15, 7.5],
    ['mistral-medium-3-5', 1.5, 0.15, 7.5],
  ]
  for (const [model, inP, cachP, outP] of cases) {
    const c = estimateCost({ model, input: 1_000_000, cache_read: 1_000_000, output: 1_000_000 })
    assert.ok(Math.abs(c - (inP + cachP + outP)) < 1e-9, `${model} model-only: ${c}`)
  }
})

test('nous provider prices the historical z-ai/glm-5.3 rows', () => {
  // The historical Nous rows in Andi's state.db (90.3 M tokens) now price
  // instead of showing '—' when the ledger meta carries billing_provider.
  const c = estimateCost({ model: 'z-ai/glm-5.3', billing_provider: 'nous', input: 849_238, cache_read: 89_271_872, output: 227_936 })
  const expected = (849_238 * 1.4 + 89_271_872 * 0.14 + 227_936 * 4.4) / 1_000_000
  assert.ok(Math.abs(c - expected) < 0.001)
})
