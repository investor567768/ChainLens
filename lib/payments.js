// The proof page: every paid call, with the facts a reviewer needs to check it.
// Built only from the ledger. Amounts are the per-call cap set in this app; the payment
// transaction on Celoscan is the source of truth for what was actually moved.
import { short, plural, joinList } from "./format.js";
// Only successful Deep Investigations are listed and counted. Payments that went through but gave
// no usable answer stay out of this page (they show in the person's own Activity).
const PAID = new Set(["ok", "ok-no-payment-hash"]);

const BOUGHT = { tx: "the transaction record", receipt: "the receipt", trace: "the execution trace", balance: "the sender's token balance from just before it", decimals: "the token's decimal places", allowance: "the spending allowance", nonceLatest: "the wallet's transaction count", noncePending: "the wallet's pending transaction count", gasPrice: "the network's minimum fee" };

// What was bought, in plain words, from the methods that were requested.
export function describeBought(requested = []) {
  const parts = [...new Set(requested.map((r) => BOUGHT[r.role]).filter(Boolean))];
  return parts.length ? joinList(parts) : null;
}

// What the purchase contributed, read ONLY from the stored result. Never from the question asked.
export function describeContribution(summary) {
  if (!summary) return ["The stored result could not be read, so what it contributed is not recorded."];
  if (summary.permissions) { const P = summary.permissions; return [`Read ${plural(P.checked, "approval")} again: ${P.agree} matched the public Celo node${P.differ ? `, ${P.differ} did not match` : ""}${P.noAnswer ? `, ${P.noAnswer} got no answer` : ""}.`]; }
  const out = [];
  const t = summary.trace;
  if (t?.failing?.reason) out.push(`Found the reason it failed: "${t.failing.reason}".`);
  else if (t?.failing) out.push(`Found where it stopped (${short(t.failing.to)}), but that contract gave no readable message.`);
  else if (t && t.calls) out.push(`Showed the ${plural(t.calls, "step")} inside the transaction, with no errors.`);
  if (summary.receiptSucceeded === true || summary.receiptSucceeded === false) out.push(`The Deep Investigation's receipt says the transaction ${summary.receiptSucceeded ? "succeeded" : "failed"}.`);
  else if (summary.receiptMissing) out.push("The provider has no receipt for it yet.");
  const ex = summary.extras || {};
  if (ex.balance) out.push(`Read the sender's token balance one block earlier: ${ex.balance.enough ? "it covered the amount" : "it was lower than the amount requested"}.`);
  if (ex.allowance) out.push(`Read the spending allowance: ${ex.allowance.enough ? "it covered the amount" : "it was lower than the amount requested"}.`);
  if (ex.nonce) out.push(Number(ex.nonce.earlierUnconfirmed) > 0 ? `Showed ${plural(Number(ex.nonce.earlierUnconfirmed), "earlier transaction")} from the wallet not confirmed yet.` : "Showed no earlier unconfirmed transactions from the wallet.");
  if (ex.gas) out.push(`Showed the fee offered is ${ex.gas.belowNetwork ? "below" : "at or above"} the network's current minimum.`);
  if (ex.logs) out.push(`Compared the receipt's token transfer records with the explorer's: ${ex.logs.agree ? "they match" : "they do not match"}.`);
  return out.length ? out : ["Nothing new beyond what the basic investigation already showed."];
}

