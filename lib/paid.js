// Paid independent evidence: Chainstack Celo JSON-RPC, bought through the buy CLI (x402).
// Safety rules baked in:
//  - one payment per investigation, NEVER retried automatically (payments are final)
//  - hard per-call cap (--max-amount) plus a daily budget counted from our own ledger
//  - the wallet key is never read by this code; buy signs using the OS keychain

import { spawn } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { record, digest, readAll, findPaidFor } from "./evidence.js";
import { summarizeTrace, summarizeMovements, receiptSucceeded } from "./trace.js";
import { planCalls, analyzeEvidence } from "./plan.js";

export const cfg = () => ({
  route: process.env.BUY_ROUTE || "https://gateway.usebuy.ai/chainstack/celo",
  token: process.env.BUY_TOKEN || "USDT",
  max: process.env.BUY_MAX_AMOUNT || "0.01",
  cmd: process.env.BUY_CMD || (process.platform === "win32" ? "buy.cmd" : "buy"),
  account: process.env.BUY_ACCOUNT || "",
  daily: Number(process.env.MAX_PAID_PER_DAY || 10),
  enabled: process.env.PAID_ENABLED !== "0",
  timeoutMs: Number(process.env.BUY_TIMEOUT_MS || 60000),
});

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const q = (p) => `"${p}"`;

