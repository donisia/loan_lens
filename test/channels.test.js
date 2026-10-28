import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleUssd } from '../src/channels/ussd.js';
import { smsSummary, smsComparison } from '../src/channels/sms.js';
import { sendSms, normalizePhone, SmsError } from '../src/channels/africastalking.js';
import { analyzeOffer, compareOffers } from '../src/index.js';
import { sampleOffers } from '../examples/offers.js';

const ussd = (text, opts) => handleUssd({ text, phoneNumber: '+254712345678' }, opts);

test('USSD asks only four questions', () => {
  assert.match(ussd('').response, /^CON Welcome to LoanLens/);
  assert.match(ussd('1').response, /^CON How much money will you RECEIVE/);
  assert.match(ussd('1*28500').response, /^CON How much will you REPAY/);
  assert.match(ussd('1*28500*38640').response, /^CON How will you repay/);
  assert.match(ussd('1*28500*38640*1').response, /^CON How many weeks/);
  assert.match(ussd('1*28500*38640*2').response, /^CON How many months/);
  assert.match(ussd('1*28500*38640*3').response, /^CON In how many days/);
  assert.match(ussd('1*28500*38640*1*16').response, /^END /);
});

test('USSD quick check gives the true cost and queues an SMS', () => {
  const { response, sms } = ussd('1*28500*38640*1*16', { canSendSms: true });
  assert.match(response, /^END Cost of this loan: KES 10,140\nThat is KES 36 per KES 100 you get\n16 weekly payments of KES 2,415\nYearly rate: \d+%\nDetails sent by SMS\.$/);
  assert.equal(sms.to, '+254712345678');
  assert.match(sms.message, /^LoanLens quick check\nYou get: KES 28,500\nYou repay: KES 38,640 \(16 x KES 2,415\)/);
  assert.ok(sms.message.length <= 459);
});

test('USSD quick check matches the known mobile-loan rate', () => {
  // KES 5,000 received, KES 5,375 repaid after 30 days: 7.5% per 30 days, 141% a year.
  assert.match(ussd('1*5000*5375*3*30').response, /Cost of this loan: KES 375\nThat is KES 8 per KES 100 you get\nYearly rate: 141%$/);
});

test('USSD skips the SMS when SMS is not configured', () => {
  const { response, sms } = ussd('1*28500*38640*1*16');
  assert.doesNotMatch(response, /SMS/);
  assert.equal(sms, null);
});

test('USSD screens stay within the USSD length limit', () => {
  const screens = ['', '1', '1*1000', '1*1000*1200', '1*1000*1200*1', '1*1000*1200*1*6', '1*99999999*999999999*2*120', '2']
    .map((t) => ussd(t, { canSendSms: true }).response);
  for (const s of screens) assert.ok(s.length <= 182, `${s.length} chars: ${s}`);
});

test('USSD rejects invalid input and unknown choices', () => {
  assert.match(ussd('1*abc').response, /^END "abc" is not a valid amount/);
  assert.match(ussd('1*1000*900').response, /should be more than what you receive/);
  assert.match(ussd('1*1000*1200*9').response, /^END "9" is not a valid choice/);
  assert.match(ussd('1*1000*1200*1*0').response, /^END "0" is not a valid number/);
  assert.match(ussd('7').response, /^END Invalid choice/);
});

test('SMS summaries are plain ASCII and at most three segments', () => {
  for (const offer of sampleOffers) {
    const text = smsSummary(analyzeOffer(offer));
    assert.ok(text.length <= 459, `${offer.name}: ${text.length} chars`);
    assert.match(text, /^[\x20-\x7E\n]+$/);
  }
  const mismatch = smsSummary(analyzeOffer(sampleOffers[2]));
  assert.match(mismatch, /at least KES 68,411/);
  assert.match(mismatch, /Warning: Total repayment does not reconcile/);

  const r = compareOffers(sampleOffers);
  assert.match(smsComparison(r.ranking, r.notRanked), /1\. SACCO development loan: 13\.8%/);
});

test('phone numbers are normalized to international format', () => {
  assert.equal(normalizePhone('0712 345 678'), '+254712345678');
  assert.equal(normalizePhone('0112-345-678'), '+254112345678');
  assert.equal(normalizePhone('254712345678'), '+254712345678');
  assert.equal(normalizePhone('+256 772 123456'), '+256772123456');
  assert.equal(normalizePhone('12345'), null);
});

const env = { AT_USERNAME: 'sandbox', AT_API_KEY: 'test-key' };
const fakeFetch = (status, body, calls = []) => async (url, init) => {
  calls.push({ url, init });
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
};

test('sendSms posts to the sandbox API and returns recipients', async () => {
  const calls = [];
  const recipients = await sendSms('+254712345678', 'Hello', {
    env,
    fetchImpl: fakeFetch(201, { SMSMessageData: { Recipients: [{ statusCode: 101, status: 'Success', number: '+254712345678' }] } }, calls),
  });
  assert.equal(recipients[0].status, 'Success');
  assert.equal(calls[0].url, 'https://api.sandbox.africastalking.com/version1/messaging');
  assert.equal(calls[0].init.headers.apiKey, 'test-key');
  const body = new URLSearchParams(calls[0].init.body);
  assert.deepEqual([body.get('username'), body.get('to'), body.get('message')], ['sandbox', '+254712345678', 'Hello']);
});

test('sendSms reports rejected recipients and missing configuration', async () => {
  await assert.rejects(
    sendSms('+254712345678', 'Hi', { env, fetchImpl: fakeFetch(201, { SMSMessageData: { Recipients: [{ statusCode: 403, status: 'InvalidPhoneNumber' }] } }) }),
    (err) => err instanceof SmsError && /InvalidPhoneNumber/.test(err.message),
  );
  await assert.rejects(sendSms('+254712345678', 'Hi', { env: {} }), /not set up/);
});
