# ChainLens

**Understand your on-chain activity.** ChainLens explains Celo transactions and wallets in plain language. It is read-only: no wallet connection, no keys, and users pay nothing.

Built for the Celo x Loops House "Agents on Open Rails" hackathon, track **Build with Buy**.

## What it does

1. **Explain a transaction.** Paste a hash and get an ordered, evidence-only story. Every statement is marked *confirmed*, *likely* or *unknown*, and nothing is guessed. Failed transactions show the reason.
2. **Who can spend your tokens?** Lists the contracts allowed to spend a wallet's tokens, in plain words, with the most each one could take.
3. **Deep Investigation (paid through Buy).** When the free data is not enough, the ChainLens agent pays an independent provider, **Chainstack**, for archive data through **Buy** (x402, 0.01 USDT per call) and uses it to confirm the result. It only starts when a person presses the button. It is never automatic.
4. **Payments.** A public page listing every successful Deep Investigation with its payment transaction on Celoscan.

Bonus: Watchlist with free alerts while the page is open, CELO price chart, and an Activity log of the app's own decisions.

## Services used and proof of payment

- **Chainstack**, paid through **Buy** (x402). Paid by the agent wallet `0x398f4AbF39c59DDb3022BE755DC0f5A4C57b118e` (ERC-8004 agent #10027).
- Every successful paid call appears on the **Payments** page in the app, with a Celoscan link to the payment transaction.
- Free sources: Blockscout, SQD, a public Celo RPC, Binance public price data.
- No AI model is used. Fixed rules read the question.

## Honest limits

- The wallet address entered when ordering a Deep Investigation is typed by the user and **not signed**. It is used to limit each address to 2 Deep Investigations per day.
- Approvals given through signatures or other contracts are not visible to a plain allowance read.
- Only recent transactions are loaded (about 50).

## Run

    node server.js

Open http://localhost:3000. Needs Node 18 or newer. No packages to install.

Paid checks need the `buy` CLI set up with an account:

    BUY_ACCOUNT=agent node server.js

On Windows PowerShell:

    $env:BUY_ACCOUNT="agent"; node server.js

## Test

    npm test

## Settings

See `.env.example`. Main ones: `BUY_ACCOUNT`, `PAID_ENABLED=0` to switch paid checks off, `MAX_PAID_PER_DAY` (default 10), `CHAINLENS_DATA_DIR`, `HOST`, `PORT`.

## Roadmap

- More Buy providers beyond Chainstack
- Fee totals per watched wallet
- Optional signed ownership check for ordering wallets
