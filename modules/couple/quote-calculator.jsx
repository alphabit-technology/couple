'use strict';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@cn/components/ui/input';
import { Textarea } from '@cn/components/ui/textarea';
import { Button } from '@cn/components/ui/button';
import { useCaptcha, CaptchaSlot } from '@loopar/components/captcha-widget';
import {
  Plus, X, CheckCircle2, RefreshCw, AlertTriangle, ArrowUpRight, ChevronDown, Check, Layers,
  Hammer, Sparkles, Shield, Palette, PaintBucket, Droplets, Eraser, Trash2, Wrench, Truck, Sun
} from 'lucide-react';

// Category icons come from the catalog (Couple Work Category.icon); keep an explicit map so the bundle stays small.
const Icons = { Hammer, Sparkles, Shield, Palette, PaintBucket, Droplets, Eraser, Trash2, Wrench, Truck, Sun, Layers };
import loopar from 'loopar';
import { computeQuote, priceLine, num, worksOf, sortByOrder, UNITS, PROPERTY_OPTIONS } from './pricing-engine.js';

/**
 * Website quote calculator — Couple Hardwood Floors (v4, work lines).
 *
 * A quote is a list of AREA cards. Each card = name + measure type + quantity, and one or
 * more categories with one work type each. The card expands into one Quote Line per work:
 *   "Living room · 300 sq ft · Installation ▸ Hardwood (unfinished) + Sanding ▸ New floor + Demolition ▸ Carpet"
 *   → 3 lines sharing area and quantity.
 * The measure type filters which work types fit the card (a "steps" card offers the stair
 * works; a "sq ft" card the floor works); flat works always fit. m² is display only —
 * converted to sq ft for pricing.
 * Catalog (categories, works, project rules) comes from `Couple Quote / getCatalog`;
 * math from pricing-engine.js (shared with the server).
 */

const MEASURES = [
  { value: 'sqft', label: 'sq ft', unit: 'sqft', factor: 1, ask: 'Area (sq ft)' },
  { value: 'm2', label: 'm²', unit: 'sqft', factor: 10.7639, ask: 'Area (m²)' },
  { value: 'linear_ft', label: 'linear ft', unit: 'linear_ft', factor: 1, ask: 'Length (linear ft)' },
  { value: 'step', label: 'steps', unit: 'step', factor: 1, ask: 'Steps' },
  { value: 'each', label: 'quantity', unit: 'each', factor: 1, ask: 'Quantity' },
  { value: 'hour', label: 'hours', unit: 'hour', factor: 1, ask: 'Hours' }
];
const measureOf = (v) => MEASURES.find((m) => m.value === v) || MEASURES[0];
/** Any work can join an area. Works in the card's unit (or flat) share the card quantity;
 *  works in another unit (baseboards in linear ft inside a sq ft room) carry their own quantity. */
const fitsCard = (w, measure) => true;
const sharesCardQty = (w, measure) => !w || w.unit === 'flat' || w.unit === measure.unit;
/** Auto-pick a sanding type: freshly installed unfinished hardwood → "new floor" work, else the first one. */
const workName = (sel) => (typeof sel === 'string' ? sel : sel?.work || '');
const selection = (works, name) => (name ? { work: name, count: Math.max(1, num(works?.[name]?.default_count, 1) || 1), quantity: works?.[name]?.default_quantity ?? '' } : null);
const pickWork = (works, category, card) => {
  const fitting = works.filter((w) => fitsCard(w, measureOf(card.measure)));
  return fitting.length ? fitting[0].name : '';
};
const parentsOf = (w) => String(w?.parents || '').split(',').map((k) => k.trim()).filter(Boolean);
const isAuto = (w) => num(w?.auto_add) === 1 || w?.auto_add === true;
/** Works that follow `parentName` (catalog data) and fit the card measure. */
const childrenOf = (allWorks, parentName, measure) =>
  sortByOrder(Object.values(allWorks).filter((w) => parentsOf(w).includes(parentName) && fitsCard(w, measure)));
