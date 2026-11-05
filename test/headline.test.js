import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, buildHeadline, reconcileFee, normalizeTx } from "../lib/classify.js";
import { investigate } from "../lib/investigate.js";

const SENDER = "0x5deb" + "00".repeat(16) + "ed4a".padStart(8, "0").slice(0, 8);
const addr = (n) => "0x" + n.padStart(40, "0");
const S = "0x5DEB000000000000000000000000000000000a4a", SYS = addr("6a5"), RECV = "0x9aa2000000000000000000000000000000043a1a".slice(0, 42);
const tr = (from, to, value) => ({ from: { hash: from }, to: { hash: to }, token: { symbol: "USDT", decimals: "6", type: "ERC-20" }, total: { value } });
// Mirrors the real 2.9 USDT transaction we tested: 1943 taken, 215 returned, fee 0.00172792 USDT.
const realTransfers = { items: [tr(S, SYS, "1943"), tr(S, RECV, "2900000"), tr(SYS, addr("4200011"), "0"), tr(SYS, addr("cd438778"), "1728"), tr(SYS, S, "215")] };
const tx = { hash: "0x" + "01".repeat(32), status: "ok", result: "success", block_number: 7, timestamp: "2026-11-01T13:57:11Z", from: { hash: S }, to: { hash: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", is_contract: true, name: "Tether USD" }, value: "0", fee: { value: "1727920000000000" }, celo: { gas_token: { symbol: "USDT" } }, method: "transfer" };

test("fee movements reconcile with the reported fee (rounding tolerated)", () => {
  const f = normalizeTx(tx, realTransfers);
  const sys = f.transfers.filter((t) => t.from === SYS || t.to === SYS);
  const rec = reconcileFee(sys, f);
  assert.equal(rec.matches, true); assert.equal(rec.net, "0.001728");
});

test("success: movements shown individually, labelled likely, purpose not claimed as fact", () => {
  const f = normalizeTx(tx, realTransfers);
  const { findings } = classify(f);
  const m = findings.find((x) => x.technical && /movement/i.test(x.text));
  assert.equal(m.confidence, "likely"); assert.equal(m.technical.length, 4);
  assert.match(m.text, /likely fee handling/); assert.match(m.text, /our inference/);
});

test("a mismatch is not dressed up as a finding", () => {
  const f = normalizeTx({ ...tx, fee: { value: "9000000000000000" } }, realTransfers);
  const m = classify(f).findings.find((x) => x.technical && /movement/i.test(x.text));
  assert.equal(m.confidence, "confirmed"); assert.doesNotMatch(m.text, /purpose/); assert.doesNotMatch(m.text, /fee handling/);
});

test("headlines: success, failed (unknown reason), failed (gas), pending, not found", () => {
  const f = normalizeTx(tx, realTransfers);
  const ok = buildHeadline("success", f);
  assert.equal(ok.state, "success"); assert.match(ok.sentence, /2\.9 USDT/);
  const bad = normalizeTx({ ...tx, status: "error", gas_used: "5", gas_limit: "50" }, { items: [] });
  const h1 = buildHeadline("failed", bad); assert.equal(h1.state, "failed"); assert.equal(h1.reason.level, "deepcheck");
  const gas = normalizeTx({ ...tx, status: "error", gas_used: "50", gas_limit: "50" }, { items: [] });
  assert.equal(buildHeadline("failed", gas).reason.level, "likely");
  assert.equal(buildHeadline("pending", {}).state, "pending");
  assert.equal(buildHeadline("notfound", {}).state, "notfound");
});

test("paid trace upgrades the failure reason to confirmed", () => {
  const bad = normalizeTx({ ...tx, status: "error", gas_used: "5", gas_limit: "50" }, { items: [] });
  const h = buildHeadline("failed", bad, { trace: { calls: 2, failing: { error: "execution reverted", reason: "ERC20: insufficient allowance" } } });
  assert.equal(h.reason.level, "confirmed"); assert.match(h.reason.text, /insufficient allowance/);
});

test("pending + paid: provider with no receipt is described carefully, headline stays pending", async () => {
  const pend = { hash: tx.hash, status: null, block_number: null, from: { hash: S }, to: { hash: RECV } };
  const r = await investigate(tx.hash, {
    fetchTransaction: async () => ({ ok: true, tx: pend, transfers: null }),
    getPaidEvidence: async () => ({ available: true, receiptSucceeded: null, receiptMissing: true, trace: null, perCall: [{ method: "debug_traceTransaction", ok: false, error: "transaction not found" }], paymentTxHash: "0xabc" }),
  }, { forcePaid: true });
  assert.equal(r.headline.state, "pending");
  const txt = r.findings.map((x) => x.text).join(" | ");
  assert.match(txt, /no receipt for this transaction yet/); assert.match(txt, /does not tell us why/);
});
