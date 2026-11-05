// Plain-language recent activity for a public wallet. Read-only, free data only.
// Activity is built from transactions AND token transfers, so wallets that never send a
// transaction themselves (for example, ones whose payments are sent by a gateway) still show activity.
import { ADDR_RE, fromUnits, short } from "./format.js";
import { fetchAddressTransactions, fetchAddressTokenTransfers, fetchAddressPending } from "./blockscout.js";
import { normalizeTx, niceTime, isSystemAddr } from "./classify.js";
import { analyzeWallet } from "./intel.js";

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

export function describeTx(item, me, transfers = []) {
  const f = normalizeTx(item, null);
  const pending = f.block === null && f.status !== "ok" && f.status !== "error";
  const status = pending ? "pending" : f.status === "error" ? "failed" : "success";
  const direction = same(f.from, me) ? (same(f.to, me) ? "self" : "out") : same(f.to, me) ? "in" : "other";

  const mine = transfers.filter((t) => !isSystemAddr(t.from) && !isSystemAddr(t.to) && (same(t.from, me) || same(t.to, me)));
  let summary;
  if (mine.length) {
    const t = mine[0];
    const amt = fromUnits(t.value, t.decimals) ?? "an amount";
    summary = same(t.from, me) ? `Sent ${amt} ${t.symbol} to ${short(t.to)}` : `Received ${amt} ${t.symbol} from ${short(t.from)}`;
    if (mine.length > 1) summary += ` (+${mine.length - 1} more transfer${mine.length > 2 ? "s" : ""})`;
  } else {
    const v = fromUnits(f.valueWei);
    if (v && v !== "0") summary = direction === "in" ? `Received ${v} CELO from ${short(f.from)}` : `Sent ${v} CELO to ${short(f.to)}`;
    else if (f.toIsContract) summary = "Interacted with a smart contract";
    else if (f.createdContract) summary = "Created a new smart contract";
    else summary = `Interacted with ${short(f.to || f.from)}`;
  }
  if (status === "failed") summary = "Failed: " + summary;
  if (status === "pending") summary = "Pending: " + summary;
  return { hash: f.hash, when: niceTime(f.timestamp), timestamp: f.timestamp, status, direction, summary };
}

// A token transfer that has no matching transaction in the wallet's own list.
export function describeTransferOnly(hash, rows, me) {
  const mine = rows.filter((t) => !isSystemAddr(t.from) && !isSystemAddr(t.to) && (same(t.from, me) || same(t.to, me)));
  let summary;
  if (mine.length) {
    const t = mine[0];
    const amt = fromUnits(t.value, t.decimals) ?? "an amount";
    summary = same(t.from, me) ? `Sent ${amt} ${t.symbol} to ${short(t.to)}` : `Received ${amt} ${t.symbol} from ${short(t.from)}`;
    if (mine.length > 1) summary += ` (+${mine.length - 1} more transfer${mine.length > 2 ? "s" : ""})`;
  } else {
    summary = "An additional token movement was recorded, but its purpose could not be established.";
  }
  return { hash, when: niceTime(rows[0]?.timestamp), timestamp: rows[0]?.timestamp || null, status: "recorded", direction: mine.length ? (same(mine[0].from, me) ? "out" : "in") : "other", summary };
}

const time = (x) => { const t = Date.parse(x || ""); return Number.isFinite(t) ? t : null; };

export async function summarizeWallet(address, deps = {}) {
  if (!ADDR_RE.test(address || "")) return { ok: false, error: "That does not look like a wallet address. It should start with 0x and be 42 characters long." };
  const getTx = deps.fetchAddressTransactions || fetchAddressTransactions;
  const getTt = deps.fetchAddressTokenTransfers || fetchAddressTokenTransfers;
  const getPend = deps.fetchAddressPending || fetchAddressPending;
  const [txs, tts, pend] = await Promise.all([getTx(address), getTt(address), getPend(address).catch(() => ({ ok: false }))]);

  const txOk = !!txs.ok, ttOk = !!tts.ok;
  const txKnown = txOk || !!txs.notFound, ttKnown = ttOk || !!tts.notFound;
  if (!txKnown && !ttKnown) return { ok: false, error: `Could not get activity right now (${txs.error || tts.error || "unknown error"}).` };

  const byHash = new Map();
  for (const t of (ttOk ? tts.data?.items : null) || []) {
    const h = t.transaction_hash || t.tx_hash;
    if (!h) continue;
    const row = { from: t.from?.hash || null, to: t.to?.hash || null, symbol: t.token?.symbol || "tokens", decimals: Number(t.total?.decimals ?? t.token?.decimals ?? 18), value: t.total?.value ?? null, timestamp: t.timestamp || null };
    byHash.set(h, [...(byHash.get(h) || []), row]);
  }
  const txByHash = new Map();
  for (const it of (txOk ? txs.data?.items : null) || []) if (it?.hash) txByHash.set(it.hash, it);
  for (const it of (pend?.ok ? pend.data?.items : null) || []) if (it?.hash && !txByHash.has(it.hash)) txByHash.set(it.hash, it);

  const items = [];
  for (const [h, it] of txByHash) items.push(describeTx(it, address, byHash.get(h) || []));
  for (const [h, rows] of byHash) if (!txByHash.has(h)) items.push(describeTransferOnly(h, rows, address));
  // Pending first, then newest first.
  items.sort((a, b) => (a.status === "pending") !== (b.status === "pending") ? (a.status === "pending" ? -1 : 1) : (time(b.timestamp) ?? 0) - (time(a.timestamp) ?? 0));
  const shown = items.slice(0, 15);

  const notes = [];
  if (!txKnown) notes.push("Transactions could not be loaded, so only token transfers are shown. Some activity may be missing.");
  if (!ttKnown) notes.push("Token transfers could not be loaded, so some entries are simpler or missing.");
  const complete = txKnown && ttKnown;
  const state = shown.length ? "activity" : complete ? "none" : "incomplete";
  const intel = analyzeWallet(address, txOk ? txs.data?.items || [] : [], ttOk ? tts.data?.items || [] : []);
  if (!complete) intel.partial = "Some activity could not be loaded, so these checks may have missed something.";
  return { ok: true, address, state, items: shown, intel, notes, note: notes[0] || null, checkedAt: new Date().toISOString(), source: "the Celo explorer (Blockscout)" };
}
