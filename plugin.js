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
  // Third-party hosted on La Plateforme (docs.mistral.ai/inference/pricing, verified 2026-09-16)
  'zai-glm-latest': { input: 1.40, cached: 0.14, output: 4.40 },  // Z.ai GLM 5.3/5.2 alias
  'glm-5-2': { input: 1.40, cached: 0.14, output: 4.40 },
  'zai-glm-5-2': { input: 1.40, cached: 0.14, output: 4.40 },
  // Flagship models (official pricing page)
  'mistral-large-latest': { input: 0.50, cached: 0.05, output: 1.50 },    // Mistral Large 3
  'mistral-large-2512': { input: 0.50, cached: 0.05, output: 1.50 },
  'mistral-medium-latest': { input: 1.50, cached: 0.15, output: 7.50 },   // Mistral Medium 3.5
  'mistral-medium-2604': { input: 1.50, cached: 0.15, output: 7.50 },
  'mistral-medium-3-5': { input: 1.50, cached: 0.15, output: 7.50 },
  'mistral-small-latest': { input: 0.15, cached: 0.015, output: 0.60 },   // Mistral Small 4
  'mistral-small-2603': { input: 0.15, cached: 0.015, output: 0.60 },
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

// ── Statusbar Chip ─────────────────────────────────────────────────

