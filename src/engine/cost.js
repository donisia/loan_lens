import { round2, sum } from './money.js';
import { effectiveAnnualRate, nominalApr } from './apr.js';

// An offer describes a loan in the lender's own terms. All rates are percentages
// (13 means 13%). Fields:
//   principal              amount the loan is written for
//   interestRatePercent    quoted interest rate
//   ratePeriod             'week' | 'month' | 'year' | 'term' (whole loan term)
//   interestMethod         'reducing' (declining balance) | 'flat' (on original principal)
//   repaymentFrequency     'weekly' | 'fortnightly' | 'monthly' | 'lump-sum'
//   installments           number of repayments (not needed for lump-sum)
//   termDays               loan length in days (lump-sum only)
//   fees                   [{ name, amount | percent (of principal), timing }]
//                          timing: 'deducted'        taken out of the money disbursed
//                                  'upfront'         paid by the borrower before disbursement
//                                  'financed'        added to the loan balance
//                                  'per-installment' added to every repayment
//   penalties              [{ description, amount?, percent? }]
//   stated                 figures the lender quotes, used for reconciliation:
//                          { totalRepayment, installmentAmount, netDisbursed, aprPercent }

export const RATE_PERIOD_DAYS = { week: 7, month: 365 / 12, year: 365 };
export const FREQUENCY_DAYS = { weekly: 7, fortnightly: 14, monthly: 365 / 12 };
export const INTEREST_METHODS = ['reducing', 'flat'];
export const FEE_TIMINGS = ['deducted', 'upfront', 'financed', 'per-installment'];

export class IncompleteOfferError extends Error {
  constructor(missing) {
    super(`Cannot calculate the loan cost: missing ${missing.join(', ')}`);
    this.name = 'IncompleteOfferError';
    this.missing = missing;
  }
}

const isLumpSum = (offer) => offer.repaymentFrequency === 'lump-sum';

export function missingForCalculation(offer) {
  const missing = [];
  if (!(offer.principal > 0)) missing.push('principal');
  if (offer.interestRatePercent == null) missing.push('interestRatePercent');
  if (offer.interestRatePercent != null && offer.interestRatePercent !== 0 && !offer.ratePeriod) {
    missing.push('ratePeriod');
  }
  if (!offer.repaymentFrequency) {
    missing.push('repaymentFrequency');
  } else if (isLumpSum(offer)) {
    if (!(offer.termDays > 0)) missing.push('termDays');
  } else {
    if (!(offer.installments > 0)) missing.push('installments');
    if (!offer.interestMethod && offer.interestRatePercent) missing.push('interestMethod');
  }
  return missing;
}

function assertKnownValues(offer) {
  const check = (value, allowed, field) => {
    if (value != null && !allowed.includes(value)) {
      throw new TypeError(`Unknown ${field} "${value}". Expected one of: ${allowed.join(', ')}`);
    }
  };
  check(offer.ratePeriod, [...Object.keys(RATE_PERIOD_DAYS), 'term'], 'ratePeriod');
  check(offer.repaymentFrequency, [...Object.keys(FREQUENCY_DAYS), 'lump-sum'], 'repaymentFrequency');
  check(offer.interestMethod, INTEREST_METHODS, 'interestMethod');
  for (const fee of offer.fees ?? []) {
    if (fee.timing == null) throw new TypeError(`Fee "${fee.name}" needs a timing: ${FEE_TIMINGS.join(', ')}`);
    check(fee.timing, FEE_TIMINGS, 'fee timing');
  }
}

export const isQuantified = (item) => item.amount != null || item.percent != null;

const feeAmount = (fee, principal) =>
  round2(fee.amount != null ? fee.amount : (principal * fee.percent) / 100);

