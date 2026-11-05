import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { planCalls, decodeErc20Call, analyzeEvidence, ERC20_TRANSFER_TOPIC } from "../lib/plan.js";
import { getPaidEvidence } from "../lib/paid.js";
import { investigate } from "../lib/investigate.js";

process.env.CHAINLENS_NO_CACHE = "1";
process.env.MAX_PAID_PER_DAY = "1000";
const pad = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hex = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const H = "0x" + "9a".repeat(32), PAY = "0x" + "77".repeat(32);
const TOKEN = "0x" + "11".repeat(20), HOLDER = "0x" + "22".repeat(20), TO = "0x" + "33".repeat(20), SPENDER = "0x" + "44".repeat(20);
const transferInput = (to, amt) => "0xa9059cbb" + pad(to) + pad("0x" + BigInt(amt).toString(16));

// A fake buy that answers each JSON-RPC call from a function, like a provider would.
const smartBuy = (answer) => async (args) => {
  const bodyPath = args[args.indexOf("--data-file") + 1].replace(/"/g, "");
  const out = args[args.indexOf("-o") + 1].replace(/"/g, "");
  const batch = JSON.parse(await readFile(bodyPath, "utf8"));
  await writeFile(out, JSON.stringify(batch.map((c) => ({ jsonrpc: "2.0", id: c.id, ...answer(c) }))));
  return { code: 0, stdout: "", stderr: `buy paid -> ${PAY}` };
};
const withRun = (run) => (h, id, o) => getPaidEvidence(h, id, { ...o, run });

const failedTx = (extra = {}) => ({ hash: H, status: "error", result: "execution reverted", block_number: 100, from: { hash: HOLDER }, to: { hash: TOKEN, is_contract: true, name: "Token" }, raw_input: transferInput(TO, 50_000_000), fee: { value: "1000" }, gas_used: "10", gas_limit: "100", ...extra });

test("decodes transfer and transferFrom", () => {
  const d = decodeErc20Call({ from: HOLDER, to: TOKEN, input: transferInput(TO, 5) });
  assert.equal(d.kind, "transfer"); assert.equal(d.amount, 5n); assert.equal(d.holder, HOLDER);
  const tf = decodeErc20Call({ from: SPENDER, to: TOKEN, input: "0x23b872dd" + pad(HOLDER) + pad(TO) + pad("0x2a") });
  assert.equal(tf.kind, "transferFrom"); assert.equal(tf.amount, 42n); assert.equal(tf.holder.toLowerCase(), HOLDER); assert.equal(tf.spender, SPENDER);
  assert.equal(decodeErc20Call({ from: HOLDER, to: TOKEN, input: "0x12345678" }), null);
});

test("call plan depends on the reason", () => {
  const f = { status: "error", block: 100, from: HOLDER, to: TOKEN, input: transferInput(TO, 5) };
  assert.deepEqual(planCalls(H, f, "verify").map((c) => c.role), ["tx", "receipt", "trace"]);
  const failed = planCalls(H, f, "failed");
  assert.deepEqual(failed.map((c) => c.role), ["tx", "receipt", "trace", "balance", "decimals"]);
  assert.equal(failed[3].params[1], "0x63"); // block 100 - 1
  const pend = planCalls(H, { status: null, block: null, from: HOLDER, nonce: 5 }, "pending");
  assert.deepEqual(pend.slice(3).map((c) => c.role), ["nonceLatest", "noncePending", "gasPrice"]);
});

test("failed transfer: balance below amount -> confirmed numbers + likely cause; headline reflects it", async () => {
  const run = smartBuy((c) => {
    if (c.method === "eth_call") return { result: c.params[0].data.startsWith("0x70a08231") ? hex(12_000_000) : hex(6) };
    if (c.method === "eth_getTransactionReceipt") return { result: { status: "0x0", logs: [] } };
    if (c.method === "debug_traceTransaction") return { result: { type: "CALL", to: TOKEN } };
    return { result: { hash: H } };
  });
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: failedTx(), transfers: { items: [] } }), getPaidEvidence: withRun(run) }, { purpose: "failed", forcePaid: true });
  assert.equal(r.paid.used, true); assert.equal(r.paid.purpose, "failed");
  const txt = r.findings.map((x) => x.text).join(" | ");
  assert.match(txt, /held 12 of this token/); assert.match(txt, /move 50\./); assert.match(txt, /likely cause/);
  assert.equal(r.headline.reason.level, "likely"); assert.match(r.headline.reason.text, /less of the token/);
  assert.equal(r.paid.ledger.purpose, "failed");
});

