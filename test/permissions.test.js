import test from "node:test";
import assert from "node:assert/strict";
import { parseSqdLines, parseExplorerTxs, latestPairs, checkPermissions, describe, levelOf, APPROVAL_TOPIC, APPROVE_SEL } from "../lib/permissions.js";
import { getPaidPermissions } from "../lib/paid.js";
import { parseAsk } from "../lib/ask.js";

const OWNER = "0x398f4AbF39c59DDb3022BE755DC0f5A4C57b118e";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const S1 = "0x1111111111111111111111111111111111111111";
const S2 = "0x2222222222222222222222222222222222222222";
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const hex = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const MAX = (2n ** 256n - 1n);

const sqdText = [
  JSON.stringify({ header: { number: 100, timestamp: 1760000000 }, logs: [{ address: USDT, topics: [APPROVAL_TOPIC, pad(OWNER), pad(S1)], data: hex(MAX), transactionHash: "0xaa" }] }),
  JSON.stringify({ header: { number: 200, timestamp: 1760100000 }, logs: [
    { address: USDT, topics: [APPROVAL_TOPIC, pad(OWNER), pad(S2)], data: hex(5_000_000), transactionHash: "0xbb" },
    { address: USDT, topics: [APPROVAL_TOPIC, pad(S1), pad(S2)], data: hex(1), transactionHash: "0xcc" },        // someone else's approval
    { address: USDT, topics: [APPROVAL_TOPIC, pad(OWNER), pad(S2), hex(7)], data: "0x", transactionHash: "0xdd" }, // NFT-style, 4 topics
  ] }),
].join("\n");

test("sqd parsing keeps only this owner's ERC-20 approvals", () => {
  const r = parseSqdLines(sqdText, OWNER);
  assert.equal(r.length, 2);
  assert.equal(r[0].amountRaw, MAX.toString());
  assert.equal(r[1].spender.toLowerCase(), S2);
  assert.ok(r[1].at.startsWith("2025-"));
});

test("explorer parsing reads approve() calldata and skips failed or foreign ones", () => {
  const input = APPROVE_SEL + pad(S1).slice(2) + hex(1234).slice(2);
  const items = [
    { raw_input: input, from: { hash: OWNER }, to: { hash: USDT }, status: "ok", timestamp: "2026-10-01T10:00:00Z", hash: "0x1" },
    { raw_input: input, from: { hash: OWNER }, to: { hash: USDT }, status: "error", hash: "0x2" },
    { raw_input: input, from: { hash: S2 }, to: { hash: USDT }, status: "ok", hash: "0x3" },
    { raw_input: "0xa9059cbb", from: { hash: OWNER }, to: { hash: USDT }, status: "ok", hash: "0x4" },
  ];
  const r = parseExplorerTxs(items, OWNER);
  assert.equal(r.length, 1);
  assert.equal(r[0].amountRaw, "1234");
  assert.equal(r[0].spender.toLowerCase(), S1);
});

test("latest approval per pair wins", () => {
  const r = latestPairs([{ token: USDT, spender: S1, at: "2026-01-01T00:00:00Z", amountRaw: "1" }, { token: USDT, spender: S1, at: "2026-02-01T00:00:00Z", amountRaw: "0" }]);
  assert.equal(r.length, 1); assert.equal(r[0].amountRaw, "0");
});

function fakeFetch({ sqd = true } = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    const ok = (body, text) => ({ ok: true, status: 200, json: async () => body, text: async () => text ?? JSON.stringify(body) });
    if (u.endsWith("/head")) return sqd ? ok({ number: 300 }) : { ok: false, status: 500 };
    if (u.endsWith("/stream")) { const b = JSON.parse(opts.body); return b.fromBlock > 200 ? { ok: true, status: 204, text: async () => "" } : ok(null, sqdText); }
    if (u.includes("forno") || u.includes("celo.org")) {
      const calls = JSON.parse(opts.body);
      return ok(calls.map((c) => ({ id: c.id, result: c.params[0].data.toLowerCase().includes(S1.slice(2)) ? hex(MAX) : hex(0) })));
    }
    if (u.includes("/tokens/")) return ok({ symbol: "TKN", decimals: "6" });
    if (u.includes("/addresses/" + S1)) return ok({ is_contract: true, is_verified: false, name: null });
    if (u.includes("/addresses/" + S2)) return ok({ is_contract: true, is_verified: true, name: "Good Router" });
    return { ok: false, status: 404 };
  };
}

