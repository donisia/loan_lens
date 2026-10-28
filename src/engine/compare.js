import { analyzeOffer } from './validate.js';

// Ranks offers by effective annual rate, the only measure that is fair across
// different loan sizes, terms and fee structures. Offers that cannot be fully
// calculated are listed separately rather than guessed at.
export function compareOffers(offers) {
  const analyses = offers.map(analyzeOffer);
  const ranked = analyses
    .filter((a) => a.calculation)
    .sort((a, b) => a.calculation.effectiveAnnualRate - b.calculation.effectiveAnnualRate);
  const notRanked = analyses
    .filter((a) => !a.calculation)
    .map((a) => ({
      name: a.name,
      reason: a.scenarios
        ? 'Interest method unknown; see the range of outcomes.'
        : `Missing information: ${a.missingForCalculation.join(', ')}.`,
    }));

  const lowest = (pick) =>
    ranked.length ? ranked.reduce((best, a) => (pick(a) < pick(best) ? a : best)).name : null;

  return {
    analyses,
    ranking: ranked.map((a, i) => ({
      rank: i + 1,
      name: a.name,
      effectiveAnnualRate: a.calculation.effectiveAnnualRate,
      costOfCredit: a.calculation.totals.costOfCredit,
      costPer100Received: a.calculation.costPer100Received,
      costIsLowerBound: a.costIsLowerBound,
    })),
    notRanked,
    highlights: {
      lowestEffectiveRate: ranked[0]?.name ?? null,
      lowestCostPer100: lowest((a) => a.calculation.costPer100Received),
      lowestTotalRepayment: lowest((a) => a.calculation.totals.repayment),
    },
  };
}
