// Renders LoanLens results: explanation, comparison, and one card per offer with
// a money breakdown, affordability check, "what if" sliders and sharing.
import { calculateLoan } from '/engine/cost.js';
import { $, $$, esc, money, percent, reducedMotion, wireTooltips } from './util.js';

const FIELD_LABELS = {
  principal: 'loan amount',
  interestRatePercent: 'interest rate',
  ratePeriod: 'what period the rate covers (per month, per year…)',
  interestMethod: 'whether interest is flat or reducing',
  repaymentFrequency: 'how often you repay',
  installments: 'number of payments',
  termDays: 'loan length in days',
};

const PAYMENTS_PER_MONTH = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1 };

const ICONS = {
  receive: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />',
  repay: '<path d="M3 7h18v12H3zM3 11h18M7 15h3" />',
  cost: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.7 2.5 1.8c0 2.4-5 1.4-5 4 0 1.1 1 1.7 2.5 1.7s2.5-.5 2.5-1.5" />',
  rate: '<path d="M4 20L20 4M7 6.5a1.5 1.5 0 100 .01M17 17.5a1.5 1.5 0 100 .01" />',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

// Results state, kept so the affordability check can update without re-rendering.
let state = { analyses: [], income: null, smsEnabled: false };

export function setSmsEnabled(enabled) {
  state.smsEnabled = enabled;
}

/* ---------------- Markdown (Claude's explanation) ---------------- */

// Text is escaped first, then a few markdown patterns are styled.
function renderMarkdown(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{1,4}\s+(.*)$/) || line.match(/^\*\*([^*]+)\*\*:?$/);
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (!line) { closeList(); continue; }
    if (heading) { closeList(); out.push(`<h3>${inline(heading[1])}</h3>`); continue; }
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

/* ---------------- Offer card pieces ---------------- */

function clarityRing(score, outOf) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 64 64" role="img" aria-label="${score} of ${outOf} key terms provided">
    <circle class="track" cx="32" cy="32" r="${r}" fill="none" stroke-width="7"/>
    <circle class="meter" cx="32" cy="32" r="${r}" fill="none" stroke-width="7" stroke-dasharray="${(score / outOf) * c} ${c}"/>
    <text x="32" y="37" text-anchor="middle">${score}/${outOf}</text>
  </svg>`;
}

function tile({ iconName, label, value, detail = '', term, highlight = false, count }) {
  const q = term ? ` <a href="#${term}" class="q" data-term="${term}" aria-label="What is ${esc(label)}?">?</a>` : '';
  const countAttrs = count ? ` data-count="${count.value}" data-kind="${count.kind}" data-currency="${esc(count.currency ?? '')}"` : '';
  return `<div class="tile${highlight ? ' highlight' : ''}">
    <div class="tile-top"><span class="tile-icon">${icon(iconName)}</span><span class="k">${esc(label)}${q}</span></div>
    <div class="v"${countAttrs}>${esc(value)}</div>
    ${detail ? `<div class="d">${esc(detail)}</div>` : ''}
  </div>`;
}

function keyTiles(c, lowerBound) {
  const atLeast = lowerBound ? ' (at least)' : '';
  const repayDetail = c.installmentCount === 1
    ? `One payment after ${c.termDays} days`
    : `${c.installmentCount} payments of about ${money(c.installmentAmount, c.currency)}`;
  const receiveDetail = lowerBound
    ? 'May be less: some fees have no amount yet'
    : c.cashInHand !== c.netDisbursed ? `${money(c.cashInHand, c.currency)} after fees you pay first` : 'Cash in your hands';
  const cur = c.currency;
  return `<div class="tiles">
    ${tile({ iconName: 'receive', label: lowerBound ? 'You receive (up to)' : 'You receive', value: money(c.netDisbursed, cur), detail: receiveDetail, term: 'term-received', count: { value: c.netDisbursed, kind: 'money', currency: cur } })}
    ${tile({ iconName: 'repay', label: `You pay in total${atLeast}`, value: money(c.totals.paid, cur), detail: repayDetail, count: { value: c.totals.paid, kind: 'money', currency: cur } })}
    ${tile({ iconName: 'cost', label: `Cost of borrowing${atLeast}`, value: money(c.totals.costOfCredit, cur), detail: `${money(c.costPer100Received, cur, 2)} for every ${cur} 100 you get`, count: { value: c.totals.costOfCredit, kind: 'money', currency: cur } })}
    ${tile({ iconName: 'rate', label: `Yearly cost rate${atLeast}`, value: percent(c.effectiveAnnualRate), detail: 'Interest and fees as one yearly rate, so loans of any length compare fairly', term: 'term-rate', highlight: true, count: Number.isFinite(c.effectiveAnnualRate) ? { value: c.effectiveAnnualRate, kind: 'percent' } : null })}
  </div>`;
}

// Stacked bar: everything you pay = money you got + interest + fees.
function moneyBreakdown(c) {
  const parts = [
    { key: 'got', label: 'Money you got', value: c.netDisbursed },
    { key: 'interest', label: 'Interest', value: c.totals.interest },
    { key: 'fees', label: 'Fees', value: c.totals.fees },
  ].filter((p) => p.value > 0);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const share = (v) => (v / total) * 100;
  const per100 = (v) => Math.round(share(v));

  const segments = parts
    .map((p) => `<span class="seg seg-${p.key}" style="flex-basis:${share(p.value)}%" data-tip="${esc(`${p.label}: ${money(p.value, c.currency)} (${share(p.value).toFixed(1)}%)`)}"></span>`)
    .join('');
  const legend = parts
    .map((p) => `<li><span class="swatch seg-${p.key}" aria-hidden="true"></span><span class="lg-label">${esc(p.label)}</span><span class="lg-value">${esc(money(p.value, c.currency))}</span><span class="lg-pct">${share(p.value).toFixed(0)}%</span></li>`)
    .join('');
  const costShare = 100 - per100(c.netDisbursed);

  return `<div class="breakdown">
    <div class="block-head"><h3>Where your money goes</h3><span class="muted">Everything you pay: ${esc(money(total, c.currency))}</span></div>
    <div class="stack" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${money(p.value, c.currency)}`).join(', '))}">${segments}</div>
    <ul class="legend">${legend}</ul>
    <p class="insight">Out of every ${esc(c.currency)} 100 you pay back, about <strong>${esc(c.currency)} ${costShare}</strong> is the cost of borrowing.</p>
  </div>`;
}

