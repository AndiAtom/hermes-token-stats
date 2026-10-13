/**
 * Tests for the i18n + currency layer (v5.0.0).
 *
 * Run: node --test test_i18n.mjs
 * (stdlib node:test — no deps; extracts the I18N block from plugin.js via
 * the same safe new Function() pattern as test_prices.mjs. SAFE here: the
 * function body is assembled only from slices of our own repo file on
 * disk — no runtime/untrusted input is ever interpolated into the body.)
 *
 * Covers:
 *  - key-set parity across all 5 languages (en/de/fr/nl/it)
 *  - plural function forms (sessions, models, subagents, auxTasks, unpriced)
 *  - de wording stays byte-identical to the pre-v5 hardcoded strings
 *  - fmtCost EUR/USD with fixed EUR_RATE (float tolerance 1e-9)
 *  - localStorage validation via initLS (invalid/unavailable → fallback)
 *  - localeFor mapping
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8')

// ── Extraction helpers ───────────────────────────────────────────────
// Slice a function/const out of plugin.js: from its declaration to the
// first line that is exactly '}' (top-level closing brace).
const sliceToCloseBrace = (from) => {
  const i = src.indexOf(from)
  assert.ok(i > 0, `marker not found: ${from}`)
  const end = src.indexOf('\n}', i)
  assert.ok(end > i, `closing brace not found: ${from}`)
  return src.slice(i, end + 2)
}

// Stub for the plugin-sdk atom(): a tiny get/set cell. LANG/CURRENCY are
// created with initLS(...) — the stub ignores the initial value semantics,
// tests drive state via .set().
const stubAtom = () => {
  let v
  return { get: () => v, set: (x) => { v = x } }
}

// ── Extract the I18N layer ───────────────────────────────────────────
// Pieces: LANGS/LANG_LABELS/LOCALES consts, initLS + lsSet, the I18N
// table, then localeFor/tRaw/t, then fmtCost (+ its EUR_RATE dependency,
// which lives ABOVE the Helpers marker in plugin.js).
const constBlock = src.slice(
  src.indexOf('const LANGS ='),
  src.indexOf('\n}', src.indexOf('function lsSet(')) + 2,
)
const i18nTable = src.slice(src.indexOf('const I18N = {'), src.indexOf('const LANG = atom('))
const helpers = src.slice(src.indexOf('function localeFor'), src.indexOf('\n}', src.indexOf('function t(key, ...args)')) + 2)
const eurRateLine = sliceToCloseBrace('const EUR_RATE =') + '\n'
const fmtCostFn = sliceToCloseBrace('function fmtCost(')

const buildI18n = (localStorage) => {
  const atom = stubAtom
  const api = new Function('atom', 'localStorage', `'use strict';
    ${eurRateLine}
    ${constBlock}
    ${i18nTable}
    const LANG = atom();
    const CURRENCY = atom();
    ${helpers}
    ${fmtCostFn}
    return {
      LANG, CURRENCY, LANGS, LANG_LABELS, LOCALES, I18N,
      localeFor, initLS, t, fmtCost, EUR_RATE,
    };
  `)(atom, localStorage)
  return api
}

// node has no localStorage — initLS must try/catch to the fallback.
const noLS = { getItem: () => { throw new Error('no localStorage') }, setItem: () => {} }
const api = buildI18n(noLS)

// ── Key parity ───────────────────────────────────────────────────────

test('I18N covers exactly the 5 languages (en default)', () => {
  assert.deepEqual(Object.keys(api.I18N).sort(), ['de', 'en', 'fr', 'it', 'nl'])
  assert.deepEqual([...api.LANGS].sort(), ['de', 'en', 'fr', 'it', 'nl'])
})

test('key sets are identical across all languages', () => {
  const ref = Object.keys(api.I18N.en).sort()
  assert.ok(ref.length >= 70, `en dictionary is substantial (${ref.length} keys)`)
  for (const lang of ['de', 'fr', 'nl', 'it']) {
    assert.deepEqual(
      Object.keys(api.I18N[lang]).sort(),
      ref,
      `${lang} dictionary keys deviate from en`,
    )
  }
})

test('no empty string values anywhere', () => {
  for (const [lang, dict] of Object.entries(api.I18N)) {
    for (const [k, v] of Object.entries(dict)) {
      if (typeof v === 'string') assert.ok(v.length > 0, `${lang}.${k} is empty`)
    }
  }
})

// ── t() fallback chain ───────────────────────────────────────────────

test('t() falls back active lang → en → de → key', () => {
  api.LANG.set('en')
  assert.equal(api.t('today'), 'Today')
  api.LANG.set('de')
  assert.equal(api.t('today'), 'Heute')
  api.LANG.set('fr')
  assert.equal(api.t('today'), "Aujourd’hui")
  // missing key in every dict → key itself
  assert.equal(api.t('definitely-not-a-key'), 'definitely-not-a-key')
  // fr fallback for a key missing from fr would hit en — synthesize:
  // (all dicts are parity-checked above, so test the en-fallback step
  // by deleting a key from the in-memory copy)
  api.I18N.fr.today = undefined
  assert.equal(api.t('today'), 'Today', 'fr missing key → en fallback')
  api.I18N.en.today = undefined
  assert.equal(api.t('today'), 'Heute', 'en missing key → de fallback')
})

// ── Plural forms ─────────────────────────────────────────────────────

test('plural function values differ for n=1 vs n=2 in every language', () => {
  for (const lang of api.LANGS) {
    const d = api.I18N[lang]
    for (const key of ['sessions', 'models', 'subagents', 'auxTasks', 'unpricedExcluded']) {
      assert.equal(typeof d[key], 'function', `${lang}.${key} is a plural fn`)
      assert.notEqual(d[key](1), d[key](2), `${lang}.${key} differs 1 vs 2`)
    }
  }
})

test('de plural forms stay byte-identical to pre-v5 wording', () => {
  assert.equal(api.I18N.de.sessions(1), 'Sitzung')
  assert.equal(api.I18N.de.sessions(2), 'Sitzungen')
  assert.equal(api.I18N.de.models(1), 'Modell')
  assert.equal(api.I18N.de.models(2), 'Modelle')
  assert.equal(api.I18N.de.subagents(1), 'Subagent')
  assert.equal(api.I18N.de.subagents(2), 'Subagenten')
  assert.equal(api.I18N.de.auxTasks(1), 'Aux-Task')
  assert.equal(api.I18N.de.auxTasks(2), 'Aux-Tasks')
})

test('de reference strings survived extraction (spot check)', () => {
  assert.equal(api.I18N.de.today, 'Heute')
  assert.equal(api.I18N.de.yesterday, 'Gestern')
  assert.equal(api.I18N.de.empty_day, 'Noch keine Sitzungen heute')
  assert.equal(api.I18N.de.noCostDay, 'Keine Kosten für diesen Tag')
  assert.equal(api.I18N.de.estimated, 'Geschätzt')
})

// ── fmtCost ──────────────────────────────────────────────────────────

test('fmtCost: EUR default with EUR_RATE, de-DE locale (tolerance 1e-9)', () => {
  api.LANG.set('de')
  api.CURRENCY.set('EUR')
  const usd = 12.3456
  const expect = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(usd * api.EUR_RATE) + ' €'
  assert.ok(Math.abs(usd * api.EUR_RATE - 12.3456 * 0.85) < 1e-9)
  assert.equal(api.fmtCost(usd), expect)
  // full adds the USD parenthetical — ONLY in EUR mode
  assert.equal(api.fmtCost(usd, { full: true }), expect + ' (USD 12.35)')
})

test('fmtCost: USD mode renders $ directly, no parenthetical even with full', () => {
  api.LANG.set('en')
  api.CURRENCY.set('USD')
  const usd = 4.2
  const expect = '$' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd)
  assert.equal(api.fmtCost(usd), expect)
  assert.equal(api.fmtCost(usd, { full: true }), expect)
  // numOnly is a EUR-only option (the chip splits number and the faint
  // ' €' suffix span; in USD the chip renders fmtCost() directly). In
  // USD mode numOnly is a documented no-op — production never passes it.
  assert.equal(api.fmtCost(usd, { numOnly: true }), expect)
})

test('fmtCost: EUR mode numOnly returns the bare number', () => {
  api.LANG.set('de')
  api.CURRENCY.set('EUR')
  const num = api.fmtCost(3.14159, { numOnly: true })
  assert.ok(!num.includes('€'), 'numOnly strips the unit')
  assert.ok(num.includes(','), 'de-DE decimal comma')
})

// ── initLS validation ─────────────────────────────────────────────────

const initLSFactory = (localStorage) => new Function('localStorage', `'use strict';
    ${src.slice(src.indexOf('function initLS('), src.indexOf('\n}', src.indexOf('function initLS(')) + 2)}
    return initLS;
  `)(localStorage)

test('initLS: valid value passes through', () => {
  const store = { 'token-stats:lang': 'de' }
  const f = initLSFactory({ getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v } })
  assert.equal(f('token-stats:lang', ['en', 'de', 'fr', 'nl', 'it'], 'en'), 'de')
  assert.equal(f('token-stats:currency', ['EUR', 'USD'], 'EUR'), 'EUR')
})

test('initLS: invalid value falls back to default', () => {
  const f = initLSFactory({ getItem: () => 'xx-invalid', setItem: () => {} })
  assert.equal(f('token-stats:lang', ['en', 'de', 'fr', 'nl', 'it'], 'en'), 'en')
  assert.equal(f('token-stats:currency', ['EUR', 'USD'], 'EUR'), 'EUR')
})

test('initLS: missing/unavailable localStorage → fallback (private mode)', () => {
  const f = initLSFactory(noLS)
  assert.equal(f('token-stats:lang', ['en', 'de', 'fr', 'nl', 'it'], 'en'), 'en')
  assert.equal(f('token-stats:currency', ['EUR', 'USD'], 'EUR'), 'EUR')
})

// ── localeFor ────────────────────────────────────────────────────────

test('localeFor maps every language to an ICU locale', () => {
  assert.equal(api.localeFor('de'), 'de-DE')
  assert.equal(api.localeFor('en'), 'en-US')
  assert.equal(api.localeFor('fr'), 'fr-FR')
  assert.equal(api.localeFor('nl'), 'nl-NL')
  assert.equal(api.localeFor('it'), 'it-IT')
  assert.equal(api.localeFor('unknown'), 'en-US')
})
