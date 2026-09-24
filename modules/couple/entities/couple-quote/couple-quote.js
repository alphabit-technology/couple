
'use strict';

import {BaseDocument, loopar, Op} from 'loopar';
import { computeQuote, computeTotals, num, round2 } from '../../pricing-engine.js';

const toRows = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && loopar.utils.isJSON(v)) {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
};
const isoDate = (d) => d.toISOString().slice(0, 10);
const keyed = (rows, mapFn = (r) => r) => Object.fromEntries((rows || []).map((r) => [r.name, mapFn(r)]));

/** Catalog in the shape pricing-engine expects. getAll: getList paginates (5 rows) and would drop most rows. */
export async function loadCatalog() {
  const [categories, works, rules] = await Promise.all([
    loopar.db.getAll('Couple Work Category', {fields: ['name', 'title', 'order', 'icon', 'area_label', 'show_on_web', 'description'], filter: {active: 1}}),
    loopar.db.getAll('Couple Work', {fields: ['name', 'category', 'title', 'unit', 'rate', 'min_charge', 'default_quantity', 'parents', 'auto_add', 'per_count', 'count_label', 'default_count', 'show_on_web', 'web_hint', 'order', 'description'], filter: {active: 1}}),
    loopar.db.getAll('Couple Pricing Config', {fields: ['name', 'title', 'mode', 'rate', 'tier_from_sqft', 'tier_to_sqft', 'order'], filter: {active: 1}})
  ]);

  return {
    categories: keyed(categories, (r) => ({...r, order: num(r.order)})),
    works: keyed(works, (r) => ({...r, rate: num(r.rate), min_charge: num(r.min_charge), order: num(r.order)})),
    rules: keyed(rules, (r) => ({...r, rate: num(r.rate)}))
  };
}

/**
 * Couple Quote — list of work lines (Category ▸ Work ▸ quantity).
 * Line pricing lives in pricing-engine.js (shared with the website calculator);
 * this model adds numbering, dates and the discount/tax/deposit tail.
 */
export default class CoupleQuote extends BaseDocument {
  async beforeSave() {
    if (this.__IS_NEW__) {
      this.name = await this.nextQuoteNumber();
      this.status = this.status || 'Draft';
      // date_time fields persist NOW when left unset — keep them null on desk-created quotes.
      this.submitted_at = this.submitted_at || null;
      this.sent_at = null;
      this.decided_at = null;
    }

    const quoteDate = this.quote_date ? new Date(this.quote_date) : new Date();
    if (!this.quote_date) this.quote_date = isoDate(quoteDate);
    if (!this.valid_until) {
      const until = new Date(quoteDate);
      until.setDate(until.getDate() + 30);
      this.valid_until = isoDate(until);
    }

    await this.computeTotals();
  }

  async computeTotals() {
    const catalog = await loadCatalog();
    const priced = computeQuote(catalog, {
      lines: toRows(await this.lines),
      rush: this.rush,
      contingency_pct: this.contingency_pct,
      material_provided_by: this.material_provided_by,
      material_cost: this.material_cost,
      material_markup_pct: this.material_markup_pct
    });

    this.lines = priced.lines;
    this.service_type = priced.serviceType;
    this.total_sqft = priced.totalSqft;
    this.labor_subtotal = priced.labor;
    this.tier_adjustment = priced.adjustments.tier;
    this.rush_adjustment = priced.adjustments.rush;
    this.minimum_adjustment = priced.adjustments.minimum;
    this.contingency_amount = priced.adjustments.contingency;
    this.material_subtotal = priced.materialSubtotal;

    // Percentages are clamped (0–100) and written back so what's stored is what was applied.
    const t = computeTotals(priced, this);
    this.contingency_pct = priced.adjustments.contingencyPct;
    this.discount_percent = t.discountPct;
    this.tax_percent = t.taxPct;
    this.deposit_percent = t.depositPct;

    this.subtotal = priced.subtotal;
    this.discount_amount = t.discount;
    this.tax_amount = t.tax;          // MA: labor is not taxed — materials only.
    this.total = t.total;
    this.deposit_amount = t.deposit;
  }

  /** CQ-YYYYMM-#### — sequential within the month. */
  async nextQuoteNumber() {
    const now = new Date();
    const prefix = `CQ-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-`;

    let count = 0;
    try {
      count = await loopar.db.count('Couple Quote', {name: {[Op.like]: `${prefix}%`}});
    } catch (e) {
      console.warn('[couple] Could not count quotes for numbering:', e.message);
    }

    return `${prefix}${String(num(count) + 1).padStart(4, '0')}`;
  }
}