function TokenChip() {
  const usage = useValue(host.state.focusedUsage)
  const breakdown = useContextBreakdown(true)
  const show = useValue(showMap)
  const menuOpen = useValue(menuOpenMap)
  // The breakdown wins whenever we have one — it reports the MEASURED
  // occupancy once the backend has it and is keyed to this session; the
  // streamed usage only carries context fields after a turn ran here.
  const u = breakdown
    ? { ...(usage || {}), ...breakdown }
    : (usage || {})
  const total = u.total || 0
  const cached = u.cache_read || 0
  const hitPct = u.cache_hit_pct
  const ctxPct = u.context_percent
  const ctxUsed = u.context_used
  const ctxMax = u.context_max
  const cost = estimateCost(u)
  const calls = u.calls || 0

  return jsxs('div', {
    className: 'relative inline-flex h-full items-center',
    children: [
      jsxs('button', {
        type: 'button',
        className: 'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) tabular-nums cursor-pointer hover:text-(--ui-text-secondary)',
        title: `Klick: Anzeige konfigurieren\n\nInput: ${fmtFull(u.input || 0)} · Cached: ${fmtFull(cached)}${hitPct != null ? ` (${hitPct}%)` : ''} · Output: ${fmtFull(u.output || 0)} · Total: ${fmtFull(total)}`
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

function TokenPane() {
  const focusedSid = useValue(host.state.focusedSessionId)
  const allUsage = useValue(usageMap)
  const breakdown = useContextBreakdown(true)
  const { data: sessionList } = useQuery({
    queryKey: [ID, 'sessions'],
    queryFn: () => host.request('session.list', { limit: 200 }),
    refetchInterval: 10_000,
  })

  const sessions = sessionList?.sessions || []
  // Fold the focused session's context breakdown into the per-session map so
  // the 📊 column shows a fill estimate even for resumed sessions.
  const usageFor = (sid) => {
    const u = allUsage[sid] || {}
    if (sid === focusedSid && breakdown) return { ...u, ...breakdown }
    return u
  }
  const entries = Object.entries(allUsage)

  // Aggregate
  const grandInput = entries.reduce((s, [, u]) => s + (u.input || 0), 0)
  const grandCached = entries.reduce((s, [, u]) => s + (u.cache_read || 0), 0)
  const grandOutput = entries.reduce((s, [, u]) => s + (u.output || 0), 0)
  const grandTotal = entries.reduce((s, [, u]) => s + (u.total || 0), 0)

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-xs overflow-hidden',
    children: [
      // Header
      jsxs('div', {
        className: 'flex items-center justify-between shrink-0',
        children: [
          jsx('span', { className: 'font-medium text-sm', children: 'Token Stats' }),
          jsxs('span', { className: 'text-(--ui-text-quaternary) tabular-nums', children: [
            entries.length, ' session', entries.length === 1 ? '' : 's',
          ]}),
        ]
      }),

      // Aggregate summary
      jsxs('div', {
        className: 'shrink-0 rounded-md border border-(--ui-stroke-secondary) p-2 flex justify-around',
        children: [
          jsxs('div', { className: 'flex flex-col items-center gap-0.5', children: [
            jsx('span', { className: 'text-(--ui-text-quaternary) text-[0.625rem]', children: 'INPUT' }),
            jsx('span', { className: 'font-medium tabular-nums', children: fmt(grandInput) }),
          ]}),
          jsxs('div', { className: 'flex flex-col items-center gap-0.5', children: [
            jsx('span', {
              className: 'text-(--ui-text-quaternary) text-[0.625rem]',
              title: 'Cached input tokens (prompt cache reads)',
              children: 'CACHED' }),
            jsx('span', {
              className: 'font-medium tabular-nums text-(--ui-accent)',
              title: grandCached > 0 && grandInput + grandCached > 0
                ? `${grandCached} of ${grandInput + grandCached} prompt tokens served from cache (${Math.round(grandCached / (grandInput + grandCached) * 100)}%)`
                : undefined,
              children: fmt(grandCached) }),
          ]}),
          jsxs('div', { className: 'flex flex-col items-center gap-0.5', children: [
            jsx('span', { className: 'text-(--ui-text-quaternary) text-[0.625rem]', children: 'OUTPUT' }),
            jsx('span', { className: 'font-medium tabular-nums', children: fmt(grandOutput) }),
          ]}),
          jsxs('div', { className: 'flex flex-col items-center gap-0.5', children: [
            jsx('span', { className: 'text-(ui-text-quaternary) text-[0.625rem]', children: 'TOTAL' }),
            jsx('span', { className: 'font-medium tabular-nums text-(--ui-accent)', children: fmt(grandTotal) }),
          ]}),
        ]
      }),

      // Session list
      jsx('div', {
        className: 'flex-1 overflow-auto',
        children: sessions.length === 0
          ? jsx('div', { className: 'text-(--ui-text-quaternary) text-center py-4', children: 'No sessions' })
          : jsxs('table', {
              className: 'w-full border-collapse',
              children: [
                jsxs('thead', {
                  className: 'sticky top-0 bg-(--card) z-10',
                  children: [
                    jsxs('tr', { className: 'text-(--ui-text-quaternary) text-[0.625rem] uppercase', children: [
                      jsx('th', { className: 'text-left py-1 pr-2 font-normal', children: 'Session' }),
                      jsx('th', { className: 'text-right py-1 px-2 font-normal', children: 'In' }),
                      jsx('th', { className: 'text-right py-1 px-2 font-normal', title: 'Cached input tokens', children: '⚡' }),
                      jsx('th', { className: 'text-right py-1 px-2 font-normal', children: 'Out' }),
                      jsx('th', { className: 'text-right py-1 px-2 font-normal', title: 'Context window fill', children: '📊' }),
                      jsx('th', { className: 'text-right py-1 pl-2 font-normal', children: 'Total' }),
                    ]})
                  ]
                }),
                jsx('tbody', {
                  children: sessions.map(s => {
                    const u = usageFor(s.id)
                    const isFocused = s.id === focusedSid
                    const total = u.total || 0
                    const cached = u.cache_read || 0
                    return jsxs('tr', {
                      className: isFocused
                        ? 'bg-(--ui-accent)/10 border-l-2 border-(--ui-accent)'
                        : 'border-b border-(--ui-stroke-secondary)/50',
                      children: [
                        jsx('td', {
                          className: 'py-1 pr-2 max-w-[120px] truncate',
                          title: s.title || s.id,
                          children: s.title || s.id.slice(0, 12)
                        }),
                        jsx('td', { className: 'text-right py-1 px-2 tabular-nums text-(--ui-text-secondary)', children: fmt(u.input || 0) }),
                        jsx('td', {
                          className: 'text-right py-1 px-2 tabular-nums text-(--ui-text-secondary)',
                          title: cached > 0
                            ? `Cached: ${fmtFull(cached)}${u.cache_hit_pct != null ? ` · Hit: ${u.cache_hit_pct}%` : ''}`
                            : undefined,
                          children: cached > 0
                            ? jsx('span', { className: 'text-(--ui-accent)', children: fmt(cached) })
                            : jsx('span', { className: 'text-(--ui-text-quaternary)', children: '—' }),
                        }),
                        jsx('td', { className: 'text-right py-1 px-2 tabular-nums text-(--ui-text-secondary)', children: fmt(u.output || 0) }),
                        jsx('td', {
                          className: 'text-right py-1 px-2 tabular-nums',
                          title: u.context_used != null && u.context_max > 0
                            ? `Context: ${fmtFull(u.context_used)} / ${fmtFull(u.context_max)} (${u.context_percent}%)${u.context_estimated ? ' · estimate' : ' · provider usage'}`
                            : undefined,
                          children: u.context_percent != null
                            ? jsx('span', {
                                className: u.context_percent >= 90
                                  ? 'text-red-400 font-medium'
                                  : u.context_percent >= 75
                                    ? 'text-amber-400'
                                    : 'text-(--ui-text-tertiary)',
                                children: `${u.context_percent}%`,
                              })
                            : jsx('span', { className: 'text-(--ui-text-quaternary)', children: '—' }),
                        }),
                        jsx('td', { className: 'text-right py-1 pl-2 tabular-nums font-medium', children: fmt(total) }),
                      ]
                    }, s.id)
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
      data: { placement: 'right', width: '280px' },
      render: () => jsx(TokenPane, {})
    })
  }
}
