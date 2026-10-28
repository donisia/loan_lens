// LoanLens borrower interface. No framework: small render helpers over the JSON API.
import { $, $$, esc } from './util.js';
import { renderResults, initResults, setSmsEnabled } from './results.js';

const SAMPLE_SMS =
  'Dear Customer, you qualify for a loan of KES 30,000 from QuickPesa Credit. Interest 8% per month flat. ' +
  'Repay KES 2,415 weekly for 16 weeks. A processing fee of 5% will be deducted at disbursement. ' +
  'Insurance applies. Late payments attract penalties. Reply YES to accept.';

const SAMPLE_OFFERS = [
  {
    name: 'Bank personal loan', principal: 100000, interestRatePercent: 14, ratePeriod: 'year', interestMethod: 'reducing',
    repaymentFrequency: 'monthly', installments: 12,
    fees: [{ name: 'Processing fee', percent: 2.5, timing: 'deducted' }, { name: 'Credit life insurance', percent: 1, timing: 'deducted' }],
    stated: { netDisbursed: 96500, totalRepayment: 107744.54 }, penalty: { status: 'stated', amount: 500 },
  },
  {
    name: 'SACCO loan', principal: 100000, interestRatePercent: 1, ratePeriod: 'month', interestMethod: 'reducing',
    repaymentFrequency: 'monthly', installments: 12, fees: [{ name: 'Application fee', amount: 500, timing: 'upfront' }],
    stated: { netDisbursed: 100000 }, penalty: { status: 'stated', amount: 1000 },
  },
  {
    name: 'Microfinance group loan', principal: 50000, interestRatePercent: 10, ratePeriod: 'month', interestMethod: 'flat',
    repaymentFrequency: 'weekly', installments: 16,
    fees: [{ name: 'Processing fee', amount: 1500, timing: 'deducted' }, { name: 'Insurance', timing: 'deducted' }],
    stated: { totalRepayment: 70000 }, penalty: { status: 'vague' },
  },
];

/* ---------------- Mode tabs + glossary links ---------------- */

function switchMode(mode) {
  for (const [tab, panel] of [[$('#tab-ask'), $('#panel-ask')], [$('#tab-manual'), $('#panel-manual')]]) {
    const active = panel.id === `panel-${mode}`;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    panel.hidden = !active;
  }
  setStatus('');
}
$('#tab-ask').addEventListener('click', () => switchMode('ask'));
$('#tab-manual').addEventListener('click', () => switchMode('manual'));

document.addEventListener('click', (e) => {
  const sw = e.target.closest('[data-switch]');
  if (sw) switchMode(sw.dataset.switch);

  const termLink = e.target.closest('[data-term]');
  if (termLink) {
    e.preventDefault();
    const term = document.getElementById(termLink.dataset.term);
    term.open = true;
    term.scrollIntoView({ behavior: 'smooth', block: 'center' });
    term.classList.remove('flash');
    void term.offsetWidth; // restart the highlight animation
    term.classList.add('flash');
  }
});

/* ---------------- Status + API ---------------- */

function setStatus(message, { loading = false, error = false } = {}) {
  const el = $('#status');
  el.hidden = !message;
  el.className = `status card${error ? ' error' : ''}`;
  el.innerHTML = message ? `${loading ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span>${esc(message)}</span>` : '';
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

api('/api/status')
  .then(({ aiConfigured, smsConfigured }) => {
    $('#ai-warning').hidden = aiConfigured;
    setSmsEnabled(smsConfigured);
  })
  .catch(() => {});

/* ---------------- AI mode ---------------- */

const attachments = [];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXT_TYPES = { pdf: 'application/pdf', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

function renderFiles() {
  $('#file-list').innerHTML = attachments
    .map((f, i) => `<li class="file-chip">📄 ${esc(f.name)}<button type="button" class="icon-btn" data-remove-file="${i}" aria-label="Remove ${esc(f.name)}">✕</button></li>`)
    .join('');
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const mediaType = EXT_TYPES[file.name.split('.').pop().toLowerCase()];
    if (!mediaType) return reject(new Error(`${file.name}: use a PDF, photo or text file.`));
    if (file.size > MAX_FILE_BYTES) return reject(new Error(`${file.name} is larger than 10 MB.`));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mediaType, data: reader.result.split(',')[1] });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  try {
    for (const file of fileList) {
      if (attachments.length >= 5) throw new Error('You can attach up to 5 files.');
      attachments.push(await readFile(file));
    }
    setStatus('');
  } catch (err) {
    setStatus(err.message, { error: true });
  }
  renderFiles();
}

const dropzone = $('#dropzone');
dropzone.addEventListener('click', () => $('#file-input').click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').click(); } });
$('#file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => dropzone.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('#file-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-file]');
  if (btn) { attachments.splice(Number(btn.dataset.removeFile), 1); renderFiles(); }
});

$('#sample-sms').addEventListener('click', () => { $('#offer-text').value = SAMPLE_SMS; $('#offer-text').focus(); });

const LOADING_STEPS = ['Reading your offer…', 'Pulling out the loan terms…', 'Checking the maths…', 'Writing your explanation…'];

$('#ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#offer-text').value.trim();
  if (!text && attachments.length === 0) return setStatus('Paste an offer or attach a document first.', { error: true });

  const submit = $('#ask-submit');
  submit.disabled = true;
  $('#results').innerHTML = '';
  let step = 0;
  setStatus(LOADING_STEPS[0], { loading: true });
  const ticker = setInterval(() => {
    step = Math.min(step + 1, LOADING_STEPS.length - 1);
    setStatus(LOADING_STEPS[step], { loading: true });
  }, 6000);
  try {
    const data = await api('/api/ask', { text, language: $('#language').value, attachments });
    setStatus('');
    renderResults(data);
  } catch (err) {
    setStatus(err.message, { error: true });
  } finally {
    clearInterval(ticker);
    submit.disabled = false;
  }
});