function affordabilityHtml(c, offer, income) {
  if (!income) {
    return `<p class="muted afford-empty">Add your monthly income above the results to see how these repayments fit your budget.</p>`;
  }
  const lumpSum = offer.repaymentFrequency === 'lump-sum';
  const monthly = lumpSum ? c.totals.paid : c.installmentAmount * PAYMENTS_PER_MONTH[offer.repaymentFrequency];
  const ratio = monthly / income;
  const level = ratio <= 0.2 ? 'good' : ratio <= 1 / 3 ? 'warn' : 'bad';
  const labels = {
    good: ['✓', 'Within a common guideline'],
    warn: ['!', 'Getting tight'],
    bad: ['!', 'Above the one-third guideline'],
  };
  const [sym, label] = labels[level];
  const what = lumpSum
    ? `The single repayment of ${money(monthly, c.currency)} is`
    : `Repayments of about ${money(monthly, c.currency)} a month are`;
  return `<div class="meter-wrap">
      <div class="meter-track" role="img" aria-label="${Math.round(ratio * 100)}% of your monthly income">
        <span class="meter-fill ${level}" style="width:${Math.min(100, ratio * 100)}%"></span>
        <span class="meter-mark" style="left:33.3%" title="One third of income"></span>
      </div>
      <div class="meter-scale"><span>0%</span><span style="left:33.3%">⅓ of income</span><span>100%</span></div>
    </div>
    <p><span class="pill ${level === 'good' ? 'ok' : level === 'warn' ? 'clarify' : 'mismatch'}"><span aria-hidden="true">${sym}</span>${esc(label)}</span>
      ${esc(what)} <strong>${Math.round(ratio * 100)}%</strong> of your monthly income${lumpSum ? ' for one month' : ''}.</p>
    <p class="muted small">Many financial counsellors suggest keeping all loan repayments below about a third of income, including other loans you already have.</p>`;
}

