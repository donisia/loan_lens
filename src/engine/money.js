export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export const sum = (values) => round2(values.reduce((total, v) => total + v, 0));

export function formatMoney(amount, currency = 'KES') {
  if (amount == null || Number.isNaN(amount)) return 'n/a';
  return `${currency} ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(rate, digits = 1) {
  if (rate == null || Number.isNaN(rate)) return 'n/a';
  if (!Number.isFinite(rate)) return 'very high';
  return `${(rate * 100).toFixed(digits)}%`;
}