/* ---------------- Manual mode ---------------- */

const MAX_OFFERS = 4;

function addFeeRow(container, fee = {}) {
  const row = $('#fee-row-template').content.firstElementChild.cloneNode(true);
  $('[name=feeName]', row).value = fee.name ?? '';
  $('[name=feeValue]', row).value = fee.amount ?? fee.percent ?? '';
  $('[name=feeUnit]', row).value = fee.percent != null ? 'percent' : 'amount';
  $('[name=feeTiming]', row).value = fee.timing ?? 'deducted';
  container.append(row);
}

function syncOfferForm(form) {
  const lumpSum = $('[name=repaymentFrequency]', form).value === 'lump-sum';
  $('.installments-field', form).hidden = lumpSum;
  $('.term-field', form).hidden = !lumpSum;
  $('.penalty-amount', form).hidden = $('[name=penaltyStatus]', form).value !== 'stated';
  const forms = $$('.offer-form');
  forms.forEach((f) => { $('.remove-offer', f).hidden = forms.length === 1; });
  $('#add-offer').hidden = forms.length >= MAX_OFFERS;
}

function addOfferForm(data = {}) {
  const container = $('#offer-forms');
  if (container.children.length >= MAX_OFFERS) return;
  const form = $('#offer-form-template').content.firstElementChild.cloneNode(true);
  const index = container.children.length + 1;
  $('.offer-name', form).value = data.name ?? '';
  $('.offer-name', form).placeholder = `Offer ${index}`;

  for (const key of ['principal', 'interestRatePercent', 'ratePeriod', 'interestMethod', 'repaymentFrequency', 'installments', 'termDays']) {
    if (data[key] != null) $(`[name=${key}]`, form).value = data[key];
  }
  for (const [key, value] of Object.entries(data.stated ?? {})) $(`[name="stated.${key}"]`, form).value = value;
  if (data.penalty) {
    $('[name=penaltyStatus]', form).value = data.penalty.status;
    if (data.penalty.amount != null) $('[name=penaltyAmount]', form).value = data.penalty.amount;
  }
  for (const fee of data.fees ?? []) addFeeRow($('.fees', form), fee);

  form.addEventListener('change', () => syncOfferForm(form));
  $('.add-fee', form).addEventListener('click', () => addFeeRow($('.fees', form)));
  $('.fees', form).addEventListener('click', (e) => { if (e.target.closest('.remove-fee')) e.target.closest('.fee-row').remove(); });
  $('.remove-offer', form).addEventListener('click', () => { form.remove(); $$('.offer-form').forEach(syncOfferForm); });

  container.append(form);
  $$('.offer-form').forEach(syncOfferForm);
}

const num = (form, name) => {
  const raw = $(`[name="${name}"]`, form).value.trim();
  return raw === '' ? undefined : Number(raw);
};

function readOfferForm(form, index) {
  const offer = { name: $('.offer-name', form).value.trim() || `Offer ${index + 1}` };
  const set = (key, value) => { if (value !== undefined && value !== '') offer[key] = value; };

  set('principal', num(form, 'principal'));
  set('interestRatePercent', num(form, 'interestRatePercent'));
  set('ratePeriod', $('[name=ratePeriod]', form).value);
  set('interestMethod', $('[name=interestMethod]', form).value);
  offer.repaymentFrequency = $('[name=repaymentFrequency]', form).value;
  if (offer.repaymentFrequency === 'lump-sum') set('termDays', num(form, 'termDays'));
  else set('installments', num(form, 'installments'));

  const fees = $$('.fee-row', form)
    .map((row) => {
      const name = $('[name=feeName]', row).value.trim();
      const raw = $('[name=feeValue]', row).value.trim();
      if (!name && raw === '') return null;
      const fee = { name: name || 'Unnamed fee', timing: $('[name=feeTiming]', row).value };
      if (raw !== '') fee[$('[name=feeUnit]', row).value] = Number(raw);
      return fee;
    })
    .filter(Boolean);
  if (fees.length || $('[name=noFees]', form).checked) offer.fees = fees;

  const stated = {};
  for (const key of ['netDisbursed', 'installmentAmount', 'totalRepayment', 'aprPercent']) {
    const value = num(form, `stated.${key}`);
    if (value !== undefined) stated[key] = value;
  }
  if (Object.keys(stated).length) offer.stated = stated;

  const penaltyStatus = $('[name=penaltyStatus]', form).value;
  const penaltyAmount = num(form, 'penaltyAmount');
  if (penaltyStatus === 'none') offer.penalties = [];
  else if (penaltyStatus === 'vague') offer.penalties = [{ description: 'Late-payment penalty' }];
  else if (penaltyStatus === 'stated') {
    offer.penalties = [penaltyAmount !== undefined ? { description: 'Late-payment penalty', amount: penaltyAmount } : { description: 'Late-payment penalty' }];
  }
  return offer;
}

$('#add-offer').addEventListener('click', () => addOfferForm());
$('#load-samples').addEventListener('click', () => {
  $('#offer-forms').innerHTML = '';
  SAMPLE_OFFERS.forEach(addOfferForm);
});

$('#manual-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const offers = $$('.offer-form').map(readOfferForm);
  $('#results').innerHTML = '';
  setStatus('Calculating…', { loading: true });
  try {
    const data = offers.length === 1 ? await api('/api/analyze', { offer: offers[0] }) : await api('/api/compare', { offers });
    setStatus('');
    renderResults(data);
  } catch (err) {
    setStatus(err.message, { error: true });
  }
});

addOfferForm();
initResults();
