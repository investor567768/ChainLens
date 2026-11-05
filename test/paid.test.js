import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { getPaidEvidence, parsePaymentHash, buildBatch } from "../lib/paid.js";
import { investigate } from "../lib/investigate.js";
import { decodeRevertOutput, summarizeTrace } from "../lib/trace.js";

process.env.MAX_PAID_PER_DAY = "1000";
process.env.CHAINLENS_NO_CACHE = "1";
const H = "0x" + "ab".repeat(32);
const PAY = "0x" + "cd".repeat(32);
const A = "0x" + "11".repeat(20), B = "0x" + "22".repeat(20);
const errStr = "0x08c379a0" + "20".padStart(64, "0") + "0f".padStart(64, "0") + Buffer.from("not enough gas!").toString("hex").padEnd(64, "0");

// Fake buy: finds the -o path, writes a provider answer, prints a "paid" line like the real tool.
const fakeBuy = (answer, { code = 0, paid = true } = {}) => async (args) => {
  const out = args[args.indexOf("-o") + 1].replace(/"/g, "");
  if (answer) await writeFile(out, JSON.stringify(answer));
  return { code, stdout: "", stderr: `buy 402 -> 0.01 USDT\n${paid ? "buy paid -> " + PAY : ""}\n` };
};
const good = (traceResult, receiptStatus = "0x0") => [
  { id: 1, result: { hash: H } }, { id: 2, result: { status: receiptStatus, gasUsed: "0x5", logs: [] } }, { id: 3, result: traceResult },
];

test("parses payment hash from buy's verbose line", () => {
  assert.equal(parsePaymentHash(`x\n\x1b[2mbuy\x1b[0m paid → ${PAY}\n`), PAY);
  assert.equal(parsePaymentHash("nothing here"), null);
});

test("batch asks for the 3 calls we need", () => {
  assert.deepEqual(buildBatch(H).map((b) => b.method), ["eth_getTransactionByHash", "eth_getTransactionReceipt", "debug_traceTransaction"]);
});

test("decodes a standard revert string", () => {
  assert.equal(decodeRevertOutput(errStr), "not enough gas!");
  assert.equal(decodeRevertOutput("0x1234"), null);
});

test("trace summary finds the deepest failing call", () => {
  const s = summarizeTrace({ type: "CALL", to: A, calls: [{ type: "CALL", to: B, input: "0xa9059cbb00", error: "execution reverted", output: errStr }] });
  assert.equal(s.failing.to, B); assert.equal(s.failing.reason, "not enough gas!"); assert.equal(s.calls, 2);
});

test("paid evidence success is recorded with the payment hash", async () => {
  const r = await getPaidEvidence(H, "inv_t1", { run: fakeBuy(good({ type: "CALL", to: B, error: "execution reverted", output: errStr })) });
  assert.equal(r.available, true); assert.equal(r.paymentTxHash, PAY);
  assert.equal(r.ledger.amount, "0.01"); assert.equal(r.ledger.currency, "USDT"); assert.equal(r.receiptSucceeded, false);
  assert.ok(r.ledger.resultDigest && r.ledger.resultDigest.length === 64);
});

test("failed tx + paid trace gives confirmed, sourced findings (and agreement)", async () => {
  const tx = { hash: H, status: "error", result: "execution reverted", block_number: 5, from: { hash: A }, to: { hash: B, is_contract: true }, fee: { value: "1000" }, gas_used: "10", gas_limit: "100" };
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx, transfers: { items: [] } }), getPaidEvidence: (h, id) => getPaidEvidence(h, id, { run: fakeBuy(good({ type: "CALL", to: B, error: "execution reverted", output: errStr })) }) }, { forcePaid: true });
  assert.equal(r.paid.used, true); assert.equal(r.paid.paymentTxHash, PAY);
  const txt = r.findings.map((f) => f.text).join(" | ");
  assert.match(txt, /agrees: the transaction failed/); assert.match(txt, /not enough gas!/);
  assert.ok(r.findings.filter((f) => f.source).every((f) => f.confidence === "confirmed" || f.confidence === "unknown"));
});

