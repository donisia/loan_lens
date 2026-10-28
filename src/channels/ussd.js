// LoanLens USSD menu for borrowers without smartphones.
// Africa's Talking sends `text`: every answer so far joined by "*" (e.g. "1*28500*38640").
// Replies starting "CON " keep the session open; "END " closes it.
//
// USSD sessions time out quickly, so the loan check asks only four questions, using the
// figures a borrower already has from the lender: what they receive, what they repay in
// total, how often and for how long. That is enough to find the true cost and yearly rate.
import { calculateLoan } from '../engine/cost.js';
import { smsQuickCheck } from './sms.js';

const kes = (n) => `KES ${Math.round(n).toLocaleString('en-KE')}`;
const rate = (r) => (Number.isFinite(r) ? `${r * 100 >= 100 ? Math.round(r * 100) : (r * 100).toFixed(1)}%` : 'very high');

const FREQUENCIES = {
  1: { frequency: 'weekly', ask: 'How many weeks?', unit: 'weekly' },
  2: { frequency: 'monthly', ask: 'How many months?', unit: 'monthly' },
  3: { frequency: 'lump-sum', ask: 'In how many days?', unit: null },
};

const MAIN_MENU = 'CON Welcome to LoanLens\nSee the true cost of a loan\n1. Check a loan\n2. Loan tips';

const TIPS =
  'END LoanLens tips:\n' +
  '1. Ask how much you will actually receive.\n' +
  '2. Flat interest costs more than reducing balance.\n' +
  '3. Get all fees and penalties in writing.';

const isAmount = (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
const isCount = (v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 3650;

const STEPS = [
  { prompt: 'How much money will you RECEIVE? (KES)', valid: isAmount, error: 'amount' },
  { prompt: 'How much will you REPAY in total? (KES)', valid: isAmount, error: 'amount' },
  { prompt: 'How will you repay?\n1. Weekly\n2. Monthly\n3. All at once', valid: (v) => Object.hasOwn(FREQUENCIES, v), error: 'choice' },
  { prompt: null, valid: isCount, error: 'number' }, // depends on the previous answer
];

// The difference between what you repay and what you receive is the whole cost of the
// loan, so it is modelled as one charge added to the balance at no further interest.
export function quickCheckOffer(received, repaid, choice, length) {
  const { frequency } = FREQUENCIES[choice];
  return {
    name: 'Your loan',
    principal: received,
    interestRatePercent: 0,
    repaymentFrequency: frequency,
    [frequency === 'lump-sum' ? 'termDays' : 'installments']: length,
    fees: [{ name: 'Interest and fees', amount: repaid - received, timing: 'financed' }],
  };
}

// Returns { response } and, when a loan was checked, { sms: { to, message } } to send afterwards.
export function handleUssd({ text = '', phoneNumber } = {}, { canSendSms = false } = {}) {
  const parts = text === '' ? [] : text.split('*').map((p) => p.trim());
  const [choice, ...answers] = parts;

  if (choice === undefined) return { response: MAIN_MENU };
  if (choice === '2') return { response: TIPS };
  if (choice !== '1') return { response: 'END Invalid choice. Please dial again.' };

  for (const [i, answer] of answers.slice(0, STEPS.length).entries()) {
    if (!STEPS[i].valid(answer)) return { response: `END "${answer}" is not a valid ${STEPS[i].error}. Please dial again.` };
  }
  if (answers.length >= 2 && Number(answers[1]) < Number(answers[0])) {
    return { response: 'END The amount you repay should be more than what you receive. Please dial again.' };
  }
  if (answers.length < STEPS.length) {
    const step = answers.length;
    return { response: `CON ${step === 3 ? FREQUENCIES[answers[2]].ask : STEPS[step].prompt}` };
  }

  const [received, repaid, how, length] = answers;
  const c = calculateLoan(quickCheckOffer(Number(received), Number(repaid), how, Number(length)));
  const { unit } = FREQUENCIES[how];
  const schedule = unit ? `\n${c.installmentCount} ${unit} payments of ${kes(c.installmentAmount)}` : '';
  const sendSms = canSendSms && Boolean(phoneNumber);
  return {
    response:
      `END Cost of this loan: ${kes(c.totals.costOfCredit)}\n` +
      `That is ${kes(c.costPer100Received)} per KES 100 you get${schedule}\n` +
      `Yearly rate: ${rate(c.effectiveAnnualRate)}` +
      (sendSms ? '\nDetails sent by SMS.' : ''),
    sms: sendSms ? { to: phoneNumber, message: smsQuickCheck(c) } : null,
  };
}