function rangeFor(offer, c) {
  const p = offer.principal;
  const step = p >= 100000 ? 5000 : p >= 20000 ? 1000 : p >= 5000 ? 500 : 100;
  const principal = { min: Math.max(step, Math.round((p * 0.2) / step) * step), max: Math.round((p * 2) / step) * step, step, value: p };
  const lumpSum = offer.repaymentFrequency === 'lump-sum';
  const length = lumpSum
    ? { field: 'termDays', label: 'Loan length', unit: 'days', min: 7, max: Math.max(90, c.termDays * 2), step: 1, value: c.termDays }
    : { field: 'installments', label: 'Number of payments', unit: 'payments', min: 1, max: Math.max(12, c.installmentCount * 2), step: 1, value: c.installmentCount };
  return { principal, length };
}

function whatIfHtml(a, idx) {
  const { principal, length } = rangeFor(a.offer, a.calculation);
  const cur = a.calculation.currency;
  return `<details class="whatif" data-idx="${idx}">
    <summary><span class="whatif-badge">✦ What if…</span> <span>Try a smaller loan or a different number of payments</span></summary>
    <div class="whatif-body">
      <div class="sliders">
        <label class="slider">
          <span class="slider-top"><span>Loan amount</span><output data-out="principal">${esc(money(principal.value, cur))}</output></span>
          <input type="range" data-field="principal" min="${principal.min}" max="${principal.max}" step="${principal.step}" value="${principal.value}">
        </label>
        <label class="slider">
          <span class="slider-top"><span>${esc(length.label)}</span><output data-out="${length.field}">${length.value} ${length.unit}</output></span>
          <input type="range" data-field="${length.field}" data-unit="${length.unit}" min="${length.min}" max="${length.max}" step="${length.step}" value="${length.value}">
        </label>
      </div>
      <div class="whatif-results" aria-live="polite"></div>
      <div class="whatif-foot">
        <p class="muted small">Uses the same rate and fees. A lender may offer different terms for a different amount or length, so confirm with them.</p>
        <button type="button" class="link whatif-reset">Reset</button>
      </div>
    </div>
  </details>`;
}

function updateWhatIf(details) {
  const a = state.analyses[Number(details.dataset.idx)];
  const base = a.calculation;
  const changes = Object.fromEntries($$('input[type=range]', details).map((input) => [input.dataset.field, Number(input.value)]));
  for (const input of $$('input[type=range]', details)) {
    const out = $(`[data-out="${input.dataset.field}"]`, details);
    out.textContent = input.dataset.field === 'principal' ? money(Number(input.value), base.currency) : `${input.value} ${input.dataset.unit}`;
  }
  let c;
  try {
    c = calculateLoan({ ...a.offer, ...changes });
  } catch {
    $('.whatif-results', details).innerHTML = '<p class="muted">LoanLens cannot calculate this combination.</p>';
    return;
  }
  // Lower is better for every figure shown here, except the amount you receive.
  const stat = (label, value, baseValue, fmt, higherIsBetter = false) => {
    const diff = value - baseValue;
    const same = Math.abs(diff) < (fmt === percent ? 0.0005 : 0.5);
    const better = higherIsBetter ? diff > 0 : diff < 0;
    const chip = same
      ? '<span class="delta same">No change</span>'
      : `<span class="delta ${better ? 'better' : 'worse'}">${diff > 0 ? '▲' : '▼'} ${esc(fmt === percent ? `${(Math.abs(diff) * 100).toFixed(1)} pts` : money(Math.abs(diff), base.currency))}</span>`;
    return `<div class="wi-stat"><span class="k">${esc(label)}</span><strong>${esc(fmt === percent ? percent(value) : money(value, base.currency))}</strong>${chip}</div>`;
  };
  $('.whatif-results', details).innerHTML = [
    stat('You receive', c.netDisbursed, base.netDisbursed, money, true),
    stat(c.installmentCount === 1 ? 'Single payment' : 'Each payment', c.installmentAmount, base.installmentAmount, money),
    stat('Cost of borrowing', c.totals.costOfCredit, base.totals.costOfCredit, money),
    stat('Yearly cost rate', c.effectiveAnnualRate, base.effectiveAnnualRate, percent),
  ].join('');
}