/**
 * Apply catalog follow-ups after `works` changed: every selected work whose children are
 * flagged auto_add gets them added (one per category, only if that category is still empty).
 * Returns { works, open, added } — added = category names that were auto-added.
 */
/**
 * Owner of a child work inside a card: among the selected works that are its parents, the one whose
 * category comes first in the process order. A child is rendered under ONE parent only (no duplicates),
 * so Sealer / Stain / Finish sit as siblings under Sanding instead of nesting into each other.
 */
const ownerCategory = (catalog, card, child, exceptCat = null) => {
  if (!child) return null;
  const parents = parentsOf(child);
  let best = null;
  for (const [otherCat, sel] of Object.entries(card.works || {})) {
    if (otherCat === exceptCat || !parents.includes(workName(sel))) continue;
    const order = num(catalog.categories[otherCat]?.order, 9999);
    if (!best || order < best.order) best = { cat: otherCat, order };
  }
  return best?.cat || null;
};
/** A category is "nested" when its selected work follows a work selected in another category of the same card. */
const nestedUnder = (catalog, card, catName) => ownerCategory(catalog, card, catalog.works[workName(card.works?.[catName])], catName);
/** All categories nested (transitively) under `catName` in this card. */
const nestedDescendants = (catalog, card, catName) => {
  const out = [];
  const walk = (parent) => {
    for (const c of Object.keys(card.works || {})) {
      if (c !== parent && !out.includes(c) && nestedUnder(catalog, card, c) === parent) { out.push(c); walk(c); }
    }
  };
  walk(catName);
  return out;
};
/**
 * Categories reachable INSIDE the card tree: children of every selected work, and (transitively)
 * children of the options those child categories offer, even when not selected yet. They are
 * hidden from the top-level list — to sand a different floor, add another area.
 */
const reachableCategories = (catalog, card, measure) => {
  const allWorks = catalog.works;
  const out = new Set();
  const seen = new Set();
  const visit = (work) => {
    if (!work || seen.has(work.name)) return;
    seen.add(work.name);
    for (const child of childrenOf(allWorks, work.name, measure)) {
      if (child.category === work.category) continue;
      out.add(child.category);
      const chosen = allWorks[workName(card.works?.[child.category])];
      visit(chosen && parentsOf(chosen).includes(work.name) ? chosen : child);
    }
  };
  for (const sel of Object.values(card.works || {})) visit(allWorks[workName(sel)]);
  // A category selected at the top level (its own parent is not selected) must stay visible
  for (const [cat, sel] of Object.entries(card.works || {})) {
    if (out.has(cat) && !nestedUnder(catalog, card, cat)) out.delete(cat);
  }
  return out;
};
const applyAutoAdds = (allWorks, card, works, open) => {
  const measure = measureOf(card.measure);
  const nextWorks = { ...works }; const nextOpen = { ...open }; const added = [];
  let changed = true; let guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (const sel of Object.values(nextWorks)) {
      for (const child of childrenOf(allWorks, workName(sel), measure)) {
        if (!isAuto(child) || nextWorks[child.category]) continue;
        nextWorks[child.category] = selection(allWorks, child.name); added.push(child.category); changed = true;
      }
    }
  }
  return { works: nextWorks, open: nextOpen, added };
};
/** Expand one card into engine lines (quantity converted to the work unit). */
const cardLines = (card, index = 0) => {
  const m = measureOf(card.measure);
  const area = (card.area || '').trim() || `Area ${index + 1}`;
  return Object.values(card.works || {}).filter((sel) => workName(sel)).map((sel) => {
    const w = catalogWorksRef.current?.[workName(sel)];
    const own = w && !sharesCardQty(w, m);
    return {
      work: workName(sel), count: Math.max(1, num(sel.count, 1) || 1), area,
      quantity: own ? num(sel.quantity) : Math.round(num(card.quantity) * m.factor * 100) / 100,
      notes: !own && m.value === 'm2' ? `${card.quantity} m²` : ''
    };
  });
};

