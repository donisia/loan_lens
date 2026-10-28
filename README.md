# LoanLens

Understand before you borrow. LoanLens explains loan offers in plain language, compares their true cost, and flags terms that are missing or don't add up.

## Status

- Milestone 1, the true-cost engine, is done. It has no dependencies and runs without AI.
- Milestone 2, the AI agent, is done. It uses Claude Opus 5.5.
- Milestone 3, the borrower web interface, is done.

```
npm install
npm start       # web app at http://localhost:3000
npm test        # engine and agent tests (offline, no API key needed)
npm run demo    # plain-language comparison of the sample offers, no AI

# Ask the agent (needs ANTHROPIC_API_KEY)
npm run ask -- --file examples/offer-sms.txt
npm run ask -- --lang Swahili "Loan of KES 10,000 at 10% per month flat, repay monthly for 3 months"
npm run ask -- --file offer.pdf --file photo-of-offer.jpg
```

## Engine

| Module | Purpose |
| --- | --- |
| `src/engine/cost.js` | `calculateLoan(offer)`: repayment schedule, totals, cost of credit, effective annual rate |
| `src/engine/validate.js` | `analyzeOffer(offer)`: Loan Clarity Score, reconciliation of stated figures, clarifications, questions to ask the lender |
| `src/engine/compare.js` | `compareOffers(offers)`: ranks offers by effective annual rate; offers that can't be fully calculated are listed separately |
| `src/engine/apr.js` | Effective annual rate solved from real cash flows (fees and timing included) |

The offer format is documented at the top of `src/engine/cost.js`, and `examples/offers.js` has samples. Supported terms:

- Flat or reducing-balance interest
- Weekly, fortnightly, monthly or lump-sum repayment
- Fees that are deducted, paid upfront, financed or charged per installment

### Loan Clarity Score

The score counts how many of 7 key fields the lender provided: principal, amount received, interest rate and period, interest method, quantified fees, repayment schedule and total repayment. It does not rate whether a loan is good or bad. Alongside the score, LoanLens:

- Checks the lender's stated figures against the calculation.
- Lists fees and penalties that are mentioned but not quantified.
- Shows a range of outcomes when the interest method is unknown, instead of guessing.

## AI agent

`runLoanAgent({ text, files, language })` in `src/agent/agent.js` works in three steps:

1. Claude reads the offer, which can be pasted text, a `.txt` file, a PDF or a photo.
2. Claude fills in the offer format and calls the engine through two tools, `analyze_offer` and `compare_offers` (defined in `src/agent/tools.js`).
3. Claude explains the results in plain language.

Rules the agent follows:

- Claude never does the arithmetic. Every number comes from the engine.
- Terms the offer doesn't state are left out, so the engine can report them as missing.
- Tool inputs are type-checked. Bad input goes back to Claude as an error so it can correct it.
- The function returns the engine's own results next to the explanation (`latest`, `toolCalls`). Interfaces can display figures from the engine directly.
- Requests use `fallbacks: "default"`. If Claude's safety checks decline a request, it is retried on Anthropic's recommended fallback model.

## Web interface

`npm start` serves the borrower app from `public/`. It is plain HTML, CSS and JavaScript with no build step. The server is `src/server.js`, which uses only Node's built-in `http` module. Borrowers can use it two ways:

- **Paste or upload an offer.** Claude reads an SMS, PDF or photo and explains it. This needs `ANTHROPIC_API_KEY`.
- **Enter the terms myself.** A form with no AI involved that can compare up to 4 offers. It works without an API key.

Each offer's results include:

- **The true cost:** what you receive, what you pay in total, the cost of borrowing and the yearly cost rate.
- **Where your money goes:** a bar splitting everything you pay into the money you got, interest and fees.
- **Can I afford it?** Enter your monthly income to see what share of it the repayments take, measured against the common one-third guideline. The income never leaves the browser.
- **What if…** sliders for the loan amount and the number of payments or loan length. They recalculate instantly in the browser, which loads the same engine from `/engine/*.js`.
- **The Loan Clarity Score, checks and questions to ask the lender**, plus the full repayment schedule.
- **Sharing:** WhatsApp, copy a summary, or print or save as PDF. "Send by SMS" is a placeholder for the Africa's Talking integration.

When there are several offers, a chart compares their yearly cost rates, with a table view as an alternative. The home page also has a "How it works" section and a glossary of loan terms, linked from the `?` icons in the results.

| Endpoint | Body | AI |
| --- | --- | --- |
| `POST /api/analyze` | `{ offer }` | No |
| `POST /api/compare` | `{ offers }` | No |
| `POST /api/ask` | `{ text, language, attachments: [{ name, mediaType, data }] }` | Yes |
| `GET /api/status` | | |

## Africa's Talking (SMS + USSD)

Set `AT_USERNAME` and `AT_API_KEY` in `.env` (copy `.env.example`). With the username `sandbox`, messages go to the [Africa's Talking simulator](https://simulator.africastalking.com) instead of real phones.

| Feature | How it works | Code |
| --- | --- | --- |
| **Send to my phone** | Button on each result in the web app. The server writes the SMS from the engine's numbers; the browser can't supply the text. Limited to 5 sends per 10 minutes per phone and per IP. | `POST /api/sms` |
| **USSD menu** | Dial a code and answer 4 questions: how much you receive, how much you repay in total, how often and for how long. You get the cost, the cost per KES 100 and the yearly rate on screen, and a summary by SMS. Works on any phone. | `src/channels/ussd.js` |
| **Text an offer** | Forward a lender's SMS to your shortcode. Claude reads it and LoanLens replies with the summary. | `POST /sms/incoming` |

### Callback URLs

Africa's Talking must reach your server over the internet, so run a tunnel while developing:

```
npm start
ngrok http 3000          # copy the https://....ngrok-free.app address
```

In the [Africa's Talking sandbox](https://account.africastalking.com/apps/sandbox), set:

| Setting | Callback URL |
| --- | --- |
| USSD → Create channel | `https://<your-ngrok-address>/ussd` |
| SMS → SMS Callback URLs → Incoming Messages | `https://<your-ngrok-address>/sms/incoming` (needs a sandbox shortcode) |
| SMS → SMS Callback URLs → Delivery Reports | `https://<your-ngrok-address>/sms/delivery` (optional) |

The free ngrok address changes every time ngrok restarts. When it does, update the callback URLs.

## Next milestones

1. Organization insights dashboard on synthetic or consented, anonymized data
