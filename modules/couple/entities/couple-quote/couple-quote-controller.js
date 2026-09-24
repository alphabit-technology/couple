
'use strict';

import {BaseController, loopar, Op} from 'loopar';
import {botContext, verifyCaptcha} from 'loopar/core/document/web-form.js';
import {loadCatalog} from './couple-quote.js';
import {num} from '../../pricing-engine.js';

/**
 * Public surface for the website quote calculator.
 *   getCatalog → categories + works visible on the web, plus project rules
 *   submit     → creates (or reuses by email) a Couple Customer and a Draft Couple Quote
 */
export default class CoupleQuoteController extends BaseController {
  static publicActions = ['getCatalog', 'submit'];

  // ---- Ownership pilot ------------------------------------------------------
  // A quote is not "created by" the customer (the desk or the public form
  // creates it): its owner is the Couple Customer it belongs to, matched to
  // the logged-in User by email. Used only when a grant on Couple Quote has
  // scope 'own' (e.g. role "Web User" → Couple Quote:view/list own).
  static ownerField = 'customer';

  async #customerNamesOf(user) {
    if (!user) return [];
    const email = String(await loopar.db.getValue('User', 'email', user, {ifNotFound: null}) ?? '')
      .trim().toLowerCase();
    if (!email) return [];
    const rows = await loopar.db.getAll('Couple Customer', ['name'], {email});
    return rows.map(r => r.name);
  }

  async isOwner(name, user = loopar.auth.user()) {
    const row = await loopar.db.getRow(this.document, name, ['customer']);
    if (!row) return null;
    const mine = await this.#customerNamesOf(user);
    return !!row.customer && mine.includes(row.customer);
  }

  async ownerCondition(user = loopar.auth.user()) {
    const mine = await this.#customerNamesOf(user);
    return {customer: {[Op.in]: mine.length ? mine : ['__nobody__']}};
  }

  async publicActionGetCatalog() {
    const {categories, works, rules} = await loadCatalog();
    const visible = (m) => Object.fromEntries(Object.entries(m).filter(([, r]) => num(r.show_on_web, 1) !== 0));
    // Data endpoint: plain object without `message` so the client keeps the payload.
    return {currency: '$', categories: visible(categories), works: visible(works), rules};
  }

  async publicActionSubmit() {
    const data = this.data || this.body || {};

    // Anti-spam: honeypot → silent success (the bot sees OK, nothing is stored);
    // captcha (ALTCHA/Turnstile) is enforced when an integration is active;
    // fast-fill only gets flagged in internal notes so a human can review it.
    const bot = botContext(data);
    if (bot.honeypot) return await this.success('Quote request received');
    const humanVerified = await verifyCaptcha(loopar, data.captcha_token, this.req?.ip);
    const flags = [];
    if (bot.fastFill && !humanVerified) flags.push('fast-fill: form submitted in under 3s');

    const text = (v, max = 200) => String(v ?? '').trim().replace(/<[^>]*>/g, '').slice(0, max);
    const customerName = await this.#resolveCustomer(data);

    // Only structural input is accepted (work key + quantity + label); every amount
    // is recomputed by the model from the catalog.
    const lines = (Array.isArray(data.lines) ? data.lines : []).slice(0, 100).map((l) => ({
      work: text(l?.work, 80),
      category: text(l?.category, 80),
      area: text(l?.area, 80),
      quantity: Math.min(Math.max(num(l?.quantity), 0), 100000),
      count: Math.min(Math.max(Math.round(num(l?.count, 1)), 1), 10),
      notes: text(l?.notes, 300)
    })).filter((l) => l.work);

    const quote = await loopar.newDocument('Couple Quote', {
      customer: customerName,
      status: 'Draft',
      project_address: text(data.project_address || data.address),
      city: text(data.city, 80),
      zip_code: text(data.zip_code, 20),
      property_type: text(data.property_type, 20) || 'house',
      floor_level: text(data.floor_level, 5) || '1',
      elevator: data.elevator ? 1 : 0,
      occupied: data.occupied ? 1 : 0,
      pets: data.pets ? 1 : 0,
      built_before_1978: text(data.built_before_1978, 10) || 'unknown',
      lines,
      notes: text(data.notes, 3000),
      internal_notes: [
        Number.isFinite(parseFloat(data.estimated_total)) ? `Website estimate shown to customer: $${parseFloat(data.estimated_total).toFixed(2)}` : '',
        ...flags
      ].filter(Boolean).join('\n'),
      source_page: text(data.source_page),
      ip_address: this.req?.ip || '',
      submitted_at: new Date().toISOString()
    });

    await quote.save();

    return await this.success('Quote request received');
  }

  /** getDoc only filters by `name` — look customers up by email through getAll. */
  async #resolveCustomer(data) {
    const email = String(data.email || '').trim().toLowerCase();

    if (email) {
      const found = await loopar.db.getAll('Couple Customer', {fields: ['name'], filter: {email}});
      if (found?.length) return found[0].name;
    }

    const customer = await loopar.newDocument('Couple Customer', {
      full_name: data.full_name || data.customer_name || '',
      email,
      phone: data.phone || '',
      address: data.address || '',
      city: data.city || '',
      zip_code: data.zip_code || '',
      customer_type: data.customer_type || 'Homeowner',
      source: 'Website'
    });

    await customer.save();
    return customer.name;
  }
}
