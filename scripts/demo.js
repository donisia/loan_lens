// Prints a plain-language comparison of the sample offers: `npm run demo`
import { compareOffers, formatMoney, formatPercent } from '../src/index.js';
import { sampleOffers } from '../examples/offers.js';

const result = compareOffers(sampleOffers);

for (const a of result.analyses) {
  console.log(`\n=== ${a.name} ===`);
  console.log(a.clarity.summary);

  const c = a.calculation;
  if (c) {
    const m = (x) => formatMoney(x, c.currency);
    console.log(`You receive:        ${m(c.netDisbursed)}`);
    console.log(`You pay in total:   ${m(c.totals.paid)} over ${c.installmentCount} payment(s) of about ${m(c.installmentAmount)}`);
    console.log(`Cost of borrowing:  ${m(c.totals.costOfCredit)} (${m(c.costPer100Received)} per 100 received)`);
    console.log(`Effective rate:     ${formatPercent(c.effectiveAnnualRate)} per year`);
  } else if (a.scenarios) {
    for (const [method, s] of Object.entries(a.scenarios)) {
      console.log(`If ${method}: repay ${formatMoney(s.totals.paid, s.currency)}, effective rate ${formatPercent(s.effectiveAnnualRate)}`);
    }
  } else {
    console.log(`Cannot calculate: missing ${a.missingForCalculation.join(', ')}`);
  }

  for (const check of a.checks) console.log(`[${check.status === 'ok' ? 'OK' : 'MISMATCH'}] ${check.message}`);
  for (const note of a.clarifications) console.log(`[CLARIFY] ${note}`);
  for (const note of a.assumptions) console.log(`[ASSUMPTION] ${note}`);
  if (a.questionsToAsk.length) {
    console.log('Questions to ask the lender:');
    for (const q of a.questionsToAsk) console.log(`  - ${q}`);
  }
}

console.log('\n=== Comparison (by effective annual rate) ===');
for (const r of result.ranking) {
  const caveat = r.costIsLowerBound ? ' (cost may be higher: unquantified fees)' : '';
  console.log(`${r.rank}. ${r.name}: ${formatPercent(r.effectiveAnnualRate)}, ${formatMoney(r.costPer100Received)} per 100 received${caveat}`);
}
for (const n of result.notRanked) console.log(`-  ${n.name}: not ranked. ${n.reason}`);
