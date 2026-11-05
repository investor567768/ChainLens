import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTx, summarizeWallet } from "../lib/wallet.js";
import { investigateFree, addPaid } from "../lib/investigate.js";

const ME = "0x" + "aa".repeat(20), OTHER = "0x" + "bb".repeat(20), SYS = "0x" + "0".repeat(36) + "06a5";
const base = { hash: "0x" + "01".repeat(32), status: "ok", result: "success", block_number: 9, timestamp: "2026-11-01T10:00:00Z", from: { hash: ME }, to: { hash: OTHER }, value: "0" };

test("describes a sent token transfer, ignoring fee-style movements", () => {
  const t = [{ from: ME, to: OTHER, symbol: "USDT", decimals: 6, value: "2900000" }, { from: ME, to: SYS, symbol: "USDT", decimals: 6, value: "1943" }];
  const d = describeTx(base, ME, t);
  assert.equal(d.status, "success"); assert.equal(d.direction, "out"); assert.match(d.summary, /^Sent 2\.9 USDT to 0xbbbb/); assert.doesNotMatch(d.summary, /more transfer/);
});
test("describes received CELO, failed and pending", () => {
  assert.match(describeTx({ ...base, from: { hash: OTHER }, to: { hash: ME }, value: "1500000000000000000" }, ME).summary, /Received 1\.5 CELO/);
  const f = describeTx({ ...base, status: "error" }, ME); assert.equal(f.status, "failed"); assert.match(f.summary, /^Failed: /);
  const p = describeTx({ ...base, status: null, block_number: null }, ME); assert.equal(p.status, "pending");
});
test("describes a contract call", () => {
  const d = describeTx({ ...base, to: { hash: OTHER, is_contract: true, name: "Router" }, method: "swap" }, ME);
  assert.equal(d.summary, "Interacted with a smart contract");
});
test("wallet summary: validates, merges token transfers, survives token-endpoint failure", async () => {
  assert.equal((await summarizeWallet("nope")).ok, false);
  const ok = await summarizeWallet(ME, {
    fetchAddressTransactions: async () => ({ ok: true, data: { items: [base] } }),
    fetchAddressTokenTransfers: async () => ({ ok: true, data: { items: [{ transaction_hash: base.hash, from: { hash: ME }, to: { hash: OTHER }, token: { symbol: "USDC", decimals: "6" }, total: { value: "5000000", decimals: "6" } }] } }),
  });
  assert.match(ok.items[0].summary, /Sent 5 USDC/);
  const degraded = await summarizeWallet(ME, { fetchAddressTransactions: async () => ({ ok: true, data: { items: [base] } }), fetchAddressTokenTransfers: async () => ({ ok: false, error: "x" }) });
  assert.equal(degraded.ok, true); assert.ok(degraded.note);
  const down = await summarizeWallet(ME, { fetchAddressTransactions: async () => ({ ok: false, error: "timed out" }), fetchAddressTokenTransfers: async () => ({ ok: false }) });
  assert.equal(down.ok, false);
  const empty = await summarizeWallet(ME, { fetchAddressTransactions: async () => ({ ok: false, notFound: true }), fetchAddressTokenTransfers: async () => ({ ok: false }) });
  assert.equal(empty.ok, true); assert.equal(empty.items.length, 0);
});
test("free phase never pays; paid phase adds findings", async () => {
  const bad = { ...base, status: "error" };
  let paidCalls = 0;
  const deps = { fetchTransaction: async () => ({ ok: true, tx: bad, transfers: { items: [] } }), getPaidEvidence: async () => { paidCalls++; return { available: true, receiptSucceeded: false, trace: { calls: 1, failing: null }, perCall: [], paymentTxHash: "0xabc" }; } };
  const free = await investigateFree(base.hash, deps, { forcePaid: true });
  assert.equal(paidCalls, 0); assert.equal(free.paid.pending, true);
  const more = await addPaid(base.hash, free, deps);
  assert.equal(paidCalls, 1); assert.equal(more.paid.used, true); assert.ok(more.findings.length >= 2);
});
