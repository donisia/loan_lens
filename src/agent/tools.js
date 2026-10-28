import { analyzeOffer } from '../engine/validate.js';
import { compareOffers } from '../engine/compare.js';

// JSON schema for one loan offer, mirroring the engine's offer format (src/engine/cost.js).
// Every term is optional: Claude leaves out anything the offer does not state, and the
// engine reports what is missing instead of guessing.
const OFFER_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short label for the offer, e.g. the product or lender type.' },
    currency: { type: 'string', description: 'ISO currency code. Defaults to KES.' },
    principal: { type: 'number', description: 'Loan amount the agreement is written for.' },
    interestRatePercent: { type: 'number', description: 'Quoted interest rate as a percentage (13 means 13%).' },
    ratePeriod: {
      type: 'string',
      enum: ['week', 'month', 'year', 'term'],
      description: "Period the rate applies to. 'term' means the rate is for the whole loan.",
    },
    interestMethod: {
      type: 'string',
      enum: ['reducing', 'flat'],
      description: "'reducing' = charged on the remaining balance; 'flat' = charged on the original amount every period.",
    },
    repaymentFrequency: { type: 'string', enum: ['weekly', 'fortnightly', 'monthly', 'lump-sum'] },
    installments: { type: 'integer', description: 'Number of repayments (not used for lump-sum).' },
    termDays: { type: 'integer', description: 'Loan length in days (lump-sum loans only).' },
    fees: {
      type: 'array',
      description: 'Every fee mentioned. Omit amount and percent if the offer does not quantify the fee.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amount: { type: 'number', description: 'Fixed amount.' },
          percent: { type: 'number', description: 'Percentage of the principal.' },
          timing: {
            type: 'string',
            enum: ['deducted', 'upfront', 'financed', 'per-installment'],
            description:
              "'deducted' = taken from the money disbursed; 'upfront' = paid by the borrower before disbursement; " +
              "'financed' = added to the loan balance; 'per-installment' = added to every repayment.",
          },
        },
        required: ['name', 'timing'],
      },
    },
    penalties: {
      type: 'array',
      description: 'Late-payment or default charges. Omit the whole field if the offer says nothing about penalties.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount: { type: 'number' },
          percent: { type: 'number' },
        },
        required: ['description'],
      },
    },
    stated: {
      type: 'object',
      description: "Figures the lender quotes directly. LoanLens checks them against its own calculation.",
      properties: {
        totalRepayment: { type: 'number' },
        installmentAmount: { type: 'number' },
        netDisbursed: { type: 'number', description: 'Amount the lender says the borrower will receive.' },
        aprPercent: { type: 'number' },
      },
    },
  },
};

export const TOOLS = [
  {
    name: 'analyze_offer',
    description:
      'Calculate the true cost of one loan offer and check it for missing or inconsistent terms. ' +
      'Returns amounts received and repaid, cost of credit, effective annual rate, the Loan Clarity Score, ' +
      'reconciliation checks, assumptions and questions to ask the lender. Use this for a single offer.',
    input_schema: { type: 'object', properties: { offer: OFFER_SCHEMA }, required: ['offer'] },
  },
  {
    name: 'compare_offers',
    description:
      'Analyze two or more loan offers and rank them by effective annual rate. Returns the same analysis as ' +
      'analyze_offer for each offer, plus the ranking and offers that could not be ranked. Use this whenever ' +
      'the borrower has more than one offer.',
    input_schema: {
      type: 'object',
      properties: { offers: { type: 'array', items: OFFER_SCHEMA, minItems: 2 } },
      required: ['offers'],
    },
  },
];

const NUMERIC_FIELDS = ['principal', 'interestRatePercent', 'installments', 'termDays'];
const STATED_FIELDS = ['totalRepayment', 'installmentAmount', 'netDisbursed', 'aprPercent'];

// Tool input is model-generated, so check types before it reaches the arithmetic.
export function assertOfferTypes(offer, label = 'offer') {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) throw new TypeError(`${label} must be an object.`);
  const assertNumber = (value, path) => {
    if (value != null && !Number.isFinite(value)) throw new TypeError(`${path} must be a number, got ${JSON.stringify(value)}.`);
  };
  for (const key of NUMERIC_FIELDS) assertNumber(offer[key], `${label}.${key}`);
  for (const key of STATED_FIELDS) assertNumber(offer.stated?.[key], `${label}.stated.${key}`);
  for (const [i, item] of [...(offer.fees ?? []), ...(offer.penalties ?? [])].entries()) {
    assertNumber(item.amount, `${label} fee/penalty ${i + 1} amount`);
    assertNumber(item.percent, `${label} fee/penalty ${i + 1} percent`);
  }
}

const MAX_SCHEDULE_ROWS = 24;

// Keep tool results compact: long schedules cost tokens and Claude only needs a summary.
function trimAnalysis(analysis) {
  const trimCalc = (c) =>
    c && {
      ...c,
      schedule: c.schedule.length > MAX_SCHEDULE_ROWS ? c.schedule.slice(0, MAX_SCHEDULE_ROWS) : c.schedule,
      scheduleTruncated: c.schedule.length > MAX_SCHEDULE_ROWS,
    };
  return {
    ...analysis,
    calculation: trimCalc(analysis.calculation),
    scenarios: analysis.scenarios && Object.fromEntries(Object.entries(analysis.scenarios).map(([k, v]) => [k, trimCalc(v)])),
  };
}

// Runs a tool call against the engine. Returns { result } for the caller to keep,
// and { content, isError } to send back to Claude.
export function executeTool(name, input) {
  try {
    if (name === 'analyze_offer') {
      assertOfferTypes(input?.offer);
      const result = analyzeOffer(input.offer);
      return { result, content: JSON.stringify(trimAnalysis(result)), isError: false };
    }
    if (name === 'compare_offers') {
      if (!Array.isArray(input?.offers) || input.offers.length < 2) {
        throw new TypeError('"offers" must be an array of at least two offers.');
      }
      input.offers.forEach((offer, i) => assertOfferTypes(offer, `offers[${i}]`));
      const result = compareOffers(input.offers);
      const forClaude = { ...result, analyses: result.analyses.map(trimAnalysis) };
      return { result, content: JSON.stringify(forClaude), isError: false };
    }
    throw new Error(`Unknown tool "${name}".`);
  } catch (err) {
    return { result: null, content: `Error: ${err.message}`, isError: true };
  }
}
