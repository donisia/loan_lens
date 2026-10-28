import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoanAgent } from '../src/agent/agent.js';
import { executeTool } from '../src/agent/tools.js';
import { sampleOffers } from '../examples/offers.js';

// A stand-in for the Anthropic client that replays scripted responses and records requests.
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          requests.push(structuredClone(params));
          return { model: params.model, ...responses.shift() };
        },
      },
    },
  };
}

const offer = sampleOffers[0];

test('agent calls the engine and returns its explanation with engine results', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'analyze_offer', input: { offer } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'What you get: KES 96,500.' }] },
  ]);
  const out = await runLoanAgent({ text: 'Bank offer...', client });

  assert.equal(out.explanation, 'What you get: KES 96,500.');
  assert.equal(out.latest.name, 'analyze_offer');
  assert.equal(out.latest.result.calculation.netDisbursed, 96500);

  const [first, second] = client.requests;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.tools.map((t) => t.name), ['analyze_offer', 'compare_offers']);
  const toolResult = second.messages.at(-1).content[0];
  assert.equal(toolResult.tool_use_id, 't1');
  assert.equal(toolResult.is_error, false);
  assert.equal(JSON.parse(toolResult.content).clarity.score, 7);
});

test('bad tool input goes back to Claude as an error so it can retry', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'analyze_offer', input: { offer: { ...offer, principal: '100000' } } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'analyze_offer', input: { offer } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  ]);
  const out = await runLoanAgent({ text: 'offer', client });

  const firstResult = client.requests[1].messages.at(-1).content[0];
  assert.equal(firstResult.is_error, true);
  assert.match(firstResult.content, /principal must be a number/);
  assert.equal(out.toolCalls.length, 2);
  assert.equal(out.latest.isError, false);
});

test('refusals and truncation raise clear errors', async () => {
  await assert.rejects(
    runLoanAgent({ text: 'x', client: fakeClient([{ stop_reason: 'refusal', content: [] }]) }),
    /declined/,
  );
  await assert.rejects(
    runLoanAgent({ text: 'x', client: fakeClient([{ stop_reason: 'max_tokens', content: [] }]) }),
    /cut off/,
  );
});

test('compare_offers tool requires at least two offers and validates each', () => {
  assert.equal(executeTool('compare_offers', { offers: [offer] }).isError, true);
  const bad = executeTool('compare_offers', { offers: [offer, { ...offer, fees: [{ name: 'Fee', amount: '50', timing: 'deducted' }] }] });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /offers\[1\]/);
  const ok = executeTool('compare_offers', { offers: sampleOffers });
  assert.equal(ok.result.ranking[0].name, 'SACCO development loan');
});

test('fees without a timing are rejected instead of silently dropped', () => {
  const r = executeTool('analyze_offer', { offer: { ...offer, fees: [{ name: 'Insurance', percent: 1 }] } });
  assert.equal(r.isError, true);
  assert.match(r.content, /needs a timing/);
});