const money = (v, c = '$') => `${c}${num(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

let seq = 0;
const catalogWorksRef = { current: null };
/** card.works = { [categoryName]: { work, count } } — one work per selected category; count = coats/passes when the work is priced per coat. */
const newCard = (area = '', measure = 'sqft') => ({ id: ++seq, area, measure, quantity: '', works: {}, open: {} });
const CategoryIcon = ({ name, className }) => { const Cmp = (name && Icons[name]) || Layers; return <Cmp className={className} />; };

const FLOOR_LEVELS = [{ value: '1', label: 'Ground / 1st floor' }, { value: '2', label: '2nd floor' }, { value: '3', label: '3rd floor or higher' }];
const BUILT_OPTIONS = [{ value: 'unknown', label: 'Not sure' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

function SectionTitle({ children, hint }) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold tracking-[0.15em] uppercase text-muted-foreground">{children}</h3>
      {hint && <p className="text-sm text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <label className={`flex flex-col gap-1.5 text-sm ${className}`}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Select({ value, onChange, options, className = '' }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-11 w-full rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Chips({ options, value, onChange, render }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o.name === value;
        return (
          <button
            type="button" key={o.name} onClick={() => onChange(o)} title={o.description || ''}
            className={`rounded-lg border px-4 py-2.5 text-sm text-left transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary/60'}`}
          >
            {render ? render(o, active) : o.title}
          </button>
        );
      })}
    </div>
  );
}

function CheckCard({ checked, onChange, label }) {
  return (
    <label className={`flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors ${checked ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-primary/50'}`}>
      <input type="checkbox" className="h-4 w-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm">{label}</span>
    </label>
  );
}

const qtyLabelWeb = (unit, q) => (unit === 'flat' ? 'flat' : unit === 'each' ? `× ${q}` : `${q} ${UNITS[unit]?.label || unit}`);
/**
 * One category section inside an area card — used at the top level AND nested (child categories
 * render with this same component, so they get the same header: include/remove check, icon, title,
 * summary, subtotal and collapse). `options` = works offered here (all fitting works at the top level,
 * the parent's children when nested).
 */
