
'use strict';

import { useEffect, useMemo, useState } from 'react';
import { FormLayout } from '@loopar/form';
import { useFormContext } from '@form-provider';
import loopar from 'loopar';
import { computeQuote, computeTotals, num } from '../../../pricing-engine.js';

const money = (v) => `$${num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Debounced snapshot of a value — the panel recalculates once typing pauses, not per keystroke. */
function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
const toRows = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
};

/**
 * Live totals while editing (unsaved): runs the shared pricing engine on the
 * current form values. What persists is still what the server computes on save
 * (same computeQuote + computeTotals, so both always agree).
 */
function LiveTotals() {
  const { values: liveValues } = useFormContext();
  const values = useDebounced(liveValues, 250);
  const [catalog, setCatalog] = useState(null);

  useEffect(() => {
    loopar.call('Couple Quote', 'getCatalog', { freeze: false })
      .then((r) => r?.works && setCatalog({ categories: r.categories || {}, works: r.works, rules: r.rules || {} }))
      .catch((e) => console.warn('[couple] live totals: catalog unavailable', e?.message));
  }, []);

  const result = useMemo(() => {
    if (!catalog) return null;
    const v = values || {};
    const priced = computeQuote(catalog, {
      lines: toRows(v.lines),
      rush: v.rush,
      contingency_pct: v.contingency_pct,
      material_provided_by: v.material_provided_by,
      material_cost: v.material_cost,
      material_markup_pct: v.material_markup_pct
    });
    const { discount, tax, total, deposit } = computeTotals(priced, v);
    return { priced, discount, tax, total, deposit, savedTotal: num(v.total) };
  }, [catalog, values]);

  if (!result) return null;
  const { priced, discount, tax, total, deposit, savedTotal } = result;
  const dirty = Math.abs(total - savedTotal) > 0.005;
  const rows = [
    ...priced.groups.map((g) => [g.title, g.subtotal]),
    ...priced.project.map((p) => [p.label, p.amount]),
    discount ? ['Discount', -discount] : null,
    tax ? ['Tax (materials)', tax] : null
  ].filter(Boolean);

  return (
    <div className={`rounded-xl border p-4 mb-2 ${dirty ? 'border-primary/60 bg-primary/5' : 'border-border bg-muted/30'}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">Live totals</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {dirty ? 'Unsaved — differs from the saved total. Save to persist.' : 'Matches the saved total.'}
            {priced.totalSqft ? ` · ${priced.totalSqft} sq ft` : ''}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold">{money(total)}</div>
          <div className="text-xs text-muted-foreground">Deposit {money(deposit)}</div>
        </div>
      </div>
      {rows.length > 0 && (
        <ul className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 text-sm">
          {rows.map(([label, amount], i) => (
            <li key={i} className="flex justify-between gap-3 py-0.5 border-b border-border/40 last:border-0">
              <span className="text-muted-foreground">{label}</span><span>{money(amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SLOTS = { totals_preview: () => <LiveTotals /> };

export default function CoupleQuoteForm() {
  return <FormLayout slots={SLOTS} />;
}
