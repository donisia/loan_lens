// Turns engine results into short SMS text. Plain ASCII only: one non-GSM character
// (like an ellipsis or curly quote) cuts each SMS segment from 160 to 70 characters.

const MAX_LENGTH = 459; // three SMS segments

const kes = (amount, currency = 'KES') => `${currency} ${Math.round(amount).toLocaleString('en-KE')}`;

const rate = (r) => {
  if (r == null || Number.isNaN(r)) return 'n/a';
  if (!Number.isFinite(r)) return 'very high';
  const p = r * 100;
  return `${p >= 100 ? Math.round(p).toLocaleString('en-KE') : p.toFixed(1)}%`;
};

const toAscii = (text) =>
  text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\n]/g, '');

function fit(lines) {
  const text = toAscii(lines.filter(Boolean).join('\n'));
  return text.length <= MAX_LENGTH ? text : `${text.slice(0, MAX_LENGTH - 3).trimEnd()}...`;
}

const FIELD_LABELS = {
  principal: 'loan amount',
  interestRatePercent: 'interest rate',
  ratePeriod: 'rate period',
  interestMethod: 'flat or reducing',
  repaymentFrequency: 'repayment frequency',
  installments: 'number of payments',
  termDays: 'loan length',
};

export function smsSummary(analysis) {
  const c = analysis.calculation;
  const lines = [`LoanLens: ${analysis.name}`];

  if (c) {
    const atLeast = analysis.costIsLowerBound ? 'at least ' : '';
    const schedule = c.installmentCount === 1 ? `in ${c.termDays} days` : `(${c.installmentCount} x ${kes(c.installmentAmount, c.currency)})`;
    lines.push(
      `You get: ${kes(c.netDisbursed, c.currency)}`,
      `You repay: ${atLeast}${kes(c.totals.paid, c.currency)} ${schedule}`,
      `Cost: ${atLeast}${kes(c.totals.costOfCredit, c.currency)}, ${rate(c.effectiveAnnualRate)} a year`,
    );
  } else if (analysis.scenarios) {
    const { flat, reducing } = analysis.scenarios;
    lines.push(`Flat or reducing interest not stated. You repay ${kes(reducing.totals.paid)} to ${kes(flat.totals.paid)}.`);
  } else {
    lines.push(`Can't calculate yet. Ask the lender for: ${analysis.missingForCalculation.map((m) => FIELD_LABELS[m] ?? m).join(', ')}.`);
  }

  lines.push(`Clarity: ${analysis.clarity.score}/${analysis.clarity.outOf} key terms given`);
  const mismatch = analysis.checks.find((ch) => ch.status === 'mismatch');
  if (mismatch) lines.push(`Warning: ${mismatch.message}`);
  const questions = analysis.questionsToAsk.slice(0, 2);
  if (questions.length) lines.push('Ask the lender:', ...questions.map((q, i) => `${i + 1}. ${q}`));
  return fit(lines);
}

// For the USSD quick check, where the borrower gave only what they receive and repay.
export function smsQuickCheck(c) {
  const schedule = c.installmentCount === 1 ? `in ${c.termDays} days` : `(${c.installmentCount} x ${kes(c.installmentAmount, c.currency)})`;
  return fit([
    'LoanLens quick check',
    `You get: ${kes(c.netDisbursed, c.currency)}`,
    `You repay: ${kes(c.totals.paid, c.currency)} ${schedule}`,
    `Cost: ${kes(c.totals.costOfCredit, c.currency)} (${kes(c.costPer100Received, c.currency)} per ${c.currency} 100), ${rate(c.effectiveAnnualRate)} a year`,
    'Before you sign, ask:',
    '1. Are there other fees or insurance not included?',
    '2. What are the penalties if I pay late?',
    '3. Can I repay early and pay less?',
  ]);
}

export function smsComparison(ranking, notRanked = []) {
  const lines = ['LoanLens comparison (yearly cost, lowest first):'];
  lines.push(...ranking.map((r) => `${r.rank}. ${r.name}: ${rate(r.effectiveAnnualRate)}, costs ${kes(r.costOfCredit)}`));
  if (notRanked.length) lines.push(`Not compared: ${notRanked.map((n) => n.name).join(', ')} (missing terms)`);
  return fit(lines);
}
