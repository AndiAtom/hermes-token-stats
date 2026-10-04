#!/usr/bin/env python3
"""Regeneriert die PRICES_OPENROUTER-Tabelle in plugin.js aus der
OpenRouter /api/v1/models API.

Kuratierung (v4.5.0-Design):
- text-in/text-out (Chat/Completion — kein Audio/Image-Only-Modell)
- preisvoll (prompt>0 & completion>0) ODER dauerhaft 0.00 / :free
- nicht expired (expiration_date in der Zukunft)
- Gedroppt: OR-Routing-Modelle (openrouter/auto & Co., Preise = -1 —
  die haben KEINEN eigenen Preis, OR verrechnet den des gerouteten Modells)

Preisformat: OR liefert USD pro Token; wir normalisieren auf USD pro 1M
(das Format der bestehenden PRICES-Tabelle). cached = input_cache_read
(fehlt bei manchen Modellen → 0.00).

Output: JS-Object-Literal, eingerückt wie der bestehende PRICES-Block,
zum direkten Ersetzen des markierten Blocks in plugin.js.

Nutzung:
    python3 scripts/gen_prices_openrouter.py > /tmp/prices_or.js
    # dann den Block zwischen den OR-Markern in plugin.js ersetzen
"""

import json
import sys
import urllib.request
from datetime import datetime, timezone

OR_API = "https://openrouter.ai/api/v1/models"

# Sortierung: nach Anbieter (erste Pfadkomponente), dann Modellname —
# so bleibt der Diff lesbar, wenn nur ein Anbieter seine Preise ändert.


def curate(models):
    now = datetime.now(timezone.utc).timestamp()
    out = []
    for m in models:
        arch = m.get("architecture") or {}
        if "text" not in (arch.get("input_modalities") or []):
            continue
        if "text" not in (arch.get("output_modalities") or []):
            continue
        exp = m.get("expiration_date")
        if exp and datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() < now:
            continue
        p = m.get("pricing") or {}
        try:
            prompt = float(p.get("prompt") or 0)
            completion = float(p.get("completion") or 0)
            cache_read = float(p.get("input_cache_read") or 0)
        except (TypeError, ValueError):
            continue
        if prompt < 0 or completion < 0:  # Routing-Modelle (-1) → kein eigener Preis
            continue
        if not (prompt > 0 and completion > 0) and not (prompt == 0 and completion == 0):
            continue
        out.append({
            "id": m["id"],
            "input": prompt * 1_000_000,
            "cached": cache_read * 1_000_000,
            "output": completion * 1_000_000,
        })
    out.sort(key=lambda e: tuple(e["id"].lower().split("/")[::-1]) + (e["id"],))
    # stabil lesbar: primär Anbieter-Gruppe, sekundär Modellname
    out.sort(key=lambda e: (e["id"].split("/")[0].lower(), e["id"].lower()))
    return out


def fmt_price(v):
    # OR-Preise sind oft lange Dezimalen ($1.400000/M aus 0.0000014/token);
    # 6 signifikante Stellen reichen immer (kleinster realer Preis ~$0.001/M)
    s = f"{v:.6g}"
    return s


def render(rows):
    lines = []
    for e in rows:
        lines.append(
            f"  '{e['id']}': {{ input: {fmt_price(e['input'])}, "
            f"cached: {fmt_price(e['cached'])}, output: {fmt_price(e['output'])} }},"
        )
    return "\n".join(lines)


def main():
    req = urllib.request.Request(OR_API, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    rows = curate(data.get("data") or [])
    gen_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"// ── OpenRouter catalog prices (source: openrouter.ai/api/v1/models,")
    print(f"//    generated {gen_date} via scripts/gen_prices_openrouter.py —")
    print(f"//    USD per 1M tokens; cached = input_cache_read; 0.00 = free tier.)")
    print(f"//    {len(rows)} curated models (text-in/text-out, priced or free, not expired,")
    print(f"//    OR routing models excluded — they carry no own price).")
    print("const PRICES_OPENROUTER = {")
    print(render(rows))
    print("}")
    print(f"// end generated block ({gen_date}, {len(rows)} models)")


if __name__ == "__main__":
    sys.exit(main())