function shareText(a) {
  const c = a.calculation;
  const lines = [`LoanLens summary: ${a.name}`];
  if (c) {
    lines.push(
      `You receive: ${money(c.netDisbursed, c.currency)}`,
      `You pay in total: ${money(c.totals.paid, c.currency)}${c.installmentCount > 1 ? ` (${c.installmentCount} payments of about ${money(c.installmentAmount, c.currency)})` : ''}`,
      `Cost of borrowing: ${money(c.totals.costOfCredit, c.currency)}`,
      `Yearly cost rate: ${percent(c.effectiveAnnualRate)}`,
    );
  }
  lines.push(`Loan Clarity: ${a.clarity.score} of ${a.clarity.outOf} key terms given`);
  if (a.questionsToAsk.length) {
    lines.push('', 'Questions to ask the lender:', ...a.questionsToAsk.map((q, i) => `${i + 1}. ${q}`));
  }
  return lines.join('\n');
}

function listItem(kind, label, text) {
  const icons = { ok: '✓', missing: '✕', mismatch: '!', clarify: '?', assume: 'i' };
  return `<li><span class="pill ${kind}"><span aria-hidden="true">${icons[kind]}</span>${esc(label)}</span><span>${esc(text)}</span></li>`;
}

function scheduleTable(c) {
  const rows = c.schedule.map((r) => `<tr><td>${r.n}</td><td>Day ${r.dueDay}</td><td class="num">${esc(money(r.payment, c.currency, 2))}</td>
    <td class="num">${esc(money(r.principal, c.currency, 2))}</td><td class="num">${esc(money(r.interest, c.currency, 2))}</td>
    <td class="num">${esc(money(r.fees, c.currency, 2))}</td><td class="num">${esc(money(r.balance, c.currency, 2))}</td></tr>`).join('');
  return `<details class="schedule"><summary>See the full repayment schedule (${c.installmentCount} payment${c.installmentCount > 1 ? 's' : ''})</summary>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Due</th><th class="num">Payment</th><th class="num">Loan part</th><th class="num">Interest</th><th class="num">Fees</th><th class="num">Still owed</th></tr></thead>
    <tbody>${rows}</tbody></table></div></details>`;
}

function scenarioBlock(scenarios) {
  const box = (title, c) => `<div class="scenario"><h4>${esc(title)}</h4>
    <p>You pay in total: <strong>${esc(money(c.totals.paid, c.currency))}</strong></p>
    <p>Cost of borrowing: ${esc(money(c.totals.costOfCredit, c.currency))}</p>
    <p>Yearly cost rate: ${esc(percent(c.effectiveAnnualRate))}</p></div>`;
  return `<p class="sub">The lender did not say whether interest is flat or reducing, so here are both possibilities. <a href="#term-flat" class="q-link" data-term="term-flat">What's the difference?</a></p>
    <div class="scenario-grid">${box('If interest is on the remaining balance', scenarios.reducing)}${box('If interest is flat (on the original amount)', scenarios.flat)}</div>`;
}

