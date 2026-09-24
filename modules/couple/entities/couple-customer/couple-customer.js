
'use strict';

import {BaseDocument, loopar} from 'loopar';

export default class CoupleCustomer extends BaseDocument {
  async beforeSave() {
    const clean = (v) => (v == null ? '' : String(v).trim().replace(/<[^>]*>/g, ''));

    this.full_name = clean(this.full_name);
    this.email = clean(this.email).toLowerCase();
    this.phone = clean(this.phone);

    if (!this.full_name) loopar.throw('Full Name is required');
    if (this.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email)) loopar.throw('Invalid email address');
  }
}