function buildSchedule({ amount, rate, count, method, periodDays, feePerInstallment }) {
  const rows = [];
  let balance = amount;

  if (method === 'reducing' && rate > 0) {
    const payment = round2((amount * rate) / (1 - (1 + rate) ** -count));
    for (let n = 1; n <= count; n++) {
      const interest = round2(balance * rate);
      const principal = n === count ? balance : Math.min(balance, round2(payment - interest));
      balance = round2(balance - principal);
      rows.push({ n, principal, interest, balance });
    }
  } else {
    // Flat: interest is charged on the original amount for every period, spread evenly.
    // The last row absorbs rounding so totals are exact.
    const totalInterest = round2(amount * rate * count);
    const principalEach = round2(amount / count);
    const interestEach = round2(totalInterest / count);
    for (let n = 1; n <= count; n++) {
      const last = n === count;
      const principal = last ? balance : principalEach;
      const interest = last ? round2(totalInterest - interestEach * (count - 1)) : interestEach;
      balance = round2(balance - principal);
      rows.push({ n, principal, interest, balance });
    }
  }

  return rows.map((row) => ({
    ...row,
    dueDay: Math.round(row.n * periodDays),
    fees: feePerInstallment,
    payment: round2(row.principal + row.interest + feePerInstallment),
  }));
}

export function calculateLoan(offer) {
  assertKnownValues(offer);
  const missing = missingForCalculation(offer);
  if (missing.length) throw new IncompleteOfferError(missing);

  const lumpSum = isLumpSum(offer);
  const count = lumpSum ? 1 : offer.installments;
  const periodDays = lumpSum ? offer.termDays : FREQUENCY_DAYS[offer.repaymentFrequency];
  const quotedRate = offer.interestRatePercent / 100;
  const rate =
    quotedRate === 0 ? 0
    : offer.ratePeriod === 'term' ? quotedRate / count
    : (quotedRate * periodDays) / RATE_PERIOD_DAYS[offer.ratePeriod];

  const fees = offer.fees ?? [];
  const quantified = fees.filter(isQuantified).map((fee) => ({ ...fee, total: feeAmount(fee, offer.principal) }));
  const byTiming = (timing) => sum(quantified.filter((f) => f.timing === timing).map((f) => f.total));
  const deducted = byTiming('deducted');
  const upfront = byTiming('upfront');
  const financed = byTiming('financed');
  const perInstallment = byTiming('per-installment');

  const amountFinanced = round2(offer.principal + financed);
  const schedule = buildSchedule({
    amount: amountFinanced,
    rate,
    count,
    method: lumpSum ? 'flat' : offer.interestMethod ?? 'flat',
    periodDays,
    feePerInstallment: perInstallment,
  });

  const netDisbursed = round2(offer.principal - deducted);
  const cashInHand = round2(netDisbursed - upfront);
  const totalRepayment = sum(schedule.map((r) => r.payment));
  const totalInterest = sum(schedule.map((r) => r.interest));
  const totalPaid = round2(totalRepayment + upfront);
  const costOfCredit = round2(totalPaid - netDisbursed);
  const ear = effectiveAnnualRate(cashInHand, schedule.map((r) => ({ day: r.n * periodDays, amount: r.payment })));

  return {
    currency: offer.currency ?? 'KES',
    principal: offer.principal,
    amountFinanced,
    netDisbursed,
    cashInHand,
    installmentCount: count,
    installmentAmount: schedule[0].payment,
    periodDays,
    termDays: Math.round(count * periodDays),
    schedule,
    fees: quantified.map(({ name, timing, total }) => ({ name, timing, total })),
    unquantifiedFees: fees.filter((f) => !isQuantified(f)).map((f) => f.name),
    totals: {
      repayment: totalRepayment,
      paid: totalPaid,
      interest: totalInterest,
      fees: round2(deducted + upfront + financed + perInstallment * count),
      costOfCredit,
    },
    costPer100Received: cashInHand > 0 ? round2((costOfCredit / cashInHand) * 100) : null,
    effectiveAnnualRate: ear,
    nominalApr: nominalApr(ear, periodDays),
  };
}