function offerCard(a, idx, rankInfo) {
  const c = a.calculation;
  let summary;
  if (c) summary = keyTiles(c, a.costIsLowerBound);
  else if (a.scenarios) summary = scenarioBlock(a.scenarios);
  else summary = `<div class="notice">LoanLens can't calculate this loan yet. Ask the lender for: ${esc(a.missingForCalculation.map((m) => FIELD_LABELS[m] ?? m).join(', '))}.</div>`;

  const clarityItems = a.clarity.fields.map((f) => listItem(f.status === 'provided' ? 'ok' : 'missing', f.status === 'provided' ? 'Given' : 'Missing', f.label)).join('');
  const checkItems = [
    ...a.checks.map((ch) => listItem(ch.status === 'ok' ? 'ok' : 'mismatch', ch.status === 'ok' ? 'Adds up' : "Doesn't add up", ch.message)),
    ...a.clarifications.map((t) => listItem('clarify', 'Unclear', t)),
    ...a.assumptions.map((t) => listItem('assume', 'Assumed', t)),
  ].join('') || '<li class="muted">The lender did not give totals for LoanLens to check, and nothing else needs flagging.</li>';

  const questions = a.questionsToAsk.length
    ? `<div class="questions"><div class="questions-head"><h3>💬 Questions to ask the lender before you sign</h3>
        <button type="button" class="copy-btn" data-copy="${esc(a.questionsToAsk.join('\n'))}">Copy</button></div>
        <ol>${a.questionsToAsk.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></div>`
    : '';

  const badge = rankInfo
    ? `<span class="rank-badge${rankInfo.rank === 1 ? ' top' : ''}">${rankInfo.rank === 1 ? '★ Lowest yearly cost' : `#${rankInfo.rank} of ${rankInfo.total} by yearly cost`}</span>`
    : '';

  const text = shareText(a);
  return `<article class="card offer-card reveal" style="--delay:${idx * 80}ms">
    <header class="offer-head">
      <div><h2>${esc(a.name)}</h2>${badge}</div>
      <div class="clarity"><div><strong>Loan Clarity</strong><small>key terms the lender gave</small></div>${clarityRing(a.clarity.score, a.clarity.outOf)}</div>
    </header>
    <div class="offer-body">
      ${summary}
      ${c ? `<div class="two-up">${moneyBreakdown(c)}<div class="afford" data-idx="${idx}"><div class="block-head"><h3>Can I afford it?</h3></div><div class="afford-body">${affordabilityHtml(c, a.offer, state.income)}</div></div></div>` : ''}
      ${c ? whatIfHtml(a, idx) : ''}
      <div class="columns">
        <div class="block"><h3>Loan Clarity Score</h3><ul class="list">${clarityItems}</ul></div>
        <div class="block"><h3>Checks</h3><ul class="list">${checkItems}</ul></div>
      </div>
      ${questions}
      ${c ? scheduleTable(c) : ''}
      <div class="share-row">
        <span class="muted small">Share this summary</span>
        <a class="share-btn whatsapp" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">WhatsApp</a>
        <button type="button" class="share-btn" data-copy="${esc(text)}">Copy summary</button>
        <button type="button" class="share-btn" data-print>Print or save PDF</button>
        ${state.smsEnabled
          ? `<button type="button" class="share-btn sms" data-sms-open aria-expanded="false">📱 Send to my phone</button>`
          : '<button type="button" class="share-btn sms" disabled title="SMS is not set up on this server yet">📱 Send by SMS <span class="soon">Off</span></button>'}
      </div>
      <form class="sms-form" data-idx="${idx}" hidden>
        <label><span>Phone number</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" required></label>
        <button type="submit" class="btn btn-primary">Send SMS</button>
        <p class="sms-status small" role="status" aria-live="polite"></p>
      </form>
    </div>
  </article>`;
}

/* ---------------- Comparison ---------------- */

// Horizontal bar chart of the yearly cost rate: one series, one hue, direct value labels,
// drawn at the container's real pixel width so text stays readable on phones.
function comparisonChart(ranking) {
  // Measure the page container: #results is still hidden (empty) when this runs.
  const width = Math.max(280, Math.min(720, $('main.container').clientWidth - 100));
  const narrow = width < 520;
  const labelW = narrow ? 112 : 190;
  const valueW = narrow ? 56 : 90;
  const maxLabel = narrow ? 14 : 24;
  const barH = 26;
  const gap = 18;
  const top = 8;
  const plotW = width - labelW - valueW;
  const finite = ranking.map((r) => r.effectiveAnnualRate).filter(Number.isFinite);
  const max = Math.max(...finite, 0.01);
  const height = top + ranking.length * (barH + gap);

  const ticks = [0, 0.5, 1].map((t) => {
    const x = labelW + t * plotW;
    return `<line class="grid-line" x1="${x}" x2="${x}" y1="0" y2="${height - gap / 2}"/>
      <text class="axis-text" x="${x}" y="${height + 6}" text-anchor="middle">${esc(percent(max * t))}</text>`;
  }).join('');

  const bars = ranking.map((r, i) => {
    const y = top + i * (barH + gap);
    const rate = Number.isFinite(r.effectiveAnnualRate) ? r.effectiveAnnualRate : max;
    const w = Math.max(6, (rate / max) * plotW);
    const rad = Math.min(4, w / 2);
    // Square at the baseline, 4px rounded at the data end.
    const path = `M${labelW},${y} h${w - rad} a${rad},${rad} 0 0 1 ${rad},${rad} v${barH - 2 * rad} a${rad},${rad} 0 0 1 -${rad},${rad} h-${w - rad} z`;
    const label = r.name.length > maxLabel ? `${r.name.slice(0, maxLabel - 1)}…` : r.name;
    const tipText = `${r.name}: ${percent(r.effectiveAnnualRate)} a year · ${money(r.costPer100Received, 'KES', 2)} per KES 100 received`;
    return `<g class="bar-row" data-tip="${esc(tipText)}">
      <rect x="0" y="${y - gap / 2}" width="${width}" height="${barH + gap}" fill="transparent"/>
      <text class="label" x="${labelW - 12}" y="${y + barH / 2 + 5}" text-anchor="end">${esc(label)}</text>
      <path class="bar" d="${path}"/>
      <text class="value" x="${labelW + w + 8}" y="${y + barH / 2 + 5}">${esc(percent(r.effectiveAnnualRate))}</text>
    </g>`;
  }).join('');

  return `<div class="chart"><svg viewBox="0 0 ${width} ${height + 14}" role="img" aria-label="Yearly cost rate by offer, lowest first">${ticks}${bars}</svg></div>`;
}

