// LoanLens web server: serves the borrower interface and a small JSON API.
//   POST /api/analyze  { offer }                          engine only, no AI
//   POST /api/compare  { offers }                         engine only, no AI
//   POST /api/ask      { text, language, attachments }    Claude agent + engine
//   POST /api/sms      { phone, offer }                   text a loan summary to a phone
//   GET  /api/status                                      whether Claude and SMS are configured
// Africa's Talking callbacks (form-encoded):
//   POST /ussd           USSD menu
//   POST /sms/incoming   borrower texts an offer, LoanLens replies with a summary
//   POST /sms/delivery   delivery reports (logged)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { analyzeOffer, compareOffers } from './index.js';
import { runLoanAgent, LoanAgentError } from './agent/agent.js';
import { assertOfferTypes } from './agent/tools.js';
import { sendSms, smsConfigured, normalizePhone, SmsError } from './channels/africastalking.js';
import { smsSummary, smsComparison } from './channels/sms.js';
import { handleUssd } from './channels/ussd.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(SRC_DIR, '../public');
// The engine is plain ES modules with no Node dependencies, so the browser runs the same code.
const ENGINE_DIR = path.resolve(SRC_DIR, 'engine');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Upload is too large. Keep files under 15 MB in total.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

const AI_NOT_SET_UP = 'The AI assistant is not set up yet (missing API key). You can still enter the terms yourself.';
const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Engine errors (TypeError from bad offer input) are the caller's fault, not the server's.
function runEngine(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TypeError) throw new HttpError(400, err.message);
    throw err;
  }
}

async function handleAsk(body) {
  const text = typeof body.text === 'string' ? body.text.slice(0, 20000) : '';
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!text.trim() && attachments.length === 0) throw new HttpError(400, 'Paste an offer or attach a document.');
  if (attachments.length > 5) throw new HttpError(400, 'Attach at most 5 files.');

  let out;
  try {
    out = await runLoanAgent({ text, attachments, language: body.language === 'Kiswahili' ? 'Kiswahili' : 'English' });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(503, AI_NOT_SET_UP);
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'LoanLens is busy right now. Please try again in a minute.');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `The AI service returned an error (${err.status ?? 'no connection'}). Please try again.`);
    if (err instanceof LoanAgentError) throw new HttpError(422, err.message);
    // The SDK throws a plain Error when no credentials are configured.
    if (!aiConfigured()) throw new HttpError(503, AI_NOT_SET_UP);
    throw err;
  }

  const result = out.latest?.result;
  return {
    explanation: out.explanation,
    analyses: result ? (result.analyses ?? [result]) : [],
    comparison: result?.ranking ? { ranking: result.ranking, notRanked: result.notRanked, highlights: result.highlights } : null,
  };
}

// Simple in-memory limit so the public SMS endpoint can't be used to spam numbers.
const SMS_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 };
const smsSends = new Map();
function checkSmsLimit(key) {
  const now = Date.now();
  const recent = (smsSends.get(key) ?? []).filter((t) => now - t < SMS_LIMIT.windowMs);
  if (recent.length >= SMS_LIMIT.max) throw new HttpError(429, 'Too many SMS requests. Please wait a few minutes.');
  smsSends.set(key, [...recent, now]);
}

