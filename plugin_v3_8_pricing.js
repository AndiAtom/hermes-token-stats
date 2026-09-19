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
  context: '📊 Kontext',
  cost: '💰 Kosten',
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

// History window for the pane (days): 7, 30, or 0 = all time.
const historyDays = atom(30)

// ── Chip menu (popover) ─────────────────────────────────────────────

function ChipMenu() {
  const show = useValue(showMap)
  return jsxs('div', {
    className: 'flex flex-col gap-0.5 p-1.5 rounded-md border border-(--ui-stroke-secondary) bg-(--card) shadow-lg text-[0.75rem] min-w-[170px]',
    // stopPropagation so the chip's own onClick doesn't re-toggle the menu
    onClick: (e) => { e.stopPropagation() },
    children: [
      jsx('div', { className: 'px-2 py-1 text-[0.625rem] uppercase text-(--ui-text-quaternary)', children: 'Anzeige' }),
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
// from state.db via usage.history deep-dive. Runs only when needed.
function usePersistedUsage(enabled, sid) {
  const query = useQuery({
    queryKey: [ID, 'persisted', sid],
    queryFn: async () => {
      try {
        const res = await host.request('usage.history', { session_id: sid, models: true })
        return { ok: true, res }
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
        title: `Token Stats v3.7 · Klick: Anzeige konfigurieren${isPersisted ? ' · 📚 DB-Werte (keine Live-Session)' : ''}\n\nInput: ${fmtFull(input)} · Cached: ${fmtFull(cached)}${hitPct != null ? ` (${hitPct}%)` : ''} · Output: ${fmtFull(out)} · Total: ${fmtFull(total)}`
          + (ctxPct != null && ctxMax > 0 ? `\nContext: ${fmtFull(ctxUsed)} / ${fmtFull(ctxMax)} tokens (${ctxPct}%)` : '')
          + (cost != null ? `\nKosten: ${(cost * EUR_RATE).toFixed(2)} €` : '')
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
                title: `Geschätzte Kosten: ${(cost * EUR_RATE).toFixed(2)} € (USD ${cost.toFixed(4)})`,
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
// Data model: the pane is backed by PERSISTENT gateway data (usage.history
// RPC → state.db) so sessions from other clients and pre-restart sessions
// show real numbers. Live session.usage events overlay the focused session.
// When usage.history is unavailable (older gateway), the pane falls back to
// the legacy live-event map only and marks itself "live only".

function HistoryQuery(days) {
  // Persistent per-session totals + per-model rows from state.db.
  return useQuery({
    queryKey: [ID, 'usageHistory', days],
    queryFn: async () => {
      try {
        const res = await host.request('usage.history', { days, limit: 200, models: true })
        return { ok: true, res }
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

function TokenPane() {
  const focusedSid = useValue(host.state.focusedSessionId)
  const allUsage = useValue(usageMap)
  const days = useValue(historyDays)
  const breakdown = useContextBreakdown(true)

  const hist = HistoryQuery(days)
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

  // Build the unified row set: persistent rows first (source of truth),
  // then any live session not yet in the history window appended live-only.
  const sessionTitles = {}
  for (const s of (sessionList?.sessions || [])) sessionTitles[s.id] = s.title

  const rows = []
  const seenIds = new Set()
  for (const h of histSessions) {
    const live = allUsage[h.id]
    // Live in-memory values are the freshest for a running session; persistent
    // row values are flushed periodically. Merge: persistent base, live wins.
    const u = live
      ? { ...h, ...live, model: h.model || live.model }
      : h
    rows.push({
      id: h.id,
      title: sessionTitles[h.id] || h.title || h.id.slice(0, 12),
      isLiveOnly: false,
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
                  title: 'usage.history RPC nicht verfügbar — nur Live-Sessions sichtbar.\nGateway-Modul: /root/Private/hermes-usage-history-rpc',
                  children: 'live only' })
              : null,
            ...[1, 7, 30, 0].map(d => jsx('button', {
              type: 'button',
              className: (d === days
                ? 'bg-(--ui-accent) text-(--card)'
                : 'text-(--ui-text-quaternary) hover:bg-(--ui-stroke-secondary)') +
                ' rounded-sm px-1.5 py-0.5 text-[0.625rem] cursor-pointer',
              onClick: () => { historyDays.set(d) },
              children: d === 0 ? '∞' : d + 'd',
            }, 'd' + d)),
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
                  jsx('td', { className: 'w-[48%]', children: 'Gesamt' }),
                  jsx('td', { className: 'text-right px-1 w-[14%] tabular-nums font-medium', children: fmt(grandInput) }),
                  jsx('td', {
                    className: 'text-right px-1 w-[14%] tabular-nums font-medium text-(--ui-accent)',
                    title: grandCached > 0 && grandInput + grandCached > 0
                      ? `${grandCached} of ${grandInput + grandCached} prompt tokens served from cache (${Math.round(grandCached / (grandInput + grandCached) * 100)}%)`
                      : undefined,
                    children: fmt(grandCached) }),
                  jsx('td', { className: 'text-right px-1 w-[13%] tabular-nums font-medium', children: fmt(grandOutput) }),
                  jsx('td', {
                    className: 'text-right pl-1 w-[11%] tabular-nums font-medium',
                    title: grandCost > 0
                      ? `Geschätzt: ${(grandCost * EUR_RATE).toFixed(2)} € (USD ${grandCost.toFixed(2)})${unpricedRows > 0 ? ` — ${unpricedRows} Session(s) ohne Preis ausgeschlossen` : ''}`
                      : undefined,
                    children: grandCost > 0
                      ? `${unpricedRows > 0 ? '≈ ' : ''}${(grandCost * EUR_RATE).toFixed(2)} €`
                      : '—' }),
                ]}),
              ]
            })
          ]
        })
      }),

      // Session list
      jsx('div', {
        className: 'flex-1 overflow-auto',
        children: rows.length === 0
          ? jsx('div', { className: 'text-(--ui-text-quaternary) text-center py-4', children: 'No sessions' })
          : jsxs('table', {
              className: 'w-full table-fixed border-collapse',
              children: [
                jsxs('thead', {
                  className: 'sticky top-0 bg-(--card) z-10',
                  children: [
                    jsxs('tr', { className: 'text-(--ui-text-quaternary) text-[0.625rem] uppercase', children: [
                      jsx('th', { className: 'text-left py-1 pr-2 font-normal w-[48%] truncate', children: 'Session' }),
                      jsx('th', { className: 'text-right py-1 px-1 font-normal w-[14%]', children: 'In' }),
                      jsx('th', { className: 'text-right py-1 px-1 font-normal w-[14%]', title: 'Cached input tokens', children: '⚡' }),
                      jsx('th', { className: 'text-right py-1 px-1 font-normal w-[13%]', children: 'Out' }),
                      jsx('th', { className: 'text-right py-1 pl-1 font-normal w-[11%]', title: 'Estimated cost (client-side pricing table)', children: '💰' }),
                    ]})
                  ]
                }),
                jsx('tbody', {
                  children: rows.map(row => {
                    const u = usageFor(row)
                    const isFocused = row.id === focusedSid
                    const cached = u.cache_read || 0
                    const cost = estimateCost({ ...u, input: u.input, cache_read: cached, output: u.output, model: u.model })
                    // Per-model tooltip from persistent model rows (when present)
                    const modelTip = row.modelRows.length
                      ? '\nModelle: ' + row.modelRows
                          .map(m => `${m.model}${m.task ? ' (' + m.task + ')' : ''}: in ${fmt(m.input_tokens)}, ⚡ ${fmt(m.cache_read_tokens)}, out ${fmt(m.output_tokens)}`)
                          .join(' · ')
                      : ''
                    return jsxs('tr', {
                      className: isFocused
                        ? 'bg-(--ui-accent)/10 border-l-2 border-(--ui-accent)'
                        : 'border-b border-(--ui-stroke-secondary)/50',
                      children: [
                        jsxs('td', {
                          className: 'py-1 pr-2 truncate',
                          title: (row.title || row.id) + (row.lastActive ? ` (${fmtDate(row.lastActive)})` : '') + modelTip,
                          children: [
                            row.isLiveOnly
                              ? jsx('span', { className: 'text-(--ui-text-quaternary) mr-1', title: 'Live-Session (noch nicht persistent erfasst)', children: '●' })
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
                        jsx('td', { className: 'text-right py-1 px-1 tabular-nums text-(--ui-text-secondary)', children: fmt(u.output || 0) }),
                        jsx('td', {
                          className: 'text-right py-1 pl-1 tabular-nums text-(--ui-text-quaternary)',
                          title: cost != null
                            ? `Geschätzt: ${(cost * EUR_RATE).toFixed(2)} € (USD ${cost.toFixed(4)})${modelTip}`
                            : 'Kein Preis für ' + (u.model || 'dieses Modell'),
                          children: cost != null
                            ? (cost * EUR_RATE).toFixed(2) + ' €'
                            : jsx('span', { className: 'text-(--ui-text-quaternary)', children: '—' }),
                        }),
                      ]
                    }, row.id)
                  })
                })
              ]
            })
      }),
    ]
  })
}

// ── Plugin export ───────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Token Stats',
  register(ctx) {
    // Load persisted chip visibility (sync seed before first render)
    const saved = ctx.storage.get('chipShow', null)
    if (saved && typeof saved === 'object') {
      const next = { ...DEFAULT_SHOW }
      for (const k of SHOW_KEYS) if (k in saved) next[k] = Boolean(saved[k])
      showMap.set(next)
    }
    // Persist on every toggle
    showMap.listen(map => { ctx.storage.set('chipShow', map) })

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