function comparisonTable(ranking, currency = 'KES') {
  return `<table><thead><tr><th>Rank</th><th>Offer</th><th class="num">Yearly cost rate</th><th class="num">Cost per ${currency} 100</th><th class="num">Total cost</th></tr></thead><tbody>
    ${ranking.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.name)}${r.costIsLowerBound ? ' <span class="muted">(may cost more)</span>' : ''}</td>
      <td class="num">${esc(percent(r.effectiveAnnualRate))}</td><td class="num">${esc(money(r.costPer100Received, currency, 2))}</td>
      <td class="num">${esc(money(r.costOfCredit, currency))}</td></tr>`).join('')}
  </tbody></table>`;
}

function comparisonCard(comparison) {
  const { ranking, notRanked } = comparison;
  if (!ranking.length) {
    return `<section class="card compare reveal"><h2>Comparison</h2><p class="sub">None of the offers had enough information to compare. See each offer below for what is missing.</p></section>`;
  }
  const best = ranking[0];
  const worst = ranking.at(-1);
  const headline = ranking.length > 1 && Number.isFinite(worst.effectiveAnnualRate)
    ? `<div class="headline"><span class="headline-icon" aria-hidden="true">★</span><p><strong>${esc(best.name)}</strong> has the lowest yearly cost at <strong>${esc(percent(best.effectiveAnnualRate))}</strong>. ${esc(worst.name)} costs about <strong>${Math.round(worst.effectiveAnnualRate / Math.max(best.effectiveAnnualRate, 0.0001))}×</strong> as much per year.</p></div>`
    : '';
  const notRankedHtml = notRanked.length
    ? `<p class="not-ranked"><strong>Not compared:</strong> ${notRanked.map((n) => `${esc(n.name)}: ${esc(n.reason)}`).join(' · ')}</p>`
    : '';
  return `<section class="card compare reveal">
    <div class="compare-head">
      <div><p class="section-title">Comparison</p><h2>Yearly cost rate, lowest first</h2></div>
      <button type="button" class="link view-toggle" data-view="table">Show as table</button>
    </div>
    <p class="sub">Includes interest and all quantified fees, adjusted for how long you borrow. A short loan can look cheap in shillings but cost a lot per year.</p>
    ${headline}
    <div class="view view-chart">${comparisonChart(ranking)}</div>
    <div class="view view-table" hidden>${comparisonTable(ranking)}</div>
    ${notRankedHtml}
  </section>`;
}

/* ---------------- Toolbar + rendering ---------------- */

function toolbar(count) {
  return `<div class="toolbar card reveal">
    <div>
      <p class="section-title">Your results</p>
      <h2>${count === 1 ? '1 offer checked' : `${count} offers checked`}</h2>
    </div>
    <label class="income">
      <span>Your monthly income <small>(optional, stays on this device)</small></span>
      <span class="income-input"><span>KES</span><input id="income" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. 35000" value="${state.income ?? ''}"></span>
    </label>
  </div>`;
}

function updateAffordability() {
  for (const el of $$('.afford')) {
    const a = state.analyses[Number(el.dataset.idx)];
    $('.afford-body', el).innerHTML = affordabilityHtml(a.calculation, a.offer, state.income);
  }
}

function animateCounts(root) {
  if (reducedMotion()) return;
  for (const el of $$('[data-count]', root)) {
    const target = Number(el.dataset.count);
    const fmt = el.dataset.kind === 'percent' ? (v) => percent(v) : (v) => money(v, el.dataset.currency);
    const start = performance.now();
    const duration = 900;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = fmt(target * (1 - (1 - t) ** 3));
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}

export function renderResults({ explanation, analyses = [], comparison }) {
  state = { ...state, analyses };
  const ranks = new Map((comparison?.ranking ?? []).map((r) => [r.name, { rank: r.rank, total: comparison.ranking.length }]));
  const parts = [];
  if (analyses.length) parts.push(toolbar(analyses.length));
  if (explanation) {
    parts.push(`<section class="card explanation reveal"><p class="section-title">✦ LoanLens explains</p>${renderMarkdown(explanation)}</section>`);
  }
  if (comparison) parts.push(comparisonCard(comparison));
  parts.push(...analyses.map((a, i) => offerCard(a, i, ranks.get(a.name))));
  if (!parts.length) parts.push('<section class="card panel">LoanLens could not find a loan offer to analyze. Try pasting the full terms.</section>');

  const results = $('#results');
  results.innerHTML = parts.join('');
  $$('.whatif', results).forEach(updateWhatIf);
  animateCounts(results);
  results.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/* ---------------- Events (wired once) ---------------- */

async function sendSmsSummary(form) {
  const status = $('.sms-status', form);
  const button = $('button', form);
  const a = state.analyses[Number(form.dataset.idx)];
  button.disabled = true;
  status.className = 'sms-status small';
  status.textContent = 'Sending…';
  try {
    const res = await fetch('/api/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: $('input', form).value, offer: a.offer }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    status.classList.add('ok');
    status.textContent = `✓ Sent to ${data.to}. Check your messages.`;
  } catch (err) {
    status.classList.add('error');
    status.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

export function initResults() {
  const results = $('#results');
  wireTooltips(results);

  results.addEventListener('submit', (e) => {
    const form = e.target.closest('.sms-form');
    if (form) {
      e.preventDefault();
      sendSmsSummary(form);
    }
  });

  results.addEventListener('input', (e) => {
    if (e.target.id === 'income') {
      const value = Number(e.target.value);
      state.income = value > 0 ? value : null;
      updateAffordability();
    }
    const whatif = e.target.closest('.whatif');
    if (whatif && e.target.type === 'range') updateWhatIf(whatif);
  });

  results.addEventListener('click', async (e) => {
    const toggle = e.target.closest('.view-toggle');
    if (toggle) {
      const card = toggle.closest('.compare');
      const showTable = toggle.dataset.view === 'table';
      $('.view-chart', card).hidden = showTable;
      $('.view-table', card).hidden = !showTable;
      toggle.dataset.view = showTable ? 'chart' : 'table';
      toggle.textContent = showTable ? 'Show as chart' : 'Show as table';
    }

    const reset = e.target.closest('.whatif-reset');
    if (reset) {
      const details = reset.closest('.whatif');
      const a = state.analyses[Number(details.dataset.idx)];
      const { principal, length } = rangeFor(a.offer, a.calculation);
      $('[data-field=principal]', details).value = principal.value;
      $(`[data-field=${length.field}]`, details).value = length.value;
      updateWhatIf(details);
    }

    if (e.target.closest('[data-print]')) window.print();

    const smsOpen = e.target.closest('[data-sms-open]');
    if (smsOpen) {
      const form = $('.sms-form', smsOpen.closest('.offer-body'));
      form.hidden = !form.hidden;
      smsOpen.setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) $('input', form).focus();
    }

    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const original = copy.textContent;
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        copy.textContent = 'Copied ✓';
      } catch {
        copy.textContent = 'Copy failed';
      }
      setTimeout(() => { copy.textContent = original; }, 2000);
    }
  });
}