// Who used ChainLens, from the activity log. A visitor is one browser (its anonymous id).
// The wallets are the addresses they pasted in, or the sender of a transaction hash they pasted.
// ChainLens never connects to a wallet, so it cannot prove a wallet belongs to the visitor.
const ORDER_TYPES = new Set(["paid", "reused", "unavailable"]);
export function summarizeUsers(events = [], opts = {}) {
  const ignore = new Set((opts.ignore ?? (process.env.CHAINLENS_IGNORE_SIDS || "")).split(",").map((x) => x.trim()).filter(Boolean));
  const evs = events.filter((e) => e.sid && !ignore.has(e.sid)).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const byHash = new Map();
  for (const e of evs) if (e.hash && e.address) byHash.set(e.hash, e.address);
  const people = new Map();
  for (const e of evs) {
    const p = people.get(e.sid) || { id: e.sid, firstSeen: e.at, lastSeen: e.at, days: new Set(), lookups: 0, orders: 0, paid: 0, reused: 0, notDone: 0, wallets: new Set() };
    p.lastSeen = e.at; p.days.add(String(e.at).slice(0, 10));
    const addr = (e.address || (e.hash && byHash.get(e.hash)) || "").toLowerCase();
    if (addr) p.wallets.add(addr);
    if (ORDER_TYPES.has(e.type)) { p.orders++; if (e.type === "paid") p.paid++; else if (e.type === "reused") p.reused++; else p.notDone++; }
    else p.lookups++;
    people.set(e.sid, p);
  }
  const list = [...people.values()].map((p) => ({ id: p.id, firstSeen: p.firstSeen, lastSeen: p.lastSeen, days: p.days.size, lookups: p.lookups, orders: p.orders, paid: p.paid, reused: p.reused, notDone: p.notDone, wallets: [...p.wallets] }))
    .sort((a, b) => b.orders - a.orders || String(b.lastSeen).localeCompare(String(a.lastSeen)));
  const all = new Set(list.flatMap((p) => p.wallets));
  return {
    totals: {
      visitors: list.length,
      returning: list.filter((p) => p.days > 1).length,
      orders: list.reduce((n, p) => n + p.orders, 0),
      paid: list.reduce((n, p) => n + p.paid, 0),
      reused: list.reduce((n, p) => n + p.reused, 0),
      notDone: list.reduce((n, p) => n + p.notDone, 0),
      wallets: all.size,
    },
    people: list.slice(0, 100),
  };
}

export function summarizePayments(rows, events = []) {
  const AGENT0 = (process.env.CHAINLENS_AGENT_ADDRESS || "0x398f4AbF39c59DDb3022BE755DC0f5A4C57b118e").toLowerCase();
  const ignoreT = new Set([AGENT0, ...(process.env.CHAINLENS_IGNORE_ORDERERS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean)]);
  const calls = rows.filter((r) => r.kind === "paid-call" && PAID.has(r.status));
  const list = calls.map((r) => ({
    at: r.at, builderTest: ignoreT.has(r.orderer), tx: r.tx || null, address: r.address || null, orderer: r.orderer || null, amount: r.amount || null, currency: r.currency || null, provider: r.provider || null, route: r.route || null,
    status: r.status, paymentTxHash: r.paymentTxHash || null, purpose: r.purpose || null, sessionId: r.sessionId || null,
    investigationId: r.investigationId || null, resultDigest: r.resultDigest || null, checks: (r.requested || []).map((x) => x.method),
    bought: describeBought(r.requested), contributed: describeContribution(r.summary), returned: r.perCall ? `${r.perCall.filter((c) => c.ok).length} of ${r.perCall.length} checks returned data` : null,
  })).reverse();
  const spent = calls.reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const AGENT = (process.env.CHAINLENS_AGENT_ADDRESS || "0x398f4AbF39c59DDb3022BE755DC0f5A4C57b118e").toLowerCase();
  const ignoreO = new Set([AGENT, ...(process.env.CHAINLENS_IGNORE_ORDERERS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean)]);
  const ignoreS = new Set((process.env.CHAINLENS_IGNORE_SIDS || "").split(",").map((x) => x.trim()).filter(Boolean));
  const users = new Set(calls.filter((r) => !ignoreO.has(r.orderer) && !ignoreS.has(r.sessionId)).map((r) => r.orderer || r.sessionId).filter(Boolean));
  return {
    totals: {
      paidCalls: calls.length,
      ordered: calls.length,
      builderTests: list.filter((x) => x.builderTest).length,
      fromOthers: list.filter((x) => !x.builderTest).length,
      usersWhoOrdered: users.size,
      totalPaid: Math.round(spent * 1e6) / 1e6,
      spentAtMost: Math.round(spent * 1e6) / 1e6,
      currency: calls[0]?.currency || "USDT",
      transactionsInvestigated: new Set(calls.map((r) => r.tx).filter(Boolean)).size,
      walletsChecked: new Set(calls.map((r) => r.address).filter(Boolean)).size,
      usersSeen: users.size,
      reusedWithoutCharge: events.filter((e) => e.type === "reused").length,
    },
    services: [...new Set(calls.map((r) => r.provider).filter(Boolean))],
    calls: list.slice(0, 100),
  };
}
