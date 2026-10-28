export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const money = (amount, currency = 'KES', digits = 0) =>
  amount == null || Number.isNaN(amount)
    ? 'n/a'
    : `${currency} ${amount.toLocaleString('en-KE', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const percent = (rate) => {
  if (rate == null || Number.isNaN(rate)) return 'n/a';
  if (!Number.isFinite(rate)) return 'Very high';
  const p = rate * 100;
  return `${p >= 100 ? Math.round(p).toLocaleString('en-KE') : p.toFixed(1)}%`;
};

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// One shared tooltip for any element with data-tip (text, escaped on display).
export function wireTooltips(root) {
  const tip = $('#tooltip');
  root.addEventListener('pointermove', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) { tip.hidden = true; return; }
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    tip.style.left = `${e.clientX}px`;
    tip.style.top = `${e.clientY}px`;
  });
  root.addEventListener('pointerleave', () => { tip.hidden = true; });
}
