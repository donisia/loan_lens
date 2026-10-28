// Minimal Africa's Talking SMS client (REST, no SDK).
// Reads AT_USERNAME, AT_API_KEY and optional AT_SENDER_ID from the environment.
// The username "sandbox" routes to the sandbox API, where messages appear in the simulator.

const HOSTS = {
  sandbox: 'https://api.sandbox.africastalking.com',
  live: 'https://api.africastalking.com',
};
const ACCEPTED_STATUS_CODES = [100, 101, 102]; // Processed, Sent, Queued

export class SmsError extends Error {
  name = 'SmsError';
}

export const smsConfigured = (env = process.env) => Boolean(env.AT_USERNAME && env.AT_API_KEY);

// Accepts Kenyan local formats (07..., 01..., 2547...) and international +XXXXXXXXXX.
export function normalizePhone(input) {
  const value = String(input ?? '').replace(/[\s\-().]/g, '');
  if (/^0[17]\d{8}$/.test(value)) return `+254${value.slice(1)}`;
  if (/^254[17]\d{8}$/.test(value)) return `+${value}`;
  if (/^\+\d{10,15}$/.test(value)) return value;
  return null;
}

export async function sendSms(to, message, { env = process.env, fetchImpl = fetch } = {}) {
  if (!smsConfigured(env)) throw new SmsError('SMS is not set up: add AT_USERNAME and AT_API_KEY to .env.');
  const host = env.AT_USERNAME === 'sandbox' ? HOSTS.sandbox : HOSTS.live;
  const body = new URLSearchParams({ username: env.AT_USERNAME, to, message });
  if (env.AT_SENDER_ID) body.set('from', env.AT_SENDER_ID);

  const res = await fetchImpl(`${host}/version1/messaging`, {
    method: 'POST',
    headers: { apiKey: env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new SmsError(`Africa's Talking returned ${res.status}: ${text.slice(0, 200)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SmsError(`Unexpected response from Africa's Talking: ${text.slice(0, 200)}`);
  }
  const recipients = data.SMSMessageData?.Recipients ?? [];
  const failed = recipients.find((r) => !ACCEPTED_STATUS_CODES.includes(r.statusCode));
  if (recipients.length === 0 || failed) {
    throw new SmsError(`SMS not sent: ${failed?.status ?? data.SMSMessageData?.Message ?? 'no recipients accepted'}`);
  }
  return recipients;
}
