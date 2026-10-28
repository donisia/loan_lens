// Effective annual rate (EAR) solved from actual cash flows: the borrower receives
// `cashReceived` on day 0 and makes `payments` ({ day, amount }) afterwards.
// Uses bisection so it never diverges, even for very expensive short-term loans.

const DAYS_PER_YEAR = 365;
const MAX_RATE = 1e9;

export function effectiveAnnualRate(cashReceived, payments) {
  if (!(cashReceived > 0) || payments.length === 0) return null;

  const presentValue = (ear) =>
    payments.reduce((pv, p) => pv + p.amount / (1 + ear) ** (p.day / DAYS_PER_YEAR), 0);

  let lo = -0.9999;
  let hi = 1;
  while (presentValue(hi) > cashReceived) {
    hi *= 2;
    if (hi > MAX_RATE) return Infinity;
  }

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (presentValue(mid) > cashReceived) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Nominal APR for a given period length, equivalent to the effective annual rate.
export function nominalApr(ear, periodDays) {
  if (ear == null || !Number.isFinite(ear)) return ear;
  const periodsPerYear = DAYS_PER_YEAR / periodDays;
  return ((1 + ear) ** (1 / periodsPerYear) - 1) * periodsPerYear;
}
