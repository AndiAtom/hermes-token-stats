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

// USD → EUR conversion factor (Mistral La Plateforme lists GLM 5.2 at
// $1.40 / €1.19 → 0.85). Update when the official EUR listing shifts.
const EUR_RATE = 0.85

// Estimate session cost from usage fields. Returns null when the model is
// unpriced (never fabricate a number) or usage is missing.
function estimateCost(u) {
  if (!u) return null
  const model = String(u.model || '').trim()
  const p = PRICES[model]
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
    buckets.push({ key, tokens: 0, sessions: 0 })
  }
  const todayKey = dayKeyDate(new Date())
  for (const r of rows) {
    const key = r.lastActive != null ? dayKeyTs(r.lastActive) : todayKey
    const i = idx[key]
    if (i == null) continue
    buckets[i].tokens += (r.u.input || 0) + (r.u.cache_read || 0) + (r.u.output || 0)
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
  const cost = estimateCost({ input, cache_read: cached, output: out, model })

  return jsxs('div', {
    className: 'relative inline-flex h-full items-center',
    children: [
      jsxs('button', {
        type: 'button',
        className: 'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) tabular-nums cursor-pointer hover:text-(--ui-text-secondary)',
        title: `Token Stats v4.2 · Click: configure display · drag header edges to resize pane columns${isPersisted ? ' · 📚 Known-Ledger values (monotonic)' : ''}\n\nInput: ${fmtFull(input)} · Cached: ${fmtFull(cached)}${hitPct != null ? ` (${hitPct}%)` : ''} · Output: ${fmtFull(out)} · Total: ${fmtFull(total)}`
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
      },
    })
  }

  const usageFor = (row) => {
    if (row.id === focusedSid && breakdown) return { ...row.u, ...breakdown }
    return row.u
  }

  // Per-row cost (needed for the cost sort key; same estimate as the cell).
  for (const r of rows) {
    r.cost = estimateCost({ input: r.u.input, cache_read: r.u.cache_read, output: r.u.output, model: r.u.model })
  }

  // Sorted view (SORTS defaults = server's activity order).
  const curSort = useValue(sortBy)
  const curDir = useValue(sortDir)
  const sortedRows = (() => {
    if (curSort === 'activity') return rows // server order + day separators
    const val = SORTS[curSort].val
    const s = [...rows].sort((a, b) => val(a) - val(b))
    return curDir === 'asc' ? s : s.reverse()
  })()

  // Mini-histogram scale: max daily token total in the window.
  const histBuckets = buildHistogram(rows, range)
  const histMax = histBuckets.reduce((m, b) => Math.max(m, b.tokens), 0)

  // Aggregate over the unified rows (persistent = all rows in window).
  const grandInput = rows.reduce((s, r) => s + (r.u.input || 0), 0)
  const grandCached = rows.reduce((s, r) => s + (r.u.cache_read || 0), 0)
  const grandOutput = rows.reduce((s, r) => s + (r.u.output || 0), 0)
  // Sum of per-row cost estimates (null-safe: unpriced models contribute 0,
  // but we remember whether ANY row was unpriced so the total can show a ≈).
  let grandCost = 0
  let unpricedRows = 0
  for (const r of rows) {
    const c = estimateCost({ input: r.u.input, cache_read: r.u.cache_read, output: r.u.output, model: r.u.model })
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
                  title: 'Ledger backend AND usage.history RPC unavailable — live sessions only.\nBackend: /root/.hermes/plugins/token-stats/ (plugin_api.py) + daemon: systemctl status token-stats-ledger',
                  children: 'live only' })
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
      // Cache-hit bar: visual share of cached vs. uncached prompt tokens
      grandInput + grandCached > 0
        ? jsx('div', {
            className: 'shrink-0 -mt-1 px-2',
            title: `Cache-Hit: ${Math.round(grandCached / (grandInput + grandCached) * 100)}% — ${fmt(grandCached)} von ${fmt(grandInput + grandCached)} Prompt-Tokens aus dem Cache`,
            children: jsx('div', {
              className: 'h-[3px] w-full rounded-full overflow-hidden bg-(--ui-stroke-secondary) flex',
              children: jsx('div', {
                className: 'h-full bg-(--ui-accent)',
                style: { width: Math.min(100, grandCached / (grandInput + grandCached) * 100) + '%' },
              }),
            }),
          })
        : null,
      // Mini histogram: tokens per day over the active window.
      // Skipped when the window spans a single day (1d view — one bar at
      // 100% carries no information).
      histOk && rows.length > 0 && histBuckets.length > 1
        ? jsx('div', {
            className: 'shrink-0',
            children: jsx('div', {
              className: 'rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5',
              children: jsxs('div', {
                className: 'flex items-end gap-[2px] h-8',
                children: histBuckets.map(b => {
                  const h = histMax ? Math.max(4, Math.round(b.tokens / histMax * 100)) : 0
                  return jsx('div', {
                    className: 'flex-1 flex flex-col justify-end h-full',
                    title: `${dayLabel(b.key)} · ${fmt(b.tokens)} Tokens · ${b.sessions} Sitzung${b.sessions === 1 ? '' : 'en'}`,
                    children: jsx('div', {
                      className: 'w-full rounded-sm bg-(--ui-accent)' + (b.tokens === 0 ? '/30' : ''),
                      style: { height: (b.tokens === 0 ? 3 : h) + '%' },
                    }),
                  }, b.key)
                }),
              }),
            }),
          })
        : null,

      // Session list
      jsx('div', {
        className: 'flex-1 overflow-auto',
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
                    // Day separators only in the default activity sort —
                    // any other sort interleaves days, separators would lie.
                    const showDays = curSort === 'activity'
                    const out = []
                    let lastDay = null
                    const maxOut = sortedRows.reduce((m, r) => Math.max(m, r.u.output || 0), 0)
                    for (const row of sortedRows) {
                      if (showDays && row.lastActive != null) {
                        const key = dayKeyTs(row.lastActive)
                        if (key !== lastDay) {
                          lastDay = key
                          out.push(jsxs('tr', {
                            className: 'text-[0.625rem] text-(--ui-text-quaternary) border-b border-(--ui-stroke-secondary)/50',
                            children: [
                              jsx('td', { colSpan: 5, className: 'py-1 font-medium', children: dayLabel(key) }),
                            ],
                          }, 'day-' + key))
                        }
                      }
                      const u = usageFor(row)
                      const isFocused = row.id === focusedSid
                      const cached = u.cache_read || 0
                      const cost = estimateCost({ input: u.input, cache_read: cached, output: u.output, model: u.model })
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
                      // largest session in view)
                      const outBar = maxOut > 0 && (u.output || 0) > 0
                        ? jsx('div', {
                            className: 'absolute inset-y-[3px] right-0 rounded-sm bg-(--ui-accent)/10 z-0',
                            style: { width: Math.max(4, (u.output / maxOut) * 100) + '%' },
                          })
                        : null
                      out.push(jsxs('tr', {
                        className: isFocused
                          ? 'bg-(--ui-accent)/10 border-l-2 border-(--ui-accent)'
                          : 'border-b border-(--ui-stroke-secondary)/50',
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
      // Footer: session/model counts + active calendar window
      jsx('div', {
        className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary) text-center pt-1',
        children: `${rows.length} Sitzung${rows.length === 1 ? '' : 'en'} · ${histByModel.length} Modell${histByModel.length === 1 ? '' : 'e'}${histOk ? ' · ' + windowLabel(range) : ''}`,
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