test("disagreement between sources is stated, not hidden", async () => {
  const tx = { hash: H, status: "ok", result: "success", block_number: 5, from: { hash: A }, to: { hash: B }, fee: { value: "1" } };
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx, transfers: { items: [] } }), getPaidEvidence: (h, id) => getPaidEvidence(h, id, { run: fakeBuy(good({ type: "CALL", to: B }, "0x0")) }) }, { forcePaid: true });
  assert.match(r.findings.map((f) => f.text).join(" "), /disagree/);
});

test("forcePaid on a clean success still pays only when asked", async () => {
  const tx = { hash: H, status: "ok", result: "success", block_number: 5, from: { hash: A }, to: { hash: B }, fee: { value: "1" } };
  let calls = 0;
  const deps = { fetchTransaction: async () => ({ ok: true, tx, transfers: { items: [] } }), getPaidEvidence: async () => { calls++; return { available: false, reason: "x" }; } };
  await investigate(H, deps); assert.equal(calls, 0);
  await investigate(H, deps, { forcePaid: true }); assert.equal(calls, 1);
});

test("buy failure is reported honestly and never retried", async () => {
  let runs = 0;
  const run = async () => { runs++; return { code: 1, stdout: "", stderr: "error: curl failed: Could not resolve host" }; };
  const r = await getPaidEvidence(H, "inv_t2", { run });
  assert.equal(r.available, false); assert.equal(runs, 1); assert.match(r.reason, /You were not charged/); assert.doesNotMatch(r.reason, /retried/);
});

test("payment made but call failed is flagged as paid-but-failed", async () => {
  const r = await getPaidEvidence(H, "inv_t3", { run: async () => ({ code: 22, stdout: "", stderr: `buy paid -> ${PAY}\nerror 500` }) });
  assert.equal(r.available, false); assert.equal(r.ledger.status, "paid-but-failed"); assert.match(r.reason, /paid for, but the answer did not arrive/); assert.match(r.reason, /did not pay a second time/);
});

test("daily budget stops paid calls", async () => {
  process.env.MAX_PAID_PER_DAY = "0";
  const r = await getPaidEvidence(H, "inv_t4", { run: async () => { throw new Error("must not run"); } });
  assert.equal(r.available, false); assert.match(r.reason, /budget/);
  process.env.MAX_PAID_PER_DAY = "1000";
});

test("same transaction is never paid for twice (cache from ledger)", async () => {
  process.env.CHAINLENS_NO_CACHE = "0";
  const hash = "0x" + "e1".repeat(32);
  let runs = 0;
  const run = async (args) => { runs++; return fakeBuy(good({ type: "CALL", to: B }, "0x1"))(args); };
  const a = await getPaidEvidence(hash, "inv_c1", { run });
  const b = await getPaidEvidence(hash, "inv_c2", { run });
  assert.equal(runs, 1); assert.equal(a.reused, undefined); assert.equal(b.reused, true);
  assert.equal(b.paymentTxHash, PAY); assert.equal(b.receiptSucceeded, true);
  process.env.CHAINLENS_NO_CACHE = "1";
});

test("two simultaneous requests for one transaction pay only once", async () => {
  process.env.CHAINLENS_NO_CACHE = "0";
  const hash = "0x" + "e2".repeat(32);
  let runs = 0;
  const run = async (args) => { runs++; await new Promise((r) => setTimeout(r, 30)); return fakeBuy(good({ type: "CALL", to: B }, "0x1"))(args); };
  const [a, b] = await Promise.all([getPaidEvidence(hash, "inv_d1", { run }), getPaidEvidence(hash, "inv_d2", { run })]);
  assert.equal(runs, 1); assert.equal(a.paymentTxHash, b.paymentTxHash);
  process.env.CHAINLENS_NO_CACHE = "1";
});

import { failureReason } from "../lib/paid.js";
test("failure wording: one plain sentence per situation, never alarming", () => {
  assert.match(failureReason("... spend_cap_exceeded ...", null), /daily limit\. You were not charged/);
  assert.match(failureReason("some other error", null), /try again in a few minutes/);
  assert.match(failureReason("x", "0xabc"), /paid for, but the answer did not arrive/);
});