function CategorySection({ card, cat, options, catalog, measure, currency, actions, depth = 0 }) {
  const allWorks = catalog.works;
  const sel = card.works[cat.name];
  const selName = workName(sel);
  const current = allWorks[selName];
  const included = !!current;
  const fits = options.length > 0;
  const isOpen = included && !!(card.open || {})[cat.name];
  const perCount = current && (num(current.per_count) === 1 || current.per_count === true);
  const ownQty = current && !sharesCardQty(current, measure);
  const priced = current ? priceLine(allWorks, { work: selName, count: sel.count, quantity: ownQty ? num(sel.quantity) : num(card.quantity) * measure.factor }) : null;
  const descendants = included ? nestedDescendants(catalog, card, cat.name) : [];
  const lineQty = (c) => { const w = allWorks[workName(card.works[c])]; return w && !sharesCardQty(w, measure) ? num(card.works[c].quantity) : num(card.quantity) * measure.factor; };
  const total = (priced?.subtotal || 0) + descendants.reduce((a, c) => a + (priceLine(allWorks, { work: workName(card.works[c]), count: card.works[c].count, quantity: lineQty(c) })?.subtotal || 0), 0);

  // Child categories of the selected work, each drawn under ONE owner parent only
  const children = current ? childrenOf(allWorks, selName, measure) : [];
  const childCats = [...new Set(children.map((c) => c.category))].filter((childCatName) => {
    const opts = children.filter((c) => c.category === childCatName);
    const chosen = opts.find((c) => c.name === workName(card.works[childCatName]));
    // Selected at the top level with a work that does not follow this parent → it lives up there, not here
    if (card.works[childCatName] && !chosen) return false;
    const owner = ownerCategory(catalog, card, chosen || opts[0], childCatName);
    return catalog.categories[childCatName] && (!owner || owner === cat.name);
  });

  const onCheck = () => (included ? actions.remove(cat) : actions.include(cat, options[0]));
  const onHeader = () => (included ? actions.toggleOpen(cat.name) : actions.include(cat, options[0]));

  return (
    <div className={`rounded-xl border transition-colors ${included ? 'border-primary/60 bg-primary/5' : 'border-border/60'} ${!fits ? 'opacity-40' : ''}`}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button" disabled={!fits} onClick={onCheck} aria-pressed={included}
          className={`h-6 w-6 shrink-0 rounded-md border flex items-center justify-center transition-colors ${included ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background'}`}
        >
          {included && <Check className="h-4 w-4" />}
        </button>
        <button type="button" disabled={!fits} onClick={onHeader} className="flex flex-1 items-center gap-3 text-left min-w-0">
          <CategoryIcon name={cat.icon} className={`h-4 w-4 shrink-0 ${included ? 'text-primary' : 'text-muted-foreground'}`} />
          <span className={`font-medium ${included ? '' : 'text-muted-foreground'}`}>{cat.title}</span>
          {included && (
            <span className="text-sm text-muted-foreground truncate">
              · {current.title}{perCount ? ` × ${sel.count} ${(current.count_label || 'coats').toLowerCase()}` : ''}
              {descendants.length ? ` + ${descendants.map((c) => catalog.categories[c]?.title || c).join(', ')}` : ''}
            </span>
          )}
          {included && <span className="ml-auto text-sm font-semibold whitespace-nowrap">{money(total, currency)}</span>}
          {!included && fits && (() => {
            const cheapest = [...options].sort((a, b) => num(a.rate) - num(b.rate))[0];
            return <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">from {priceTag(cheapest, currency)}</span>;
          })()}
          {included && <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
        </button>
      </div>

      {isOpen && (
        <div className="px-3 pb-3 pt-3 border-t border-border/40 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {options.map((w) => {
              const active = w.name === selName;
              return (
                <button
                  type="button" key={w.name} onClick={() => actions.pick(cat, w)} title={w.description || ''}
                  className={`rounded-lg border px-3.5 py-2 text-sm text-left transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary/60'}`}
                >
                  <span>{w.title}</span>
                  <span className={`ml-2 text-xs ${active ? 'opacity-80' : 'text-muted-foreground'}`}>{priceTag(w, currency)}</span>
                </button>
              );
            })}
            {ownQty && (
              <label className="flex items-center gap-1.5 text-sm ml-1">
                <Input
                  type="number" min="0" step="1" inputMode="decimal" value={sel.quantity ?? ''} placeholder="0"
                  className="h-9 w-24" onChange={(e) => actions.quantity(cat.name, e.target.value)}
                />
                <span className="text-muted-foreground">{UNITS[current.unit]?.label || current.unit}</span>
              </label>
            )}
            {perCount && (
              <div className="flex items-center gap-1.5 text-sm ml-1">
                <span className="text-muted-foreground">{current.count_label || 'Coats'}</span>
                <button type="button" className="h-8 w-8 rounded-md border border-border hover:border-primary/60" onClick={() => actions.count(cat.name, sel.count - 1)}>−</button>
                <span className="w-6 text-center font-semibold">{sel.count}</span>
                <button type="button" className="h-8 w-8 rounded-md border border-border hover:border-primary/60" onClick={() => actions.count(cat.name, sel.count + 1)}>+</button>
              </div>
            )}
          </div>
          {current?.web_hint && depth === 0 && <p className="text-xs text-muted-foreground -mt-1">{current.web_hint}</p>}

          {childCats.length > 0 && (
            <div className="flex flex-col gap-2 pl-3 border-l-2 border-primary/30">
              {childCats.map((childCatName) => (
                <CategorySection
                  key={childCatName} card={card} cat={catalog.categories[childCatName]}
                  options={children.filter((c) => c.category === childCatName)}
                  catalog={catalog} measure={measure} currency={currency} actions={actions} depth={depth + 1}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const priceTag = (w, currency) => `${w.unit === 'flat' ? money(w.rate, currency) : `${money(w.rate, currency)}/${UNITS[w.unit]?.label || w.unit}`}${num(w.per_count) === 1 || w.per_count === true ? ' per coat' : ''}`;

export default function QuoteCalculator({ showHeader = true } = {}) {
  const [catalog, setCatalog] = useState(null); // { currency, categories, works, rules }
  const [loadError, setLoadError] = useState(false);
  const [cards, setCards] = useState([]);
  const [project, setProject] = useState({ property_type: 'house', floor_level: '1', elevator: false, occupied: true, built_before_1978: 'unknown', pets: false });
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', address: '', city: '', zip_code: '', notes: '' });
  const [hp, setHp] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const mountTsRef = useRef(Date.now());
  const captcha = useCaptcha();

  const load = async () => {
    setLoadError(false);
    try {
      const r = await loopar.call('Couple Quote', 'getCatalog', { freeze: false });
      if (!r?.works || !Object.keys(r.works).length) throw new Error('empty catalog');
      const c = { currency: r.currency || '$', categories: r.categories || {}, works: r.works, rules: r.rules || {} };
      catalogWorksRef.current = c.works;
      setCatalog(c);
      setCards((prev) => {
        if (prev.length) return prev;
        const card = newCard('Living Room');
        const cat = sortByOrder(Object.values(c.categories))[0];
        if (cat) {
          const r = applyAutoAdds(c.works, card, { [cat.name]: selection(c.works, pickWork(worksOf(c.works, cat.name), cat.name, card)) }, { [cat.name]: true });
          card.works = r.works; card.open = r.open;
        }
        return [card];
      });
    } catch (e) {
      console.error('[couple] could not load catalog:', e?.message);
      setLoadError(true);
    }
  };

  useEffect(() => { load(); }, []);

  const categories = useMemo(() => (catalog ? sortByOrder(Object.values(catalog.categories)).filter((c) => worksOf(catalog.works, c.name).length) : []), [catalog]);
  const allLines = useMemo(() => cards.flatMap((c, i) => cardLines(c, i)), [cards]);
  const estimate = useMemo(() => (catalog ? computeQuote(catalog, { lines: allLines }) : null), [catalog, allLines]);
  const currency = catalog?.currency || '$';

  const updateCard = (id, patch) => setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const setWork = (card, cat, work) => {
    const works = { ...card.works, [cat.name]: selection(catalog.works, work.name) };
    const r = applyAutoAdds(catalog.works, card, works, card.open || {});
    updateCard(card.id, { works: r.works, open: r.open });
  };
  const setCount = (card, catName, count) => updateCard(card.id, { works: { ...card.works, [catName]: { ...card.works[catName], count: Math.min(10, Math.max(1, Math.round(num(count, 1)) || 1)) } } });
  const toggleOpen = (card, catName) => updateCard(card.id, { open: { ...(card.open || {}), [catName]: !(card.open || {})[catName] } });
  const removeCategory = (card, cat) => {
    // Removing a step also removes the steps nested under it
    const works = { ...card.works }; const open = { ...(card.open || {}) };
    for (const c of [cat.name, ...nestedDescendants(catalog, card, cat.name)]) { delete works[c]; delete open[c]; }
    updateCard(card.id, { works, open });
  };
  const includeCategory = (card, cat, work) => {
    if (!work) return;
    const works = { ...card.works, [cat.name]: selection(catalog.works, work.name) };
    const open = { ...(card.open || {}), [cat.name]: true };
    const r = applyAutoAdds(catalog.works, card, works, open);
    updateCard(card.id, { works: r.works, open: r.open });
  };
  const cardActions = (card) => ({
    include: (cat, work) => includeCategory(card, cat, work),
    remove: (cat) => removeCategory(card, cat),
    toggleOpen: (catName) => toggleOpen(card, catName),
    pick: (cat, work) => setWork(card, cat, work),
    count: (catName, n) => setCount(card, catName, n),
    quantity: (catName, q) => updateCard(card.id, { works: { ...card.works, [catName]: { ...card.works[catName], quantity: q } } })
  });
  // Changing the measure only changes which works share the card quantity; nothing is dropped.
  const setMeasure = (card, measure) => updateCard(card.id, { measure });
  const addCard = () => setCards((p) => [...p, newCard('', 'sqft')]);

  const handleSubmit = (e) => {
    e?.preventDefault?.();
    setError('');
    if (!estimate || estimate.total <= 0) { setError('Add at least one area with its work and quantity.'); return; }
    if (!form.full_name.trim()) { setError('Please tell us your name.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setError('Please enter a valid email.'); return; }

    setSending(true);
    loopar.call('Couple Quote', 'submit', {
      body: {
        ...form,
        ...project,
        lines: allLines,
        estimated_total: estimate.total,
        source_page: typeof window !== 'undefined' ? window.location.pathname : '/get-a-quote',
        captcha_token: captcha.token,
        _hp: hp,
        _elapsed: Date.now() - (mountTsRef.current || Date.now())
      },
      success: () => setSent(true),
      error: (err) => setError(err?.message || 'We could not send your request. Please try again.'),
      always: () => setSending(false)
    });
  };

  if (loadError) {
    return (
      <div className="w-full flex justify-center px-4 py-24">
        <div className="text-center max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm">
          <AlertTriangle className="h-10 w-10 text-primary mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">Calculator unavailable</h2>
          <p className="text-muted-foreground mb-5">We could not load our price list right now. Please try again, or call us at (857) 253-1930.</p>
          <Button onClick={load}><RefreshCw className="h-4 w-4 mr-2" /> Try again</Button>
        </div>
      </div>
    );
  }

  if (!catalog || !estimate) {
    return (
      <div className="w-full flex justify-center px-4 py-24">
        <div className="w-full max-w-4xl animate-pulse space-y-6">
          <div className="h-8 w-72 max-w-full bg-muted rounded" />
          <div className="h-56 bg-muted rounded-2xl" />
          <div className="h-40 bg-muted rounded-2xl" />
        </div>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="w-full flex justify-center px-4 py-24">
        <div className="w-full max-w-xl p-8 text-center rounded-2xl border border-border bg-card shadow-sm">
          <CheckCircle2 className="h-12 w-12 text-primary mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Request received!</h2>
          <p className="text-muted-foreground mb-5">
            Your preliminary estimate is <span className="font-bold text-foreground">{money(estimate.total, currency)}</span>.
            We will call you shortly to confirm the details and schedule a free on-site visit.
          </p>
          <Button variant="outline" onClick={() => { setSent(false); mountTsRef.current = Date.now(); }}>Request another estimate</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex justify-center">
      <form onSubmit={handleSubmit} className="w-full max-w-4xl flex flex-col gap-10">
        {showHeader && (
          <div>
            <p className="uppercase tracking-wider text-sm font-bold text-primary mb-2">Estimate your project</p>
            <h2 className="text-3xl md:text-4xl font-bold mb-3">Hardwood Floor Quote Calculator</h2>
            <p className="text-muted-foreground max-w-2xl">
              Add one card per job item — install a floor, sand a room, remove carpet, move furniture — and get an instant labor estimate. Final pricing is confirmed after a free on-site visit.
            </p>
          </div>
        )}

        {/* Area cards */}
        <section>
          <SectionTitle hint="One card per area: a room, a hallway, a staircase. Pick everything that area needs — each work type becomes its own line.">Work</SectionTitle>
          <div className="flex flex-col gap-4">
            {cards.map((card, i) => {
              const measure = measureOf(card.measure);
              const selected = Object.keys(card.works);
              const lines = cardLines(card, i).map((l) => ({ ...l, priced: priceLine(catalog.works, l) }));
              const cardTotal = lines.reduce((a, l) => a + (l.priced?.subtotal || 0), 0);
              return (
                <div key={card.id} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end mb-4">
                    <Field label="Area / room" className="md:col-span-5">
                      <Input value={card.area} placeholder={`Area ${i + 1} (e.g. Living room, Main staircase)`} className="h-11 font-semibold" onChange={(e) => updateCard(card.id, { area: e.target.value })} />
                    </Field>
                    <Field label="Measured in" className="md:col-span-3">
                      <Select value={card.measure} onChange={(v) => setMeasure(card, v)} options={MEASURES} />
                    </Field>
                    <Field label={measure.ask} className="md:col-span-3">
                      <Input type="number" min="0" step="1" inputMode="decimal" value={card.quantity} placeholder="0" className="h-11" onChange={(e) => updateCard(card.id, { quantity: e.target.value })} />
                    </Field>
                    <div className="md:col-span-1 flex justify-end">
                      <Button type="button" variant="ghost" size="sm" disabled={cards.length === 1} onClick={() => setCards((p) => p.filter((x) => x.id !== card.id))}><X className="h-4 w-4" /></Button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-4">
                    <div className="text-sm text-muted-foreground -mb-2">What does this area need? Tick every step it needs.</div>
                    <div className="flex flex-col gap-2">
                      {(() => { const hidden = reachableCategories(catalog, card, measure); return categories.filter((cat) => !hidden.has(cat.name) && !nestedUnder(catalog, card, cat.name)); })().map((cat) => (
                        <CategorySection
                          key={cat.name} card={card} cat={cat}
                          options={worksOf(catalog.works, cat.name).filter((w) => fitsCard(w, measure))}
                          catalog={catalog} measure={measure} currency={currency} actions={cardActions(card)}
                        />
                      ))}
                    </div>

                    {lines.length > 0 && (
                      <div className="rounded-xl bg-muted/40 px-4 py-3 text-sm">
                        {categories.filter((cat) => lines.some((l) => catalog.works[l.work]?.category === cat.name)).map((cat) => lines.filter((l) => catalog.works[l.work]?.category === cat.name).map((l, k) => (
                          <div key={`${cat.name}-${k}`} className="flex justify-between gap-3 py-0.5">
                            <span className="text-muted-foreground"><span className="font-medium text-foreground">{cat.title}</span> · {catalog.works[l.work]?.title}{l.priced?.perCount ? ` × ${l.priced.count} ${(l.priced.countLabel || 'coats').toLowerCase()}` : ''} — {measure.value === 'm2' && sharesCardQty(catalog.works[l.work], measure) ? `${card.quantity || 0} m²` : qtyLabelWeb(catalog.works[l.work]?.unit, l.quantity)}</span>
                            <span className="font-medium">{money(l.priced?.subtotal || 0, currency)}{l.priced?.minApplied ? <span className="text-xs text-muted-foreground"> (min)</span> : null}</span>
                          </div>
                        )))}
                        <div className="flex justify-between gap-3 pt-2 mt-1 border-t border-border/60">
                          <span className="font-medium">{card.area || `Area ${i + 1}`}</span>
                          <span className="font-bold">{money(cardTotal, currency)}</span>
                        </div>
                      </div>
                    )}
                    {selected.length === 0 && <p className="text-xs text-muted-foreground">Tick at least one step for this area.</p>}
                  </div>
                </div>
              );
            })}

            <button
              type="button" onClick={addCard}
              className="rounded-2xl border border-dashed border-border py-4 text-sm font-medium hover:border-primary hover:text-primary transition-colors"
            >
              <Plus className="inline h-4 w-4 mr-1 -mt-0.5" /> Add area
            </button>
          </div>
        </section>

        {/* Project details */}
        <section>
          <SectionTitle hint="Helps us plan access and protection. It does not change the estimate.">About the property</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Property type"><Select value={project.property_type} onChange={(v) => setProject({ ...project, property_type: v })} options={PROPERTY_OPTIONS} /></Field>
            <Field label="Floor level"><Select value={project.floor_level} onChange={(v) => setProject({ ...project, floor_level: v })} options={FLOOR_LEVELS} /></Field>
            <Field label="Built before 1978?"><Select value={project.built_before_1978} onChange={(v) => setProject({ ...project, built_before_1978: v })} options={BUILT_OPTIONS} /></Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
            <CheckCard checked={project.elevator} onChange={(v) => setProject({ ...project, elevator: v })} label="Elevator available" />
            <CheckCard checked={project.occupied} onChange={(v) => setProject({ ...project, occupied: v })} label="Home is occupied during the work" />
            <CheckCard checked={project.pets} onChange={(v) => setProject({ ...project, pets: v })} label="Pets in the home" />
          </div>
        </section>

        {/* Breakdown */}
        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <SectionTitle>Estimate breakdown</SectionTitle>
          {estimate.total <= 0 && <p className="text-sm text-muted-foreground">Add an item with its quantity to see pricing.</p>}
          <div className="flex flex-col gap-3">
            {estimate.groups.map((g) => (
              <div key={g.category} className="border-b border-border/60 pb-3 last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{g.title}</span>
                  <span className="font-semibold">{money(g.subtotal, currency)}</span>
                </div>
                <ul className="mt-1 pl-4 text-sm text-muted-foreground">
                  {g.lines.map((l, i) => <li key={i} className="flex justify-between gap-3"><span>{l.label}</span><span>{money(l.subtotal, currency)}</span></li>)}
                </ul>
              </div>
            ))}
            {estimate.project.length > 0 && (
              <div className="border-b border-border/60 pb-3 last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">Job adjustments</span>
                  <span className="font-semibold">{money(estimate.project.reduce((a, l) => a + l.amount, 0), currency)}</span>
                </div>
                <ul className="mt-1 pl-4 text-sm text-muted-foreground">
                  {estimate.project.map((l, i) => <li key={i} className="flex justify-between gap-3"><span>{l.label}</span><span>{money(l.amount, currency)}</span></li>)}
                </ul>
              </div>
            )}
          </div>
          <div className="flex justify-between items-baseline mt-5 pt-4 border-t border-border">
            <span className="font-semibold text-lg">Estimated total</span>
            <span className="text-3xl font-bold">{money(estimate.total, currency)}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            * Prices in USD. Labor estimate — materials, stain colors and site conditions are confirmed on the free visit.
            {estimate.estimatedDays > 0 && ` Estimated duration: about ${estimate.estimatedDays} working day${estimate.estimatedDays === 1 ? '' : 's'} including drying time.`}
          </p>
        </section>

        {/* Contact */}
        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm relative">
          <SectionTitle>Get your formal quote</SectionTitle>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Full name *"><Input className="h-11" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required /></Field>
            <Field label="Email *"><Input className="h-11" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field>
            <Field label="Phone"><Input className="h-11" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Project address"><Input className="h-11" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
            <Field label="City"><Input className="h-11" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
            <Field label="ZIP"><Input className="h-11" value={form.zip_code} onChange={(e) => setForm({ ...form, zip_code: e.target.value })} /></Field>
            <Field label="Anything we should know?" className="md:col-span-2">
              <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>

          {/* Honeypot — invisible to humans, bait for bots */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', top: 'auto', width: '1px', height: '1px', overflow: 'hidden' }}>
            <label htmlFor="cq_hp">Website</label>
            <input id="cq_hp" type="text" name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} />
          </div>

          <CaptchaSlot captcha={captcha} className="mt-4" />
          {error && <p className="text-sm text-destructive mt-3">{error}</p>}

          <Button type="submit" variant="outline" className="w-full h-12 mt-5 text-base" disabled={sending || !captcha.ready}>
            {sending ? 'Sending…' : <>Generate formal quote <ArrowUpRight className="h-4 w-4 ml-1" /></>}
          </Button>
        </section>
      </form>
    </div>
  );
}