// The message is always composed here from the engine's own results, never taken from the client.
async function handleSendSms(req, body) {
  if (!smsConfigured()) throw new HttpError(503, 'SMS is not set up on this server yet.');
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'Enter a valid phone number, e.g. 0712 345 678 or +254712345678.');
  const analysis = runEngine(() => (assertOfferTypes(body.offer), analyzeOffer(body.offer)));
  checkSmsLimit(req.socket.remoteAddress);
  checkSmsLimit(phone);
  try {
    await sendSms(phone, smsSummary(analysis));
  } catch (err) {
    if (err instanceof SmsError) throw new HttpError(502, err.message);
    throw err;
  }
  return { sent: true, to: phone };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, { aiConfigured: aiConfigured(), smsConfigured: smsConfigured() });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const body = await readJson(req);

  if (pathname === '/api/analyze') {
    return sendJson(res, 200, { analyses: [runEngine(() => (assertOfferTypes(body.offer), analyzeOffer(body.offer)))], comparison: null });
  }
  if (pathname === '/api/compare') {
    if (!Array.isArray(body.offers) || body.offers.length === 0) throw new HttpError(400, 'Missing "offers".');
    const result = runEngine(() => {
      body.offers.forEach((offer, i) => assertOfferTypes(offer, `offers[${i}]`));
      return compareOffers(body.offers);
    });
    return sendJson(res, 200, {
      analyses: result.analyses,
      comparison: body.offers.length > 1 ? { ranking: result.ranking, notRanked: result.notRanked, highlights: result.highlights } : null,
    });
  }
  if (pathname === '/api/ask') return sendJson(res, 200, await handleAsk(body));
  if (pathname === '/api/sms') return sendJson(res, 200, await handleSendSms(req, body));
  throw new HttpError(404, 'Not found.');
}

/* ---------- Africa's Talking callbacks ---------- */

const sendSmsInBackground = (to, message, label) =>
  sendSms(to, message).catch((err) => console.error(`${label}: SMS to ${to} failed: ${err.message}`));

async function replyToIncomingSms({ from, text }) {
  const offerText = (text ?? '').trim();
  let message;
  if (!offerText || /^(help|hi|hello|loanlens)$/i.test(offerText)) {
    message = 'LoanLens: forward or paste a loan offer here and we will reply with its true cost and the questions to ask the lender.';
  } else {
    try {
      const out = await runLoanAgent({ text: offerText });
      const result = out.latest?.result;
      if (!result) message = 'LoanLens could not find loan terms in that message. Include the amount, interest rate and repayment period.';
      else message = result.ranking ? smsComparison(result.ranking, result.notRanked) : smsSummary(result);
    } catch (err) {
      console.error(`Incoming SMS from ${from}: could not analyze offer:`, err.message);
      message = 'Sorry, LoanLens could not read that offer right now. Please try again later or use the USSD menu.';
    }
  }
  await sendSmsInBackground(from, message, 'Incoming SMS reply');
}

async function handleCallback(req, res, pathname) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const params = Object.fromEntries(new URLSearchParams(await readBody(req)));

  if (pathname === '/ussd') {
    const { response, sms } = handleUssd(params, { canSendSms: smsConfigured() });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(response);
    if (sms) sendSmsInBackground(sms.to, sms.message, 'USSD summary');
    return;
  }
  if (pathname === '/sms/incoming') {
    // Acknowledge right away; analysing the offer can take a while.
    res.writeHead(200).end();
    if (params.from) replyToIncomingSms(params);
    return;
  }
  if (pathname === '/sms/delivery') {
    console.log(`SMS delivery report: ${params.phoneNumber ?? '?'} ${params.status ?? '?'}${params.failureReason ? ` (${params.failureReason})` : ''}`);
    res.writeHead(200).end();
    return;
  }
  throw new HttpError(404, 'Not found.');
}

function serveStatic(res, pathname) {
  const [root, rel] = pathname.startsWith('/engine/')
    ? [ENGINE_DIR, pathname.slice('/engine'.length)]
    : [PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname];
  const filePath = path.resolve(root, `.${decodeURIComponent(rel)}`);
  if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(filePath)] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else if (pathname === '/ussd' || pathname.startsWith('/sms/')) await handleCallback(req, res, pathname);
      else serveStatic(res, pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      sendJson(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'Something went wrong.' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => {
    console.log(`LoanLens running at http://localhost:${PORT}`);
    if (!aiConfigured()) console.log('ANTHROPIC_API_KEY is not set: the AI assistant is off, manual entry still works.');
    if (!smsConfigured()) console.log('AT_USERNAME / AT_API_KEY are not set: SMS is off. USSD still works but cannot text summaries.');
  });
}