test("permission check: unlimited unverified spender is flagged first; cancelled ones are counted", async () => {
  const r = await checkPermissions(OWNER, { fetch: fakeFetch() });
  assert.equal(r.ok, true); assert.equal(r.source, "sqd");
  assert.equal(r.permissions.length, 1);          // S2 now reads 0, so it counts as cancelled
  assert.equal(r.cancelledCount, 1);
  const p = r.permissions[0];
  assert.equal(p.level, "review-first"); assert.equal(p.unlimited, true); assert.equal(p.symbol, "USDT");
  assert.match(p.text, /any amount of your USDT/); assert.match(p.text, /not verified/);
});

test("permission check falls back to the explorer when SQD is unavailable, and says so", async () => {
  const f = async (url, o) => {
    const u = String(url);
    if (u.includes("/transactions?filter=from")) return { ok: true, status: 200, json: async () => ({ items: [{ raw_input: APPROVE_SEL + pad(S1).slice(2) + hex(MAX).slice(2), from: { hash: OWNER }, to: { hash: USDT }, status: "ok", timestamp: "2026-10-01T00:00:00Z", hash: "0x9" }], next_page_params: null }) };
    return fakeFetch({ sqd: false })(url, o);
  };
  const r = await checkPermissions(OWNER, { fetch: f });
  assert.equal(r.source, "explorer"); assert.equal(r.permissions.length, 1);
  assert.ok(r.notes.some((n) => /directly from this wallet/.test(n)));
});

test("permission check: bad address and total failure are handled", async () => {
  assert.equal((await checkPermissions("nope")).ok, false);
  const r = await checkPermissions(OWNER, { fetch: async () => { throw new Error("down"); } });
  assert.equal(r.ok, false); assert.match(r.error, /Could not read/);
});

test("wording and levels", () => {
  assert.equal(levelOf({ unlimited: true, verified: true, isContract: true }), "review");
  assert.equal(levelOf({ unlimited: false, verified: false }), "limited");
  assert.match(describe({ spender: S1, spenderLookup: false, unlimited: false, amountText: "5", symbol: "USDT" }), /could not tell us anything/);
});

test("paid permission double-check: never automatic, one batch, agree/differ, reused without a second charge", async () => {
  process.env.CHAINLENS_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:os")).tmpdir() + "/cl-perm-");
  delete process.env.CHAINLENS_NO_CACHE;
  const perms = [{ token: USDT, spender: S1, allowanceRaw: MAX.toString(), symbol: "USDT", decimals: 6 }, { token: USDT, spender: S2, allowanceRaw: "5", symbol: "USDT", decimals: 6 }];
  let runs = 0;
  const run = async (args) => {
    runs++;
    const i = args.indexOf("--data-file"); const body = JSON.parse((await import("node:fs")).readFileSync(args[i + 1].replace(/"/g, ""), "utf8"));
    assert.equal(body.length, 3, "two allowances and one balance for the one token");
    const o = args.indexOf("-o"); (await import("node:fs")).writeFileSync(args[o + 1].replace(/"/g, ""), JSON.stringify([{ jsonrpc: "2.0", id: 1, result: hex(MAX) }, { jsonrpc: "2.0", id: 2, result: hex(9) }, { jsonrpc: "2.0", id: 3, result: hex(12_400_000) }]));
    return { code: 0, stdout: "", stderr: "paid → 0x" + "ab".repeat(32) };
  };
  const a = await getPaidPermissions(OWNER, perms, "inv_x", { run });
  assert.equal(a.available, true); assert.equal(a.permissions.agree, 1); assert.equal(a.permissions.differ, 1);
  assert.equal(a.paymentTxHash, "0x" + "ab".repeat(32));
  assert.equal(a.permissions.checks[0].atRiskText, "12.4 USDT (your whole balance of this token)"); assert.equal(a.permissions.checks[1].atRiskText, "0.000009 USDT"); assert.equal(a.permissions.checks[0].active, true);
  const b = await getPaidPermissions(OWNER, perms, "inv_y", { run });
  assert.equal(b.reused, true); assert.equal(runs, 1);
  assert.equal((await getPaidPermissions(OWNER, [], "inv_z", { run })).available, false);
});

test("ask routes spending-permission questions about an address", () => {
  const r = parseAsk("who can spend my tokens? " + OWNER);
  assert.equal(r.kind, "permissions"); assert.equal(r.address, OWNER);
  assert.equal(parseAsk("what is in " + OWNER).kind, "wallet");
});