test("failed transfer: enough balance -> says funds do not explain it, no invented cause", async () => {
  const run = smartBuy((c) => c.method === "eth_call" ? { result: c.params[0].data.startsWith("0x70a08231") ? hex(900_000_000) : hex(6) } : c.method === "eth_getTransactionReceipt" ? { result: { status: "0x0", logs: [] } } : { result: { type: "CALL", to: TOKEN } });
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: failedTx(), transfers: { items: [] } }), getPaidEvidence: withRun(run) }, { purpose: "failed", forcePaid: true });
  assert.match(r.findings.map((x) => x.text).join(" | "), /does not explain this failure/);
  assert.ok(!r.headline.reason || r.headline.reason.level !== "confirmed");
});

test("unsupported historical call is reported as an error, never guessed", async () => {
  const run = smartBuy((c) => c.method === "eth_call" ? { error: { message: "method not supported" } } : c.method === "eth_getTransactionReceipt" ? { result: { status: "0x0", logs: [] } } : { result: { type: "CALL", to: TOKEN } });
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: failedTx(), transfers: { items: [] } }), getPaidEvidence: withRun(run) }, { purpose: "failed", forcePaid: true });
  assert.ok(r.paid.perCall.some((c) => c.method === "eth_call" && !c.ok && /not supported/.test(c.error)));
  assert.doesNotMatch(r.findings.map((x) => x.text).join(" "), /held/);
  assert.ok(!r.headline.reason || r.headline.reason.level !== "confirmed");
});

test("pending: earlier unconfirmed transactions and low fee become likely causes", async () => {
  const pend = { hash: H, status: null, block_number: null, from: { hash: HOLDER }, to: { hash: TO }, nonce: 5, gas_price: "1000" };
  const run = smartBuy((c) => c.method === "eth_getTransactionCount" ? { result: c.params[1] === "latest" ? "0x3" : "0x6" } : c.method === "eth_gasPrice" ? { result: "0x7d0" } : { result: null });
  const r = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: pend, transfers: null }), getPaidEvidence: withRun(run) }, { forcePaid: true });
  assert.equal(r.paid.purpose, "pending");
  const txt = r.findings.map((x) => x.text).join(" | ");
  assert.match(txt, /2 earlier transactions/); assert.match(txt, /below the network's current minimum/);
  assert.equal(r.headline.state, "pending"); assert.equal(r.headline.reason.level, "likely");
});

test("verify: receipt event logs are compared with the explorer's transfers", async () => {
  const ok = { hash: H, status: "ok", result: "success", block_number: 7, from: { hash: HOLDER }, to: { hash: TOKEN, is_contract: true }, fee: { value: "1" } };
  const transfers = { items: [{ from: { hash: HOLDER }, to: { hash: TO }, token: { symbol: "T", decimals: "6", type: "ERC-20" }, total: { value: "5" } }] };
  const log = (n) => ({ topics: [ERC20_TRANSFER_TOPIC, "0x" + "0".repeat(64), "0x" + "0".repeat(64)].slice(0, n) });
  const mk = (logs) => smartBuy((c) => c.method === "eth_getTransactionReceipt" ? { result: { status: "0x1", logs } } : { result: { type: "CALL", to: TOKEN } });
  const agree = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: ok, transfers }), getPaidEvidence: withRun(mk([log(3)])) }, { forcePaid: true });
  assert.match(agree.findings.map((x) => x.text).join(" "), /shows the same 1 token transfer record/);
  const differ = await investigate(H, { fetchTransaction: async () => ({ ok: true, tx: ok, transfers }), getPaidEvidence: withRun(mk([log(3), log(3)])) }, { forcePaid: true });
  assert.match(differ.findings.map((x) => x.text).join(" "), /do not match/);
});

test("analysis returns nothing it cannot support", () => {
  assert.deepEqual(analyzeEvidence(null, [], {}), {});
});
