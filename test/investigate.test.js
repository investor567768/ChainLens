import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { investigate } from "../lib/investigate.js";
import { fromUnits } from "../lib/format.js";

const H = "0x" + "ab".repeat(32);
const A = "0x" + "11".repeat(20), B = "0x" + "22".repeat(20);

const okTx = { hash: H, status: "ok", result: "success", block_number: 100, timestamp: "2026-11-01T10:00:00Z",
  from: { hash: A }, to: { hash: B, is_contract: true, name: "Router" }, value: "1500000000000000000",
  fee: { value: "2000000000000000" }, gas_used: "50000", gas_limit: "90000", method: "swap" };
const transfers = { items: [{ from: { hash: A }, to: { hash: B }, token: { symbol: "USDC", decimals: "6", type: "ERC-20" }, total: { value: "2500000" } }] };

test("formats units", () => {
  assert.equal(fromUnits("1500000000000000000"), "1.5");
  assert.equal(fromUnits("2500000", 6), "2.5");
  assert.equal(fromUnits("0"), "0");
});

test("rejects bad hash without calling anything", async () => {
  let called = false;
  const r = await investigate("hello", { fetchTransaction: async () => { called = true; } });
  assert.equal(r.ok, false); assert.equal(called, false);
});

test("success is explained from free data, paid not needed", async () => {
  let paidCalled = false;
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: okTx, transfers }), getPaidEvidence: async () => { paidCalled = true; return { available: false }; } });
  assert.equal(r.kind, "success"); assert.equal(paidCalled, false); assert.equal(r.paid.used, false);
  const text = r.findings.map((x) => x.text).join(" ");
  assert.match(text, /1\.5 CELO/); assert.match(text, /2\.5 USDC/);
  assert.match(text, /Interacted with a smart contract/);
  assert.doesNotMatch(text, /swap|Router/, "function and contract names stay out of the main explanation");
  assert.ok(r.findings.some((x) => (x.technical || []).join(" ").includes("swap")), "but they are kept in technical details");
  assert.ok(r.findings.every((x) => ["confirmed", "likely", "unknown"].includes(x.confidence)));
});

test("failed with no reason: says unknown, never invents; fallback works when paid unavailable", async () => {
  const bad = { ...okTx, status: "error", result: "execution reverted", gas_used: "40000", gas_limit: "90000" };
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: bad, transfers: { items: [] } }), getPaidEvidence: async () => ({ available: false, reason: "down" }) }, { forcePaid: true });
  assert.equal(r.kind, "failed");
  assert.equal(r.paid.used, false); assert.equal(r.paid.unavailable, "down");
  assert.ok(r.findings.some((x) => x.confidence === "deepcheck"));
  assert.ok(!r.findings.some((x) => x.confidence === "likely" && !/fee/i.test(x.text)), "no 'likely' claim about the failure without evidence");
  assert.ok(r.findings.length >= 3, "still a useful basic investigation");
});

test("out of gas is only 'likely' and explains why", async () => {
  const bad = { ...okTx, status: "error", gas_used: "90000", gas_limit: "90000" };
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: bad, transfers: { items: [] } }) });
  const l = r.findings.find((x) => x.confidence === "likely" && /gas/i.test(x.text));
  assert.ok(l && /gas/i.test(l.text) && l.why);
});

test("reported revert reason is confirmed and paid not needed", async () => {
  const bad = { ...okTx, status: "error", revert_reason: "insufficient allowance" };
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: bad, transfers: { items: [] } }) });
  assert.ok(r.findings.some((x) => x.confidence === "confirmed" && /insufficient allowance/.test(x.text)));
  assert.equal(r.paid.used, false);
});

test("pending is described honestly", async () => {
  const pend = { hash: H, status: null, block_number: null, from: { hash: A }, to: { hash: B } };
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: pend, transfers: null }) });
  assert.equal(r.kind, "pending");
  assert.ok(r.findings.some((x) => x.confidence === "deepcheck"));
});

test("not found and explorer-down are clear", async () => {
  const nf = await investigate(H, { fetchTransaction: async () => ({ ok: false, notFound: true }) });
  assert.equal(nf.kind, "notfound");
  const down = await investigate(H, { fetchTransaction: async () => ({ ok: false, error: "explorer timed out" }) });
  assert.equal(down.ok, false); assert.match(down.error, /timed out/);
});

test("paid evidence is used and included when available", async () => {
  const bad = { ...okTx, status: "error" };
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: bad, transfers: { items: [] } }), getPaidEvidence: async () => ({ available: true, summary: "ok" }) }, { forcePaid: true });
  assert.equal(r.paid.used, true);
});
