# Changes agreed, to build AFTER testing is finished (do not build before)

## Payments tab (decided 5 Nov)
- Numbers at the top: Deep Investigations ordered (total), users who ordered, total paid by ChainLens.
- One list: every Deep Investigation ordered by anyone, with the wallet address it was ordered for and the payment proof (Celoscan link).
- Nothing about basic investigations. Basic investigations stay out of the user stats.
- Remove: the second tile block, the per-visitor rows, "came back", "first seen/last seen", "already paid for earlier", "different users seen".
- Show the real amount paid (from the payment), not only "spent, at most".
- Heading stays "People who used ChainLens" if a heading is needed for the list.

## Activity tab
- Stays as the log of everything users did: basic investigations, approval checks, Deep Investigations.

## Alerts wording
- Keep "New activity:" and the tags new / earlier. "noted" -> "worth a look". Remove repeated "Worth a look:".

## Watchlist
- Celo logo small, behind the "CELO" name, transparent PNG/SVG from the Celo Brand Kit (celo.org/brand-kit).
- Price chart = real candlesticks like Binance (user sent a screenshot): thin wick (high/low) + small green/red body per day, 14 days, faint guide lines, dashed line at today's price, hover shows date/open/high/low/close. No captions. Needs daily OHLC: use Binance public klines CELOUSDT 1d (no key; may be blocked on some hosts), fall back to the current Blockscout closes (bodies only, no wicks). Test on the laptop; sandbox cannot reach it. Source currently still has the old blocks.

## Still to test
- Phone view, failed transaction, live Deep Investigation from the Chat tab, Payments rows after an order.

## Optional (only if time): fee currency read from the chain; SQD full approval history.

## Next phase
- VS Code, rename to ChainLens, GitHub, README, .env.example, hosting (Render/Railway), copy real ledger, setAgentURI (tag celo_0124372f0dc2), submission, Vibestarter URL.

## Wording found in live test (5 Nov, Deep Investigation test passed)
- Activity: "Looked up 0x... for free (success)" -> remove "(success)".
- Activity tag "paid decision" -> "Deep Investigation started".
- Activity "user 7hpk" must match the Payments wording.
- Payments "spent, at most" -> show the real amount paid.
- Tested OK: free lookup, paid decision, payment of 0.01 USDT, Celoscan link, Payments row, tx sender shown as wallet.

## "free" / "paid" -> "basic investigation" / "Deep Investigation" (user asked earlier; sweep missed Activity)
- public/index.html TYPE_LABEL (line ~585): free->"Basic investigation", offer->"Deep Investigation offered", decision->"Deep Investigation started", paid->"Deep Investigation", reused->"Deep Investigation, no new charge", unavailable->"Deep Investigation unavailable".
- lib/activity.js: "Looked up X for free (kind)" -> "Basic investigation of X."; "the free data was enough" -> "The basic investigation already explains this transaction. No Deep Investigation needed."; "The free data was not enough" -> "The basic investigation was not enough"; "Paid N through Buy to P for K checks on X" -> "Deep Investigation of X: paid N to P, through Buy, for K checks."
- public/index.html line ~300: "The free check was not enough" -> "The basic investigation was not enough".
- Payments heading "Paid calls" -> "Deep Investigation payments"; tag "paid" -> "payment".
- Alerts intro: "with free data" -> "with a basic investigation".
- Then grep the whole app for "free" and "paid" and update tests/wording.test.js.

## Phone view (tested 5 Nov at ~400px, Chrome device mode)
- Tab bar wraps onto two rows ("Payments" drops down). Make the five tabs fit on one row (smaller text/padding or scroll).
- Chat screen otherwise fits. Still to check: Approvals, Watchlist, Activity, Payments, scrolled Chat.
- User does not like the phone view (desktop layout squeezed). Plan: phone-only pass (CSS media query, desktop unchanged): fixed bottom nav with 5 icon+label tabs (or top tabs if user prefers), compact one-line header, smaller type and tighter card spacing, 2-column tiles, shorter explanations, chart sized for width. Confirm bottom bar vs top tabs with user.

