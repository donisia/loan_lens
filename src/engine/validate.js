import { calculateLoan, missingForCalculation, isQuantified, INTEREST_METHODS } from './cost.js';
import { formatMoney, formatPercent } from './money.js';

// The Loan Clarity Score measures how completely and consistently an offer can be
// understood. It does not judge whether a loan or lender is good or bad.

const CLARITY_FIELDS = [
  {
    key: 'principal',
    label: 'Loan amount (principal)',
    provided: (o) => o.principal > 0,
    question: 'What is the exact loan amount the agreement is written for?',
  },
  {
    key: 'netDisbursed',
    label: 'Amount you actually receive',
    provided: (o) => o.stated?.netDisbursed != null,
    question: 'After all deductions, exactly how much money will arrive in my account?',
  },
  {
    key: 'interestRate',
    label: 'Interest rate and the period it applies to',
    provided: (o) => o.interestRatePercent != null && (o.interestRatePercent === 0 || !!o.ratePeriod),
    question: 'What is the interest rate, and is it per week, per month or per year?',
  },
  {
    key: 'interestMethod',
    label: 'How interest is calculated (flat or reducing balance)',
    provided: (o) => o.repaymentFrequency === 'lump-sum' || INTEREST_METHODS.includes(o.interestMethod),
    question: 'Is interest charged on the original amount (flat) or on the remaining balance (reducing)?',
  },
  {
    key: 'fees',
    label: 'All fees, with amounts',
    provided: (o) => Array.isArray(o.fees) && o.fees.every(isQuantified),
    question: 'Can you list every fee (processing, insurance, excise duty, etc.) with its exact amount?',
  },
  {
    key: 'schedule',
    label: 'Repayment schedule (how often and how many payments)',
    provided: (o) =>
      o.repaymentFrequency === 'lump-sum' ? o.termDays > 0 : !!o.repaymentFrequency && o.installments > 0,
    question: 'How often do I repay, how many payments are there, and on which dates?',
  },
  {
    key: 'totalRepayment',
    label: 'Total amount to repay',
    provided: (o) => o.stated?.totalRepayment != null,
    question: 'What is the total amount I will have repaid by the end of the loan, including all fees?',
  },
];

const withinTolerance = (stated, computed) => Math.abs(stated - computed) <= Math.max(1, Math.abs(computed) * 0.005);

function reconcile(offer, calc) {
  const checks = [];
  const stated = offer.stated ?? {};
  const money = (x) => formatMoney(x, calc.currency);

  const compareMoney = (key, label, computed) => {
    if (stated[key] == null) return;
    const ok = withinTolerance(stated[key], computed);
    checks.push({
      id: key,
      status: ok ? 'ok' : 'mismatch',
      message: ok
        ? `${label} reconciles: stated ${money(stated[key])}, calculated ${money(computed)}.`
        : `${label} does not reconcile: stated ${money(stated[key])}, but the terms give ${money(computed)}.`,
    });
  };

  compareMoney('totalRepayment', 'Total repayment', calc.totals.repayment);
  compareMoney('installmentAmount', 'Installment amount', calc.installmentAmount);
  compareMoney('netDisbursed', 'Amount received', calc.netDisbursed);

  if (stated.aprPercent != null && calc.effectiveAnnualRate != null) {
    // Lenders quote APR in different conventions, so accept either nominal or effective within 1 point.
    const candidates = [calc.nominalApr, calc.effectiveAnnualRate].map((r) => r * 100);
    const ok = candidates.some((r) => Math.abs(r - stated.aprPercent) <= 1);
    checks.push({
      id: 'aprPercent',
      status: ok ? 'ok' : 'mismatch',
      message: ok
        ? `Stated APR of ${stated.aprPercent}% is consistent with the terms.`
        : `Stated APR of ${stated.aprPercent}% does not match the terms (about ${formatPercent(calc.nominalApr)} nominal, ${formatPercent(calc.effectiveAnnualRate)} effective).`,
    });
  }
  return checks;
}

export function analyzeOffer(offer) {
  const name = offer.name ?? 'Unnamed offer';
  const fields = CLARITY_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    status: f.provided(offer) ? 'provided' : 'missing',
  }));
  const questions = CLARITY_FIELDS.filter((f, i) => fields[i].status === 'missing').map((f) => f.question);
  const clarifications = [];
  const assumptions = [];

  for (const fee of offer.fees ?? []) {
    if (!isQuantified(fee)) {
      clarifications.push(`The "${fee.name}" fee is mentioned but not quantified, so it is not included in the cost.`);
    }
  }
  if (offer.penalties == null) {
    questions.push('What happens if I pay late or miss a payment? What are the exact penalty charges?');
  } else {
    for (const p of offer.penalties) {
      if (!isQuantified(p)) {
        clarifications.push(`Penalty "${p.description}" is mentioned but not quantified.`);
        questions.push(`How exactly is "${p.description}" calculated?`);
      }
    }
  }

  let calculation = null;
  let scenarios = null;
  let checks = [];
  const missing = missingForCalculation(offer);

  if (missing.length === 0) {
    calculation = calculateLoan(offer);
    checks = reconcile(offer, calculation);
    for (const c of checks.filter((c) => c.status === 'mismatch')) {
      questions.push(`Please explain this difference: ${c.message}`);
    }
  } else if (missing.length === 1 && missing[0] === 'interestMethod') {
    // Show the range of possible outcomes instead of guessing.
    scenarios = Object.fromEntries(
      INTEREST_METHODS.map((m) => [m, calculateLoan({ ...offer, interestMethod: m })]),
    );
    assumptions.push('Interest method not stated: showing both reducing-balance and flat-rate outcomes.');
  }

  if (offer.ratePeriod === 'month' && ['weekly', 'fortnightly'].includes(offer.repaymentFrequency)) {
    assumptions.push(
      'A monthly rate was converted to a weekly one using calendar months (about 4.35 weeks). ' +
        'Lenders that count 4 weeks as a month will charge more than shown.',
    );
  }
  if (!Array.isArray(offer.fees)) {
    assumptions.push('No fees were listed; the cost assumes there are none.');
  }
  if (calculation?.unquantifiedFees.length) {
    assumptions.push('Some fees could not be quantified, so the true cost may be higher than shown.');
  }

  const provided = fields.filter((f) => f.status === 'provided').length;
  return {
    name,
    offer,
    calculation,
    scenarios,
    missingForCalculation: missing.filter((m) => !(scenarios && m === 'interestMethod')),
    clarity: {
      score: provided,
      outOf: fields.length,
      summary: `Terms completeness: ${provided} of ${fields.length} key fields provided.`,
      fields,
    },
    checks,
    clarifications,
    assumptions,
    questionsToAsk: questions,
    costIsLowerBound: (offer.fees ?? []).some((f) => !isQuantified(f)),
  };
}
