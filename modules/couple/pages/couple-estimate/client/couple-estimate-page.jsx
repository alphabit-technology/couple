'use strict';

import { PageLayout } from '@loopar/page';
import QuoteCalculator from '../../../quote-calculator.jsx';

const SLOTS = { calculator: () => <QuoteCalculator /> };

export default function CoupleEstimatePage() {
  return <PageLayout slots={SLOTS} />;
}