## Approvals tab wording (user feedback)
- ONLY change one word in the Approvals intro: "spend its tokens" -> "spend your tokens". Keep the rest of the paragraph as it is. (No rewrite.)
- Under the box, if touched at all: "The check is free" -> "The basic investigation is free" (matches the naming).

## "Ordered by" wallet for Deep Investigation (agreed 5 Nov, user: "I like your proposal")
- First time someone presses Deep Investigation (Chat and Approvals), ask: "Enter your wallet address to order a Deep Investigation." One box, valid-address check, remembered in that browser (localStorage). Basic investigations stay open, no address needed.
- Send the address with the order (query param, e.g. orderer=0x...), validate server-side, store it in the ledger row and the activity event.
- Cap: 2 Deep Investigations per ordering address per day (UTC day). Friendly message when reached: "You have used your 2 Deep Investigations for today. Try again tomorrow." Keep the existing daily budget cap too.
- Payments list, one row per Deep Investigation: Ordered by (wallet entered by the user, not verified), Investigated (wallet or transaction), Paid by ChainLens (amount + Celoscan proof), time.
- Label on the page: the ordering wallet is entered by the user and not verified.
- Optional later: signature (free, no gas) if organisers say stronger proof is needed.

## Phone navigation (decided 5 Nov): Option 1, fixed bottom bar
- Phone only (CSS media query ~ max-width 640px); desktop unchanged.
- Five tabs along the bottom with icon above label: Chat, Approvals, Watchlist (with the alert count badge), Activity, Payments. Active tab highlighted in the accent colour.
- Compact header on one line (logo, name, CELO badge). Extra bottom padding on the page so content is not hidden behind the bar; respect the phone's safe area (env(safe-area-inset-bottom)).
- Mock-up image: scratchpad/mock/nav-options.png (Option 1 on the left).
- Fallback ONLY if Option 1 cannot be done cleanly: Option 3 (menu button top right with a list of the five pages).

## BUG found in phone test (5 Nov): lookup events
- Activity shows "Looked at a wallet." with NO address, repeated several times within a minute (every wallet-card load logs a new "lookup" event).
- Inflates "lookups" counts in Payments ("6 lookups" for one wallet).
- Fix: log at most one lookup per (visitor, wallet) per ~10 minutes; text "Basic investigation of 0x1234...abcd." (address included); tag "Basic investigation". Same for server.js look=1 logging. Update test/users.test.js.
- Phone tests seen OK: Watchlist, Activity, Payments fit without sideways scroll. Issues: tab bar wraps, desktop-sized type/spacing, long intros.

## Activity tab intro (discussed 5 Nov)
- Remove: "Every decision ChainLens makes, including when it chooses not to pay. ChainLens never pays by itself. A Deep Investigation starts only when a person asks for one." (that was for the old agent-decision log; the tab is now about what people did; the 'only when you ask' point is already under the Chat and Approvals boxes)
- Replace with one line (USER CHOSE): "Your activities appear here"
- Because of that wording, the Activity tab must show ONLY the visitor's own events (filter /api/feed by their sid). Payments stays the overall view across everyone. (awaiting user OK on the filter)

## RULE (user, 5 Nov 11:06) - remember
- Activity tab = YOUR OWN activities only (this visitor, matched by their browser id).
- Payments tab = the WHOLE ChainLens stats (all users, all Deep Investigations, totals, proofs).

## Decisions (user, 5 Nov 11:12)
- Chart data: YES, use the Binance free price feed (CELOUSDT 1d klines) with fallback to the current Blockscout closes. Test on the laptop.
- Amount paid: YES, show "paid 0.01 USDT" (per-call amount) with the Celoscan payment link beside it.
- Optional extras (fee-currency read, SQD full approval history): user still thinking. Default = skip.
- Logo: user will send a transparent logo together with the failed-transaction screenshot.
- Build target: v0.8.5, after the failed-transaction test and the final discussion. Order: wording -> Activity own-only + lookup fix -> Payments rework + ordered-by + cap -> phone pass -> chart + logo.

