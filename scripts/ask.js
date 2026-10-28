// Ask LoanLens about a loan offer.
//   node scripts/ask.js "Offer text..."
//   node scripts/ask.js --file offer.pdf [--file other.jpg] [--lang Swahili] ["question"]
// Requires ANTHROPIC_API_KEY (or an `ant auth login` profile).
import Anthropic from '@anthropic-ai/sdk';
import { runLoanAgent } from '../src/agent/agent.js';

const args = process.argv.slice(2);
const files = [];
const words = [];
let language = 'English';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') files.push(args[++i]);
  else if (args[i] === '--lang') language = args[++i];
  else words.push(args[i]);
}

if (!files.length && !words.length) {
  console.error('Usage: node scripts/ask.js [--file path]... [--lang language] "offer text or question"');
  process.exit(1);
}

try {
  const { explanation, latest } = await runLoanAgent({ text: words.join(' '), files, language });
  console.log(explanation);
  if (latest?.result?.ranking) {
    console.log('\nRanking (from the LoanLens engine):');
    for (const r of latest.result.ranking) console.log(`  ${r.rank}. ${r.name}`);
  }
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error('Authentication failed: set ANTHROPIC_API_KEY.');
  else if (err instanceof Anthropic.RateLimitError) console.error('Rate limited by the Claude API. Try again shortly.');
  else if (err instanceof Anthropic.APIError) console.error(`Claude API error ${err.status}: ${err.message}`);
  else console.error(err.message);
  process.exit(1);
}
