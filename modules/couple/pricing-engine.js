'use strict';

/**
 * Couple Hardwood Floors — pricing engine (v4, work lines).
 *
 * A quote is a list of lines:  Category ▸ Work ▸ quantity (× count).
 * Every Work has a closed price per unit (sq ft, linear ft, step, each, hour, flat).
 * Works flagged `per_count` (sealer, stain, paint, finish) are priced per coat:
 *   subtotal = quantity × count × rate.  Everything else has count = 1.
 * No modifiers, no multipliers per line — if herringbone costs more, it is its own Work.
 *
 *   categories { <name>: { title, order, area_label, ... } }        (Couple Work Category)
 *   works      { <name>: { category, title, unit, rate, min_charge, ... } }  (Couple Work)
 *   rules      { <name>: { mode: amount|multiplier|tier, rate, tier_from_sqft, tier_to_sqft } } (Couple Pricing Config)
 *
 * Project rules (data): volume tiers (mode=tier) → rush (project-rush) → minimum job charge (project-minimum)
 * → contingency % → materials (cost × markup) → discount → tax on materials only → deposit.
 */

export const RULE_KEYS = { rush: 'project-rush', minimum: 'project-minimum' };
export const UNITS = {
  sqft: { label: 'sq ft', ask: 'Area (sq ft)' },
  linear_ft: { label: 'linear ft', ask: 'Length (linear ft)' },
  step: { label: 'steps', ask: 'Steps' },
  each: { label: 'each', ask: 'Quantity' },
  hour: { label: 'hours', ask: 'Hours' },
  flat: { label: 'flat', ask: '' }
};
export const PROPERTY_OPTIONS = [
  { value: 'house', label: 'House' },
  { value: 'condo', label: 'Condo / apartment' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'historic', label: 'Historic home' }
];

export const num = (v, fallback = 0) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : fallback;
};
export const round2 = (v) => Math.round(num(v) * 100) / 100;
/** Percent input clamped to [0, max] (default 0–100) — keeps typos from producing absurd totals. */
export const pct = (v, fallback = 0, max = 100) => Math.min(max, Math.max(0, num(v, fallback)));
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const $ = (v) => `$${num(v).toFixed(2)}`;

export const sortByOrder = (list) => [...list].sort((a, b) => num(a.order) - num(b.order));
export function worksOf(works, category) {
  return sortByOrder(Object.values(works || {}).filter((w) => w && w.category === category));
}

export function ruleAmount(rules, key) { return num(rules?.[key]?.rate); }
export function ruleFactor(rules, key) {
  const r = rules?.[key];
  if (!r) return 1;
  const f = num(r.rate, 1);
  return f > 0 ? f : 1;
}
export function tierFactor(rules, totalSqft) {
  for (const t of Object.values(rules || {}).filter((r) => r && r.mode === 'tier')) {
    const from = num(t.tier_from_sqft);
    const to = t.tier_to_sqft == null || t.tier_to_sqft === '' ? Infinity : num(t.tier_to_sqft);
    if (totalSqft >= from && totalSqft < to) { const f = num(t.rate, 1); return { factor: f > 0 ? f : 1, title: t.title }; }
  }
  return { factor: 1, title: null };
}

/** Price one line from the catalog. Returns null when the work is unknown or the quantity is missing. */
export function priceLine(works, line) {
  const w = works?.[line?.work];
  if (!w) return null;
  const unit = w.unit || 'flat';
  const quantity = unit === 'flat' ? 1 : Math.max(0, num(line.quantity));
  if (unit !== 'flat' && quantity <= 0) return null;
  const rate = num(w.rate);
  const perCount = num(w.per_count) === 1 || w.per_count === true;
  const count = perCount ? Math.max(1, Math.round(num(line.count, num(w.default_count, 1)) || num(w.default_count, 1) || 1)) : 1;
  let subtotal = round2(quantity * count * rate);
  const min = num(w.min_charge);
  const minApplied = min > 0 && subtotal < min;
  if (minApplied) subtotal = min;
  return {
    category: w.category, work: line.work, area: String(line.area ?? '').trim(),
    quantity, unit, count, perCount, countLabel: w.count_label || 'Coats', rate, subtotal, minApplied,
    title: w.title, notes: String(line.notes ?? '').trim()
  };
}

export const qtyLabel = (unit, q) => (unit === 'flat' ? 'flat' : unit === 'each' ? `× ${q}` : `${q} ${UNITS[unit]?.label || unit}`);