export function runBuy(args, { timeoutMs = 60000, cmd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: true, windowsHide: true });
    let stdout = "", stderr = "", done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { child.kill(); finish({ code: -1, stdout, stderr, timedOut: true }); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish({ code: -1, stdout, stderr: stderr + String(e.message) }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

export function buildBatch(hash) {
  return planCalls(hash, null, "verify").map(({ role, ...rpc }) => ({ jsonrpc: "2.0", ...rpc }));
}

// One plain sentence per situation. Never alarming, never vague about money.
export function failureReason(log, paymentTxHash) {
  if (paymentTxHash) return "The check was paid for, but the answer did not arrive. ChainLens did not pay a second time.";
  if (/spend_cap_exceeded|daily spend cap/i.test(log || "")) return "The paying account has reached its daily limit. You were not charged.";
  return "The Deep Investigation did not go through. You were not charged. Please try again in a few minutes.";
}

export function parsePaymentHash(text) {
  const m = stripAnsi(text).match(/paid\s*(?:→|->|=>|:)?\s*(0x[0-9a-fA-F]{64})/);
  return m ? m[1] : null;
}

export async function paidToday() {
  const today = new Date().toISOString().slice(0, 10);
  return (await readAll()).filter((r) => r.at?.startsWith(today) && r.kind === "paid-call" && r.status !== "not-attempted").length;
}

const inflight = new Map();

export function getPaidEvidence(hash, investigationId, deps = {}) {
  // One payment at a time per transaction, even if two requests arrive together.
  if (inflight.has(hash)) return inflight.get(hash);
  const p = doPaid(hash, investigationId, deps).finally(() => inflight.delete(hash));
  inflight.set(hash, p);
  return p;
}

async function doPaid(hash, investigationId, deps = {}) {
  const c = cfg();
  const purpose = deps.purpose || "verify";
  const facts = deps.facts || null;
  const plan = planCalls(hash, facts, purpose);
  // The same transaction with the same set of calls is never bought twice, whatever the stated reason.
  const subject = `${hash}|${plan.map((p) => p.id).join("")}`;
  // A free-text note from the user is stored as a plain note. It is never read as an instruction.
  const userNote = typeof deps.note === "string" ? deps.note.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 200) || null : null;

  if (process.env.CHAINLENS_NO_CACHE !== "1") {
    const earlier = await findPaidFor(subject);
    if (earlier) {
      return { available: true, reused: true, paymentTxHash: earlier.paymentTxHash, perCall: earlier.perCall, ledger: earlier, ...earlier.summary };
    }
  }
  const run = deps.run || ((args) => runBuy(args, { timeoutMs: c.timeoutMs, cmd: c.cmd }));
  if (!c.enabled) return { available: false, reason: "Deep Investigations are switched off on this server." };
  if ((await paidToday()) >= c.daily) return { available: false, reason: "Today's paid-check budget has been used. The free explanation above still applies." };

  const batch = plan.map(({ role, ...rpc }) => ({ jsonrpc: "2.0", ...rpc }));
  const base = {
    kind: "paid-call", subject, tx: hash, purpose, ...(deps.sessionId ? { sessionId: String(deps.sessionId).slice(0, 24) } : {}), ...(deps.orderer ? { orderer: String(deps.orderer).toLowerCase() } : {}), ...(userNote ? { userNote } : {}), investigationId, provider: "Chainstack Celo RPC via buy (x402)", route: c.route,
    requested: plan.map((b) => ({ id: b.id, role: b.role, method: b.method })), amount: c.max, currency: c.token,
  };

  const dir = await mkdtemp(path.join(os.tmpdir(), "chainlens-"));
  const bodyPath = path.join(dir, "body.json");
  const respPath = path.join(dir, "response.json");
  try {
    await writeFile(bodyPath, JSON.stringify(batch), "utf8");
    const args = [
      ...(c.account ? ["--account", c.account] : []),
      "--verbose", "curl", "--token", c.token, "--max-amount", c.max,
      "-X", "POST", "-H", '"content-type: application/json"',
      "--data-file", q(bodyPath), "-o", q(respPath), c.route,
    ];
    const res = await run(args);
    const log = stripAnsi((res.stderr || "") + "\n" + (res.stdout || ""));
    const paymentTxHash = parsePaymentHash(log);

    if (res.code !== 0) {
      // If we saw a payment line, money may have moved. Record that honestly. Never retry.
      console.log("[paid] call failed (exit " + res.code + (res.timedOut ? ", timed out" : "") + "):", log.replace(/(0x)?[0-9a-fA-F]{64}/g, "[hash]").trim().slice(-700));
      const row = await record({ ...base, status: paymentTxHash ? "paid-but-failed" : "failed", paymentTxHash, error: log.trim().split("\n").slice(-3).join(" | ").slice(0, 300) });
      return { available: false, reason: failureReason(log, paymentTxHash), ledger: row };
    }

    let results;
    try { results = JSON.parse((await readFile(respPath, "utf8")).replace(/^\uFEFF/, "")); } catch { results = null; }
    if (!Array.isArray(results)) {
      const row = await record({ ...base, status: "unreadable", paymentTxHash, error: "provider response was not a JSON-RPC batch" });
      return { available: false, reason: "The Deep Investigation answered, but ChainLens could not read the answer. You were not charged twice.", ledger: row };
    }

    const byId = Object.fromEntries(results.map((r) => [String(r.id), r]));
    const perCall = plan.map((b) => ({ id: b.id, role: b.role, method: b.method, ok: !!byId[b.id] && !byId[b.id].error && byId[b.id].result != null, error: byId[b.id]?.error?.message || (byId[b.id] ? null : "no answer returned") }));
    const receipt = byId["2"]?.result || null;
    const trace = byId["3"]?.result || null;
    const summary = {
      receiptSucceeded: receiptSucceeded(receipt),
      receiptMissing: !!byId["2"] && !byId["2"].error && byId["2"].result == null,
      receipt: receipt ? { status: receipt.status, gasUsed: receipt.gasUsed, logs: Array.isArray(receipt.logs) ? receipt.logs.length : null } : null,
      trace: summarizeTrace(trace),
      movements: summarizeMovements(trace),
      extras: analyzeEvidence(facts, plan, byId),
    };
    const row = await record({ ...base, status: paymentTxHash ? "ok" : "ok-no-payment-hash", paymentTxHash, perCall, resultDigest: digest(results), summary });
    return { available: true, paymentTxHash, perCall, ledger: row, ...summary };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- Permission Check: one independent re-read of every active allowance, in ONE paid batch.
// Same safety rules as above: never automatic, never retried, per-call cap, daily budget.
import { allowanceCall } from "./permissions.js";
import { fromUnits } from "./format.js";

const inflightPerm = new Map();
export function getPaidPermissions(address, perms, investigationId, deps = {}) {
  const key = String(address).toLowerCase();
  if (inflightPerm.has(key)) return inflightPerm.get(key);
  const p = doPaidPermissions(address, perms, investigationId, deps).finally(() => inflightPerm.delete(key));
  inflightPerm.set(key, p);
  return p;
}

async function doPaidPermissions(address, perms, investigationId, deps = {}) {
  const c = cfg();
  const list = (Array.isArray(perms) ? perms : []).slice(0, 40);
  if (!list.length) return { available: false, reason: "There are no active approvals to check again." };
  const plan = list.map((p, i) => ({ id: i + 1, role: "allowance", method: "eth_call", params: [allowanceCall(p.token, address, p.spender), "latest"] }));
  // One balance read per token, in the same paid batch, so the answer can say how much could actually be taken now.
  const tokenList = [...new Set(list.map((p) => String(p.token).toLowerCase()))];
  tokenList.forEach((t, j) => plan.push({ id: list.length + 1 + j, role: "balance", method: "eth_call", params: [{ to: t, data: "0x70a08231" + String(address).slice(2).toLowerCase().padStart(64, "0") }, "latest"] }));
  const subject = `perm|${String(address).toLowerCase()}|${digest(list.map((p) => [p.token, p.spender, p.allowanceRaw]))}|${new Date().toISOString().slice(0, 10)}`;

  if (process.env.CHAINLENS_NO_CACHE !== "1") {
    const earlier = await findPaidFor(subject);
    if (earlier) return { available: true, reused: true, paymentTxHash: earlier.paymentTxHash, ledger: earlier, ...earlier.summary };
  }
  const run = deps.run || ((args) => runBuy(args, { timeoutMs: c.timeoutMs, cmd: c.cmd }));
  if (!c.enabled) return { available: false, reason: "Deep Investigations are switched off on this server." };
  if ((await paidToday()) >= c.daily) return { available: false, reason: "Today's paid-check budget has been used. The free result above still applies." };

  const batch = plan.map(({ role, ...rpc }) => ({ jsonrpc: "2.0", ...rpc }));
  const base = { kind: "paid-call", subject, tx: null, address, purpose: "permissions", ...(deps.sessionId ? { sessionId: String(deps.sessionId).slice(0, 24) } : {}), ...(deps.orderer ? { orderer: String(deps.orderer).toLowerCase() } : {}), investigationId, provider: "Chainstack Celo RPC via buy (x402)", route: c.route, requested: plan.map((b) => ({ id: b.id, role: b.role, method: b.method })), amount: c.max, currency: c.token };

  const dir = await mkdtemp(path.join(os.tmpdir(), "chainlens-"));
  const bodyPath = path.join(dir, "body.json"), respPath = path.join(dir, "response.json");
  try {
    await writeFile(bodyPath, JSON.stringify(batch), "utf8");
    const args = [...(c.account ? ["--account", c.account] : []), "--verbose", "curl", "--token", c.token, "--max-amount", c.max, "-X", "POST", "-H", '"content-type: application/json"', "--data-file", q(bodyPath), "-o", q(respPath), c.route];
    const res = await run(args);
    const log = stripAnsi((res.stderr || "") + "\n" + (res.stdout || ""));
    const paymentTxHash = parsePaymentHash(log);
    if (res.code !== 0) {
      console.log("[paid] call failed (exit " + res.code + (res.timedOut ? ", timed out" : "") + "):", log.replace(/(0x)?[0-9a-fA-F]{64}/g, "[hash]").trim().slice(-700));
      const row = await record({ ...base, status: paymentTxHash ? "paid-but-failed" : "failed", paymentTxHash, error: log.trim().split("\n").slice(-3).join(" | ").slice(0, 300) });
      return { available: false, reason: failureReason(log, paymentTxHash), ledger: row };
    }
    let results; try { results = JSON.parse((await readFile(respPath, "utf8")).replace(/^﻿/, "")); } catch { results = null; }
    if (!Array.isArray(results)) {
      const row = await record({ ...base, status: "unreadable", paymentTxHash, error: "provider response was not a JSON-RPC batch" });
      return { available: false, reason: "The Deep Investigation answered, but ChainLens could not read the answer. You were not charged twice.", ledger: row };
    }
    const byId = Object.fromEntries(results.map((r) => [String(r.id), r]));
    const perCall = plan.map((b) => ({ id: b.id, role: b.role, method: b.method, ok: !!byId[b.id] && !byId[b.id].error && byId[b.id].result != null, error: byId[b.id]?.error?.message || (byId[b.id] ? null : "no answer returned") }));
    const hexNum = (r) => (typeof r === "string" && /^0x[0-9a-fA-F]+$/.test(r) ? BigInt(r) : null);
    const balances = {};
    tokenList.forEach((t, j) => { balances[t] = hexNum(byId[String(list.length + 1 + j)]?.result); });
    const checks = list.map((p, i) => {
      const a = hexNum(byId[String(i + 1)]?.result), got = a == null ? null : a.toString();
      const bal = balances[String(p.token).toLowerCase()];
      const state = got == null ? "no-answer" : got === String(p.allowanceRaw) ? "agree" : "differ";
      let atRiskText = null;
      if (a != null && bal != null && p.decimals != null) {
        if (a === 0n) atRiskText = "nothing: this approval is no longer active";
        else { const m = a < bal ? a : bal; atRiskText = `${fromUnits(m.toString(), p.decimals, 6)} ${p.symbol || "tokens"}${m === bal && a > bal ? " (your whole balance of this token)" : ""}`; }
      }
      return { token: p.token, spender: p.spender, freeRaw: p.allowanceRaw, paidRaw: got, state, active: a == null ? null : a > 0n, atRiskText };
    });
    const summary = { permissions: { checked: checks.length, agree: checks.filter((x) => x.state === "agree").length, differ: checks.filter((x) => x.state === "differ").length, noAnswer: checks.filter((x) => x.state === "no-answer").length, checks } };
    const row = await record({ ...base, status: paymentTxHash ? "ok" : "ok-no-payment-hash", paymentTxHash, perCall, resultDigest: digest(results), summary });
    return { available: true, paymentTxHash, perCall, ledger: row, ...summary };
  } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// How many Deep Investigations this ordering wallet has had paid today (UTC). Used for the daily cap.
export const ORDER_CAP = 2;
export async function orderedToday(orderer, now = new Date()) {
  const day = now.toISOString().slice(0, 10), o = String(orderer || "").toLowerCase();
  if (!o) return 0;
  return (await readAll()).filter((r) => r.kind === "paid-call" && r.orderer === o && r.at?.startsWith(day) && ["ok", "ok-no-payment-hash", "paid-but-failed"].includes(r.status)).length;
}