## Failed-transaction test (5 Nov 11:16): PASSED
- Shows "Transaction failed", fee charged, Celoscan link, autopsy, "Basic investigation" label. Tag "unknown" on "The explorer did not provide a readable failure reason." is correct (honest).
- Improve: next to that "unknown" line add "A Deep Investigation may find the reason." so the user does not stop at "unknown".

## Logo (received 5 Nov): Celo icon, black C on a yellow square, NOT transparent
- Source copy: scratchpad/celo-logo-source.jpg. Use it as a small rounded-square icon left of "CELO" by the price (not a faint watermark). Convert to PNG (celo-logo.png) at build time.

## "Unknown" handling (user, 5 Nov 11:20: "unknown makes ChainLens look incompetent") - awaiting yes
- Rule: if unknown AND a Deep Investigation can answer it -> show it, tag "Deep Investigation can check", with line "Not in the basic investigation. A Deep Investigation can check this." If unknown AND nobody can know -> do not show it.
- SHOW with pointer: why it failed (lib/classify.js ~134-136, 238-239; lib/autopsy.js 55,116), why still waiting (classify 83, 210; autopsy 65), where it stopped, unclear/missing status (classify 147, 246; autopsy 69; investigate 161).
- REMOVE: "Additional movements ... purpose could not be established" (classify 196); "A transfer record ... does not say why it happened" (followups 37); "The purpose of the contract interaction is not established"; "Nothing major is marked unknown ..." (followups 42); fee-not-reported lines if the Deep Investigation cannot add it.
- Follow-up button "What is still unknown?" (followups.js 8) -> "What can a Deep Investigation add?" listing only real answers.
- KEEP as one short "Limits" line (no unknown tag): "This does not mean the wallet is safe."; approvals given by signature or through other contracts cannot be seen; history partly loaded.
- Update tests (wording.test.js, v7.test.js assertions on those strings).

## Smooth result view (user, 5 Nov 11:21)
- After Investigate: smooth-scroll to the start of the answer (headline / wallet summary) with a small top margin (scroll-margin-top), so the user does not scroll to find it.
- Show a short "Reading the transaction..." line at the place where the answer will appear while loading.
- After a Deep Investigation finishes: scroll to the Deep Investigation result (payment proof). Same for the Approvals check result.
- Switching tabs: new tab starts at the top.
- Respect prefers-reduced-motion (no smooth animation then). Works on phone too (account for the fixed bottom bar).

## Payments shows only SUCCESSFUL Deep Investigations (user, 5 Nov 11:24)
- Failed Deep Investigations with no payment are already not in the ledger as paid; they stay in Activity only.
- "paid-but-failed" rows (money moved, answer incomplete/unreadable): do NOT list them in Payments (no row, no red tag). DEFAULT: when N>0 show ONE small line: "N payment(s) did not return a full result. Included in the total." so the total matches Celoscan. (Awaiting user: footnote or hide fully.)
- Totals ("paid by ChainLens", total spent) = all real payments; the list = successful ones only.

## FINAL decisions (user, 5 Nov 11:28)
- Fee currency: YES (read from the public node; if unknown show the amount without a currency guess, no "assumed").
- Charged-but-incomplete payments: show ONLY in the user's own Activity tab, NOT on the Payments page at all (no row, no footnote). Payments = clean verification of successful Deep Investigations. (Concern noted to user: totals then count successful ones only, so a judge comparing with Celoscan may see extra payments; user accepted.)
- Build v0.8.5 started 5 Nov 11:29.

## Final answers (user, 5 Nov 11:28)
- Fee currency: YES (read feeCurrency from the public node; if unavailable show the amount with no currency guess and no "assumed").
- Payments that were charged but did not go through: show ONLY in the user's Activity tab, NOT in Payments at all. No footnote. Payments is for clean verification (successful Deep Investigations only; totals count successful ones only).
- Build started 11:28.
