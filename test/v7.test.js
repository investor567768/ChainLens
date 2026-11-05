import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { plural } from "../lib/format.js";
import { parseAsk } from "../lib/ask.js";
import { getHoldings, KNOWN_TOKENS } from "../lib/holdings.js";
import { analyzeWallet } from "../lib/intel.js";
import { logEvent, readEvents, describeFree, describePaid } from "../lib/activity.js";
import { summarizePayments, describeBought, describeContribution } from "../lib/payments.js";
import { buildAutopsy } from "../lib/autopsy.js";
import { answerFollowUp } from "../lib/followups.js";
import { explainChanges } from "../lib/changes.js";
import { independentFindings, investigate } from "../lib/investigate.js";
import { summarizeWallet } from "../lib/wallet.js";

const ME = "0x" + "11".repeat(20), C1 = "0x" + "c1".repeat(20), C2 = "0x" + "c2".repeat(20), SP = "0x" + "5b".repeat(20);
const H = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);
const NOW = Date.parse("2026-11-02T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();

test("plurals are real words, never (s)", () => {
  assert.equal(plural(1, "token transfer record"), "1 token transfer record");
  assert.equal(plural(4, "token transfer record"), "4 token transfer records");
  assert.equal(plural(0, "step"), "0 steps");
  const mk = (text, confidence, kind, topic) => ({ text, confidence, kind, topic });
  const p = { receiptSucceeded: true, trace: null, extras: { logs: { agree: true, receiptTransferLogs: 1 } } };
  const t = independentFindings(p, { status: "ok" }).map((f) => f.text).join(" ");
  assert.match(t, /same 1 token transfer record as/); assert.doesNotMatch(t, /\(s\)/);
});

test("ask bar: finds a hash, an address, keywords; says so when it cannot tell", () => {
  const tx = parseAsk(`why did this fail? ${H(0xab)}`);
  assert.equal(tx.kind, "tx"); assert.equal(tx.hash, H(0xab)); assert.equal(tx.purpose, "failed"); assert.equal(tx.deep, false);
  assert.equal(parseAsk(`verify ${H(0xab)}`).deep, true);
  assert.equal(parseAsk(`is my transaction stuck ${H(0xab)}`).purpose, "pending");
  const w = parseAsk(`what is in ${ME}`);
  assert.equal(w.kind, "wallet"); assert.equal(w.address, ME);
  assert.equal(parseAsk("0x1234567890abcdef12").kind, "invalid");
  const u = parseAsk("hello there");
  assert.equal(u.kind, "unknown"); assert.match(u.understood, /Paste a transaction hash/);
  assert.equal(parseAsk(null).kind, "unknown");
});

// A fake fetch that answers explorer and node calls.
const fakeFetch = ({ explorer = true, node = true, coin = "2500000000000000000", usdt = "5000000", nodeUsdt = usdt, nodeCelo = coin, extra = [] } = {}) => async (url, init = {}) => {
  const ok = (data) => ({ ok: true, json: async () => data });
  if (String(url).includes("blockscout") || String(url).includes("/api/v2")) {
    if (!explorer) return { ok: false };
    if (/token-balances/.test(url)) return ok([{ token: { address: KNOWN_TOKENS[0].address, symbol: "USD₮", decimals: "6", type: "ERC-20" }, value: usdt }, ...extra]);
    return ok({ coin_balance: coin });
  }
  if (!node) return { ok: false };
  const body = JSON.parse(init.body);
  if (body.method === "eth_getBalance") return ok({ result: "0x" + BigInt(nodeCelo).toString(16) });
  if (body.method === "eth_call") {
    const isUsdt = body.params[0].to.toLowerCase() === KNOWN_TOKENS[0].address.toLowerCase();
    return ok({ result: "0x" + BigInt(isUsdt ? nodeUsdt : 0).toString(16) });
  }
  return { ok: false };
};

test("holdings: both sources agree -> confirmed; zero known tokens are not listed", async () => {
  const h = await getHoldings(ME, { fetch: fakeFetch() });
  assert.equal(h.ok, true); assert.equal(h.native.amount, "2.5"); assert.equal(h.native.check, "confirmed");
  assert.equal(h.tokens.length, 1); assert.equal(h.tokens[0].amount, "5"); assert.equal(h.tokens[0].check, "confirmed");
  assert.deepEqual(h.sources, { explorer: true, chain: true });
});

test("holdings: sources that disagree are reported as different, not blended", async () => {
  const h = await getHoldings(ME, { fetch: fakeFetch({ nodeUsdt: "4000000" }) });
  assert.equal(h.tokens[0].check, "differs");
  assert.equal(h.tokens[0].explorerAmount, "5"); assert.equal(h.tokens[0].chainAmount, "4"); assert.equal(h.tokens[0].amount, "4");
});

test("holdings: one source down is said plainly and nothing is called confirmed", async () => {
  const a = await getHoldings(ME, { fetch: fakeFetch({ node: false }) });
  assert.equal(a.native.check, "explorer-only"); assert.equal(a.tokens[0].check, "explorer-only"); assert.match(a.notes[0], /not cross-checked/);
  const b = await getHoldings(ME, { fetch: fakeFetch({ explorer: false }) });
  assert.equal(b.native.check, "chain-only"); assert.match(b.notes[0], /node only/);
  const c = await getHoldings(ME, { fetch: fakeFetch({ explorer: false, node: false }) });
  assert.equal(c.ok, false);
});

test("holdings: a token the explorer does not list is not checked, never called a mismatch", async () => {
  const f = fakeFetch(); const wrapped = async (url, init) => { const r = await f(url, init); if (/token-balances/.test(url)) return { ok: true, json: async () => [] }; return r; };
  const h = await getHoldings(ME, { fetch: wrapped });
  assert.equal(h.tokens[0].check, "chain-only"); assert.equal(h.tokens[0].explorerNotListed, true); assert.equal(h.tokens[0].amount, "5");
});

test("holdings: a wrapped explorer list ({ items }) and address_hash are read correctly", async () => {
  const f = fakeFetch(); const wrapped = async (url, init) => { const r = await f(url, init); if (/token-balances/.test(url)) return { ok: true, json: async () => ({ items: [{ token: { address_hash: KNOWN_TOKENS[0].address, symbol: "USD₮", decimals: "6", type: "ERC-20" }, value: "5000000" }] }) }; return r; };
  const h = await getHoldings(ME, { fetch: wrapped });
  assert.equal(h.tokens[0].check, "confirmed"); assert.equal(h.tokens[0].amount, "5");
});

test("holdings: unknown tokens are kept apart, unchecked, and have no value shown", async () => {
  const extra = [{ token: { address: "0x" + "99".repeat(20), symbol: "FREE-USDC", name: "Claim now", decimals: "18", type: "ERC-20" }, value: "1000000000000000000" }];
  const h = await getHoldings(ME, { fetch: fakeFetch({ extra }) });
  assert.equal(h.tokens.some((t) => t.symbol === "FREE-USDC"), false);
  assert.equal(h.other[0].symbol, "FREE-USDC"); assert.equal(h.other[0].amount, "1");
  assert.equal("value" in h.other[0] || "usd" in h.other[0], false);
  assert.equal((await getHoldings("nope")).ok, false);
});

const fail = (n, to, hAgo) => ({ hash: H(n), status: "error", timestamp: ago(hAgo), method: "swap", from: { hash: ME }, to: { hash: to, is_contract: true } });
const okTx = (n, to, hAgo) => ({ hash: H(n), status: "ok", timestamp: ago(hAgo), from: { hash: ME }, to: { hash: to, is_contract: false } });

test("intel: three failures at one contract within 24h are counted; two, or older ones, are not", () => {
  const r = analyzeWallet(ME, [fail(1, C1, 1), fail(2, C1, 3), fail(3, C1, 5)], [], NOW);
  const s = r.signals.find((x) => x.key === "repeated-failures");
  assert.match(s.text, /3 failed transactions to the same smart contract/); assert.equal(s.suggest.hash, H(1));
  assert.equal(analyzeWallet(ME, [fail(1, C1, 1), fail(2, C1, 3)], [], NOW).signals.length, 0);
  assert.equal(analyzeWallet(ME, [fail(1, C1, 1), fail(2, C1, 3), fail(3, C1, 30)], [], NOW).signals.length, 0);
  assert.equal(analyzeWallet(ME, [fail(1, C1, 1), fail(2, C2, 3), fail(3, C1, 5)], [], NOW).signals.length, 0);
});

test("intel: a new contact needs enough history, and never claims 'ever'", () => {
  const old = Array.from({ length: 8 }, (_, i) => okTx(10 + i, C1, 48 + i));
  const r = analyzeWallet(ME, [okTx(30, C2, 1), ...old], [], NOW);
  const s = r.signals.find((x) => x.key === "new-contact");
  assert.match(s.text, /is not in the earlier 9 events we checked/); assert.doesNotMatch(s.text, /ever|first time/i);
  assert.equal(analyzeWallet(ME, [okTx(30, C2, 1), okTx(31, C1, 5)], [], NOW).signals.length, 0);
});

test("intel: an unlimited approval is described plainly with details tucked away", () => {
  const max = (2n ** 256n - 1n).toString();
  const ap = { hash: H(7), status: "ok", timestamp: ago(2), method: "approve", from: { hash: ME }, to: { hash: C1, name: "Example Token" }, decoded_input: { parameters: [{ name: "spender", value: SP }, { name: "value", value: max }] } };
  const r = analyzeWallet(ME, [ap], [], NOW);
  const s = r.signals[0];
  assert.equal(s.key, "approval-unlimited"); assert.match(s.text, /allowed 0x5b5b\.\.\.5b5b to spend an unlimited amount of Example Token \(an approval\)/);
  assert.ok(s.technical.some((t) => t.includes(SP)));
  const bad = analyzeWallet(ME, [{ ...ap, status: "error" }], [], NOW).signals[0];
  assert.match(bad.text, /the transaction failed, so it did not take effect/);
  const off = analyzeWallet(ME, [{ ...ap, method: "setApprovalForAll", decoded_input: { parameters: [{ name: "operator", value: SP }, { name: "approved", value: false }] } }], [], NOW);
  assert.equal(off.signals.length, 0);
});

test("intel: when nothing stands out it says what was checked and that this is not a safety verdict", () => {
  const r = analyzeWallet(ME, [okTx(1, C1, 1), okTx(2, C1, 2)], [], NOW);
  assert.match(r.statement, /Checked the last 2 events for repeated failures, new contacts and approvals\. None was found/); assert.match(r.statement, /does not mean the wallet is safe/);
  assert.match(analyzeWallet(ME, [], [], NOW).statement, /not enough recent activity/);
});

test("wallet summary carries the intelligence and flags incomplete data", async () => {
  const txs = { ok: true, data: { items: [fail(1, C1, 1), fail(2, C1, 2), fail(3, C1, 3)] } };
  const w = await summarizeWallet(ME, { fetchAddressTransactions: async () => txs, fetchAddressTokenTransfers: async () => ({ ok: false, error: "x" }), fetchAddressPending: async () => ({ ok: false }) });
  assert.equal(w.ok, true); assert.ok(w.intel.partial); assert.ok(w.intel.window.transactions >= 3);
});

test("activity feed records decisions, including not paying, and survives bad rows", async () => {
  const free = { ok: true, hash: H(1), kind: "success", paid: { pending: false, reason: "the basic investigation already explains this transaction" } };
  const d = describeFree(free);
  assert.match(d.text, /No Deep Investigation needed: the basic investigation already explains this transaction/);
  const dp = describeFree({ ok: true, hash: H(2), kind: "failed", paid: { pending: false, reason: "x" }, deep: { state: "offer", recommended: "the explorer did not give a reason for the failure" } });
  assert.match(dp.text, /basic investigation was not enough because the explorer did not give a reason/);
  assert.match(dp.text, /Nothing was paid, it is your choice/);
  assert.equal(dp.type, "offer");
  await logEvent({ ...d, sid: "u_abc123xy" });
  await logEvent({ type: "paid", text: "x", sid: "u_zzzzzz11" });
  const rows = await readEvents(10);
  assert.equal(rows[0].sid, "u_zzzzzz11"); assert.equal(rows.length >= 2, true);
  const reused = describePaid(H(1), { deep: { state: "done", reused: true } });
  assert.equal(reused.text.endsWith("previously paid. No new charge."), true);
  const paid = describePaid(H(1), { deep: { state: "done", reused: false, verdict: { line: "The Deep Investigation agreed." } }, paid: { perCall: [1, 2, 3], ledger: { amount: "0.01", currency: "USDT" }, paymentTxHash: H(9) } });
  assert.match(paid.text, /Deep Investigation of .*: paid 0\.01 USDT to .*, through Buy, for 3 checks/); assert.equal(paid.paymentTxHash, H(9));
});

test("payments proof page counts only real paid calls and distinct users", () => {
  const rows = [
    { kind: "paid-call", status: "ok", at: "t1", tx: H(1), amount: "0.01", currency: "USDT", provider: "P", paymentTxHash: H(9), sessionId: "u_a1b2c3d4", requested: [{ method: "eth_getTransactionByHash" }] },
    { kind: "paid-call", status: "failed", at: "t2", tx: H(2), amount: "0.01", currency: "USDT" },
    { kind: "paid-call", status: "not-attempted", at: "t3", tx: H(3), amount: "0.01", currency: "USDT" },
    { kind: "paid-call", status: "ok", at: "t4", tx: H(1), amount: "0.01", currency: "USDT", provider: "P", sessionId: "u_e5f6g7h8" },
  ];
  const s = summarizePayments(rows, [{ type: "reused", sid: "u_a1b2c3d4" }, { type: "free", sid: "u_zzzzzz11" }]);
  assert.equal(s.totals.paidCalls, 2); assert.equal(s.totals.spentAtMost, 0.02); assert.equal(s.totals.transactionsInvestigated, 1);
  assert.equal(s.totals.usersWhoOrdered, 2); assert.equal(s.totals.ordered, 2); assert.equal(s.totals.reusedWithoutCharge, 1); assert.deepEqual(s.services, ["P"]);
  assert.equal(s.calls[0].tx, H(1));
});

test("payments say what was bought and what it contributed, from the stored result only", () => {
  assert.equal(describeBought([{ role: "tx" }, { role: "receipt" }, { role: "trace" }]), "the transaction record, the receipt and the execution trace");
  const c = describeContribution({ receiptSucceeded: false, trace: { calls: 2, failing: { to: C1, reason: "invalid signature" } }, extras: { logs: { agree: true } } });
  assert.deepEqual(c.slice(0, 2), ['Found the reason it failed: "invalid signature".', "The Deep Investigation's receipt says the transaction failed."]);
  assert.match(c[2], /they match/);
  assert.match(describeContribution(null)[0], /could not be read/);
  assert.match(describeContribution({ trace: { calls: 3, failing: null } })[0], /Showed the 3 steps inside the transaction, with no errors/);
  const s = summarizePayments([{ kind: "paid-call", status: "ok", at: "t", tx: H(1), amount: "0.01", currency: "USDT", requested: [{ role: "trace", method: "debug_traceTransaction" }], summary: { receiptSucceeded: false, trace: { calls: 1, failing: { to: C1, reason: "invalid signature" } } }, perCall: [{ ok: true }, { ok: false }] }], []);
  assert.equal(s.calls[0].bought, "the execution trace"); assert.match(s.calls[0].contributed[0], /invalid signature/); assert.equal(s.calls[0].returned, "1 of 2 checks returned data");
});

const F = (o = {}) => ({ from: ME, to: C1, toIsContract: true, method: "claim", feeWei: "2510190000000000", feeCurrency: "USD₮", timestamp: "2026-10-31T07:35:00Z", transfers: [], status: "error", ...o });
const reasonFinding = { layer: "deep", topic: "reason", kind: "new", confidence: "confirmed", text: 'Inside the transaction, a smart contract (0x2266...03b7) rejected the request with the message "invalid signature".', technical: ["Contract address: 0x" + "22".repeat(20)] };

test("autopsy: free-only failed transaction shows what is not retrieved yet and offers the Deep step", () => {
  const a = buildAutopsy("failed", F(), null, { deepState: "none" });
  assert.equal(a.outcome, "Failed"); assert.equal(a.needsDeep, true);
  assert.deepEqual(a.stages.map((s) => s.title), ["Submission", "Where it was sent", "Where it stopped", "Outcome", "Financial impact"]);
  assert.equal(a.stages[2].lines[0].level, "deepcheck"); assert.match(a.stages[2].lines[0].text, /Deep Investigation/);
  assert.ok(a.unknown.includes("Why it failed."));
  assert.match(a.stages[4].lines[0].text, /has not independently verified/);
});

test("autopsy: with the Deep result it names where it stopped, notes a deeper contract, and keeps the honest unknown", () => {
  const a = buildAutopsy("failed", F(), [reasonFinding], { deepState: "done", paid: { reused: false, paymentTxHash: H(9) } });
  assert.equal(a.needsDeep, false);
  const inside = a.stages[2].lines.map((l) => l.text).join(" | ");
  assert.match(inside, /invalid signature/); assert.match(inside, /deeper inside the call/);
  assert.equal(a.unknown.length, 0);
  assert.equal(a.evidence[1].paymentTxHash, H(9)); assert.ok(a.stages[2].lines[0].source === "deep");
});

test("autopsy: success, pending, unavailable Deep and missing fee are all described without inventing", () => {
  const s = buildAutopsy("success", F({ status: "ok", transfers: [{ token: C2 }, { token: C2 }] }), null, { deepState: "none", transfersKnown: true });
  assert.equal(s.outcome, "Successful"); assert.match(s.stages[4].lines[1].text, /2 token transfer records/);
  const p = buildAutopsy("pending", F({ status: null, feeWei: null }), null, { deepState: "none" });
  assert.equal(p.needsDeep, true); assert.ok(p.stages[4].lines.every((l) => l.level !== "unknown"));
  const u = buildAutopsy("failed", F({ revertReason: null }), null, { deepState: "unavailable", deepText: "payments are off" });
  assert.equal(u.needsDeep, false); assert.ok(u.stages.length > 0);
  const nf = buildAutopsy("failed", F({ feeWei: null }), null, { deepState: "none" });
  assert.ok(!nf.stages[4].lines.some((l) => /fee/.test(l.text) && l.level === "unknown"));
  assert.equal(buildAutopsy("notfound", {}), null);
});

test("follow-ups answer from the evidence and say when it is not known", () => {
  const facts = F({ transfers: [{ from: ME, to: C1, symbol: "USDT", decimals: 6, value: "10000" }] });
  const autopsy = buildAutopsy("failed", facts, null, { deepState: "none" });
  const fee = answerFollowUp("fee", { kind: "failed", facts, autopsy });
  assert.match(fee.lines[0].text, /network fee of 0\.00251019 USD₮.*even though the transaction failed/); assert.ok(fee.lines.every((l) => l.level !== "unknown"));
  const moved = answerFollowUp("moved", { kind: "failed", facts, autopsy });
  assert.match(moved.lines[0].text, /did not take effect/); assert.match(moved.lines[2].text, /0\.01 USDT from/);
  assert.match(answerFollowUp("unknown", { kind: "failed", facts, autopsy }).lines[0].text, /^Why it failed\./);
  assert.equal(answerFollowUp("nope", { facts }).ok, false);
  assert.equal(answerFollowUp("fee", {}).ok, false);
  assert.match(answerFollowUp("fee", { kind: "pending", facts: F({ feeWei: null }), autopsy }).lines[0].text, /No fee has been charged yet/);
});

test("what changed: new items get plain lines, a new contact is flagged, and nothing is paid", async () => {
  const w = { ok: true, items: [{ hash: H(3), summary: "Interacted with a smart contract", status: "success" }, { hash: H(2), summary: "Sent 1 USDT", status: "success" }, { hash: H(1), summary: "old", status: "success" }], intel: { signals: [{ key: "new-contact", technical: ["Address: x", "Transaction: " + H(3)] }] } };
  const calls = [];
  const fake = async (hash) => { calls.push(hash); return { ok: true, kind: "success", transfersKnown: true, headline: { title: "Transaction successful" }, facts: { transfers: [{}, {}] }, autopsy: { unknown: ["What the contract interaction was for. The data shows that it ran, not its purpose."] } }; };
  const c = await explainChanges(w, H(1), { investigateFree: fake });
  assert.equal(c.length, 2); assert.deepEqual(calls, [H(3), H(2)]);
  assert.deepEqual(c[0].lines, ["Transaction successful.", "It involves an address that does not appear earlier in the history checked.", "2 token transfer records detected.", "The purpose of the contract interaction is not established."]);
  assert.equal(c[1].lines[0], "Transaction successful.");
  assert.deepEqual(await explainChanges(w, "bad", { investigateFree: fake }), []);
  const broken = await explainChanges(w, H(1), { investigateFree: async () => { throw new Error("x"); } });
  assert.equal(broken[0].lines[0], "Details could not be loaded for this item.");
});

test("ChainLens never pays by itself: an unexplained failure is offered, and only a request pays", async () => {
  let paid = 0;
  const bad = { hash: H(9), status: "error", result: "execution reverted", block_number: 5, from: { hash: "0x" + "a".repeat(40) }, to: { hash: "0x" + "b".repeat(40), is_contract: true }, fee: { value: "1000" }, gas_used: "10", gas_limit: "100" };
  const deps = { fetchTransaction: async () => ({ ok: true, tx: bad, transfers: { items: [] } }), getPaidEvidence: async () => { paid++; return { available: false, reason: "n/a" }; } };
  const r = await investigate(H(9), deps);
  assert.equal(paid, 0); assert.equal(r.paid.pending, false);
  assert.equal(r.deep.state, "offer"); assert.ok(r.deep.recommended);
  await investigate(H(9), deps, { forcePaid: true });
  assert.equal(paid, 1);
});

test("the provider is named from the Buy route, so the wording matches what is paid", async () => {
  const { providerName, viaBuy } = await import("../lib/provider.js");
  assert.equal(providerName("https://gateway.usebuy.ai/chainstack/celo"), "Chainstack");
  assert.equal(viaBuy(), "Chainstack, through Buy");
  assert.equal(providerName("not a url"), "an independent provider");
});
