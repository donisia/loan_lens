import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoan, analyzeOffer, compareOffers, effectiveAnnualRate, IncompleteOfferError } from '../src/index.js';
import { sampleOffers } from '../examples/offers.js';

const base = {
  principal: 100000,
  interestRatePercent: 12,
  ratePeriod: 'year',
  interestMethod: 'reducing',
  repaymentFrequency: 'monthly',
  installments: 12,
  fees: [],
};

test('reducing balance matches the standard amortization formula', () => {
  const c = calculateLoan(base);
  assert.equal(c.installmentAmount, 8884.88);
  assert.equal(c.schedule.at(-1).balance, 0);
  assert.equal(c.totals.interest, Math.round((c.totals.repayment - 100000) * 100) / 100);
  // With no fees, the nominal APR equals the quoted rate.
  assert.ok(Math.abs(c.nominalApr - 0.12) < 1e-6);
});

test('flat rate charges interest on the original principal every period', () => {
  const c = calculateLoan({ ...base, principal: 10000, interestRatePercent: 10, ratePeriod: 'month', interestMethod: 'flat', installments: 4 });
  assert.equal(c.totals.interest, 4000);
  assert.equal(c.totals.repayment, 14000);
  assert.equal(c.installmentAmount, 3500);
});

test('flat rate rounding residue is absorbed so totals are exact', () => {
  const c = calculateLoan({ ...base, principal: 10000, interestRatePercent: 10, ratePeriod: 'month', interestMethod: 'flat', installments: 3 });
  assert.equal(c.totals.repayment, 13000);
  assert.equal(c.schedule.at(-1).balance, 0);
});

test('deducted fees reduce money received and raise the effective rate', () => {
  const noFee = calculateLoan(base);
  const withFee = calculateLoan({ ...base, fees: [{ name: 'Processing', percent: 3, timing: 'deducted' }] });
  assert.equal(withFee.netDisbursed, 97000);
  assert.ok(Math.abs(withFee.totals.costOfCredit - (noFee.totals.costOfCredit + 3000)) < 0.005);
  assert.ok(withFee.effectiveAnnualRate > noFee.effectiveAnnualRate);
});

test('financed and per-installment fees are repaid with the loan', () => {
  const c = calculateLoan({
    ...base,
    interestRatePercent: 0,
    fees: [
      { name: 'Insurance', amount: 1200, timing: 'financed' },
      { name: 'Ledger fee', amount: 50, timing: 'per-installment' },
    ],
  });
  assert.equal(c.netDisbursed, 100000);
  assert.equal(c.totals.repayment, 101200 + 600);
  assert.equal(c.totals.fees, 1800);
});

test('lump-sum mobile loan: 7.5% for 30 days', () => {
  const c = calculateLoan(sampleOffers.find((o) => o.name === 'Mobile app loan'));
  assert.equal(c.totals.repayment, 5375);
  assert.ok(Math.abs(c.nominalApr - 0.075 * (365 / 30)) < 1e-6);
  assert.ok(Math.abs(c.effectiveAnnualRate - (1.075 ** (365 / 30) - 1)) < 1e-6);
});

test('effective rate solver handles zero cost and extreme cost', () => {
  assert.ok(Math.abs(effectiveAnnualRate(1000, [{ day: 30, amount: 1000 }])) < 1e-9);
  assert.equal(effectiveAnnualRate(1000, [{ day: 1, amount: 2000 }]), Infinity);
  assert.equal(effectiveAnnualRate(0, [{ day: 30, amount: 100 }]), null);
});

test('incomplete offers throw with the list of missing fields', () => {
  assert.throws(() => calculateLoan({ principal: 1000 }), (err) => {
    assert.ok(err instanceof IncompleteOfferError);
    assert.deepEqual(err.missing, ['interestRatePercent', 'repaymentFrequency']);
    return true;
  });
  assert.throws(() => calculateLoan({ ...base, interestMethod: 'compound' }), TypeError);
});

test('clarity score counts provided key fields and reconciles stated figures', () => {
  const a = analyzeOffer(sampleOffers[0]);
  assert.equal(a.clarity.score, 7);
  assert.ok(a.checks.length === 3 && a.checks.every((c) => c.status === 'ok'));
});

test('mismatches, unquantified fees and penalties become questions', () => {
  const a = analyzeOffer(sampleOffers.find((o) => o.name === 'Microfinance group loan'));
  assert.equal(a.clarity.score, 5);
  assert.equal(a.checks.find((c) => c.id === 'totalRepayment').status, 'mismatch');
  assert.ok(a.costIsLowerBound);
  assert.ok(a.clarifications.some((c) => c.includes('Insurance')));
  assert.ok(a.clarifications.some((c) => c.includes('Penalty charges on arrears')));
  assert.ok(a.questionsToAsk.some((q) => q.includes('explain this difference')));
});

test('unknown interest method yields a range instead of a guess', () => {
  const a = analyzeOffer(sampleOffers.find((o) => o.name === 'Shop credit offer'));
  assert.equal(a.calculation, null);
  assert.ok(a.scenarios.flat.totals.repayment > a.scenarios.reducing.totals.repayment);
  assert.ok(a.questionsToAsk.some((q) => q.includes('flat')));
});

test('comparison ranks calculable offers by effective rate', () => {
  const r = compareOffers(sampleOffers);
  assert.deepEqual(
    r.ranking.map((x) => x.name),
    ['SACCO development loan', 'Bank personal loan', 'Mobile app loan', 'Microfinance group loan'],
  );
  assert.equal(r.notRanked[0].name, 'Shop credit offer');
  assert.equal(r.highlights.lowestEffectiveRate, 'SACCO development loan');
});