export function computeQuote(catalog, quote = {}) {
  const { categories = {}, works = {}, rules = {} } = catalog || {};
  const lines = (Array.isArray(quote.lines) ? quote.lines : []).map((l) => priceLine(works, l)).filter(Boolean);

  // Group by category (catalog order)
  const byCategory = {};
  for (const l of lines) (byCategory[l.category] ||= []).push(l);
  const groups = sortByOrder(Object.values(categories))
    .filter((c) => byCategory[c.name])
    .map((c) => ({
      category: c.name, title: c.title,
      subtotal: round2(byCategory[c.name].reduce((a, l) => a + l.subtotal, 0)),
      lines: byCategory[c.name].map((l) => ({
        ...l,
        label: `${l.area ? `${l.area}: ` : ''}${l.title}${l.perCount ? ` × ${l.count} ${l.count === 1 ? l.countLabel.toLowerCase().replace(/s$/, '') : l.countLabel.toLowerCase()}` : ''} — ${qtyLabel(l.unit, l.quantity)}${l.unit !== 'flat' ? ` × ${$(l.rate)}` : ''}${l.minApplied ? ' (minimum)' : ''}`
      }))
    }));
  // Lines whose category is not in the catalog (deactivated) still count
  for (const [cat, ls] of Object.entries(byCategory)) {
    if (!categories[cat]) groups.push({ category: cat, title: cat, subtotal: round2(ls.reduce((a, l) => a + l.subtotal, 0)), lines: ls.map((l) => ({ ...l, label: `${l.title} — ${qtyLabel(l.unit, l.quantity)}` })) });
  }

  // Total area for volume tiers: an area is ONE process (install + sand + finish share the same floor),
  // so each area label counts once (its largest sq ft line). Lines without a label count individually.
  const areaSqft = {};
  let unlabeled = 0;
  for (const l of lines.filter((l) => l.unit === 'sqft')) {
    if (l.area) areaSqft[l.area] = Math.max(areaSqft[l.area] || 0, l.quantity);
    else unlabeled += l.quantity;
  }
  const totalSqft = round2(Object.values(areaSqft).reduce((a, q) => a + q, 0) + unlabeled);
  const labor = round2(lines.reduce((a, l) => a + l.subtotal, 0));

  const project = [];
  const tier = tierFactor(rules, totalSqft);
  const tierAdjustment = round2(labor * (tier.factor - 1));
  if (tierAdjustment) project.push({ label: `${tier.title || 'Volume tier'} (×${tier.factor.toFixed(2)})`, amount: tierAdjustment });
  const rushFactor = bool(quote.rush) ? ruleFactor(rules, RULE_KEYS.rush) : 1;
  const rushAdjustment = round2((labor + tierAdjustment) * (rushFactor - 1));
  if (rushAdjustment) project.push({ label: `Rush / weekend (×${rushFactor.toFixed(2)})`, amount: rushAdjustment });
  let adjusted = round2(labor + tierAdjustment + rushAdjustment);
  const minimum = ruleAmount(rules, RULE_KEYS.minimum);
  const minimumAdjustment = adjusted > 0 && minimum > adjusted ? round2(minimum - adjusted) : 0;
  if (minimumAdjustment) project.push({ label: `Minimum job charge (${$(minimum)})`, amount: minimumAdjustment });
  adjusted = round2(adjusted + minimumAdjustment);
  const contingencyPct = pct(quote.contingency_pct);
  const contingency = round2(adjusted * contingencyPct / 100);
  if (contingency) project.push({ label: `Contingency allowance (${contingencyPct}%)`, amount: contingency });
  const materialCost = quote.material_provided_by === 'couple' ? Math.max(0, num(quote.material_cost)) : 0;
  const materialSubtotal = round2(materialCost * (1 + pct(quote.material_markup_pct, 0, 500) / 100));
  if (materialSubtotal) project.push({ label: 'Materials supplied by Couple', amount: materialSubtotal });

  const laborTotal = round2(adjusted + contingency);
  const subtotal = round2(laborTotal + materialSubtotal);
  const serviceType = groups.map((g) => g.title).join(' + ') || 'Quote';

  // Rough duration: ~400 sq ft/day of work + 2 drying days when any sanding-like category exists
  let estimatedDays = totalSqft ? Math.ceil(totalSqft / 400) : (lines.length ? 1 : 0);
  if (groups.some((g) => /sand|finish/i.test(g.title))) estimatedDays += 2;

  return {
    lines, groups, project, totalSqft, labor,
    adjustments: { tier: tierAdjustment, tierFactor: tier.factor, rush: rushAdjustment, rushFactor, minimum: minimumAdjustment, contingency, contingencyPct },
    materialSubtotal, laborTotal, subtotal, total: subtotal, serviceType, estimatedDays
  };
}

/**
 * Commercial totals on top of computeQuote(): discount (on subtotal), tax
 * (MA: materials only), total and deposit. Shared by the server (save) and
 * the desk live-totals slot so both always agree.
 */
export function computeTotals(priced, quote = {}) {
  const discountPct = pct(quote.discount_percent);
  const taxPct = pct(quote.tax_percent);
  const depositPct = pct(quote.deposit_percent, 50);
  const discount = round2(priced.subtotal * discountPct / 100);
  const tax = round2(priced.materialSubtotal * taxPct / 100);
  const total = round2(priced.subtotal - discount + tax);
  const deposit = round2(total * depositPct / 100);
  return { discountPct, taxPct, depositPct, discount, tax, total, deposit };
}
