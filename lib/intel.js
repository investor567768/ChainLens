// Wallet intelligence: what stands out in a wallet's recent activity.
// Every line is COUNTED from the data we fetched, and says how much data that was.
// It never says why something happened, never blames anyone, and never claims "ever".
import { short, plural } from "./format.js";
import { niceTime, isSystemAddr } from "./classify.js";

const DAY = 24 * 60 * 60 * 1000;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const ms = (x) => { const t = Date.parse(x || ""); return Number.isFinite(t) ? t : null; };
const APPROVAL = new Set(["approve", "increaseAllowance", "setApprovalForAll"]);

function paramOf(tx, names) {
  const ps = tx.decoded_input?.parameters;
  if (!Array.isArray(ps)) return null;
  for (const n of names) { const p = ps.find((x) => x?.name === n); if (p) return p.value; }
  return null;
}
const methodOf = (tx) => (tx.method || tx.decoded_input?.method_call?.split("(")[0] || "").trim();
const failed = (tx) => tx.status === "error" || tx.result === "error";

export function analyzeWallet(address, txItems = [], ttItems = [], now = Date.now()) {
  const mine = (txItems || []).filter((t) => t && t.hash && same(t.from?.hash, address));
  const signals = [];

  // Events (one per transaction hash) with the other side of each, newest first.
  const ev = new Map();
  for (const t of mine) {
    const other = t.to?.hash;
    if (other && !same(other, address) && !isSystemAddr(other)) ev.set(t.hash, { hash: t.hash, ts: ms(t.timestamp), other, kind: t.to?.is_contract ? "smart contract" : "address" });
  }
  for (const t of ttItems || []) {
    const h = t.transaction_hash || t.tx_hash;
    if (!h || ev.has(h)) continue;
    const f = t.from?.hash, to = t.to?.hash;
    const other = same(f, address) ? to : same(to, address) ? f : null;
    if (other && !isSystemAddr(other)) ev.set(h, { hash: h, ts: ms(t.timestamp), other, kind: "address" });
  }
  const events = [...ev.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const window = { transactions: (txItems || []).length, tokenTransfers: (ttItems || []).length, events: events.length };

  // 1. Repeated failures at the same contract in the last 24 hours.
  const groups = new Map();
  for (const t of mine) {
    const at = ms(t.timestamp), to = t.to?.hash;
    if (!failed(t) || !to || at === null || now - at > DAY || at > now + 60_000) continue;
    const k = to.toLowerCase();
    groups.set(k, [...(groups.get(k) || []), t]);
  }
  for (const [, list] of groups) {
    if (list.length < 3) continue;
    list.sort((a, b) => ms(b.timestamp) - ms(a.timestamp));
    const to = list[0].to.hash;
    signals.push({
      key: "repeated-failures",
      text: `${plural(list.length, "failed transaction")} to the same ${list[0].to.is_contract ? "smart contract" : "address"} (${short(to)}) in the last 24 hours.`,
      technical: [`Address: ${to}`, ...list.slice(0, 5).map((t) => `Transaction: ${t.hash}`)],
      suggest: { hash: list[0].hash, purpose: "failed", label: "Run a Deep Investigation on the latest one" },
    });
  }

  // 2. New contact: in the latest events, an address that does not appear earlier in the data we checked.
  if (events.length >= 8) {
    const recent = events.slice(0, 3), older = events.slice(3);
    const seen = new Set(older.map((e) => e.other.toLowerCase()));
    const fresh = [];
    for (const e of recent) if (!seen.has(e.other.toLowerCase()) && !fresh.some((x) => same(x.other, e.other))) fresh.push(e);
    for (const e of fresh.slice(0, 3)) {
      signals.push({
        key: "new-contact",
        text: `The latest activity involves ${short(e.other)} (${/^[aeiou]/i.test(e.kind) ? "an" : "a"} ${e.kind}), which is not in the earlier ${events.length} events we checked.`,
        technical: [`Address: ${e.other}`, `Transaction: ${e.hash}`],
        suggest: { hash: e.hash, purpose: "", label: "Explain this transaction" },
      });
    }
  }

  // 3. Approvals: the wallet gave a contract permission to move its tokens.
  const approvals = mine.filter((t) => APPROVAL.has(methodOf(t))).slice(0, 5);
  for (const t of approvals) {
    const m = methodOf(t);
    const spender = paramOf(t, ["spender", "operator", "_spender"]);
    if (!spender) continue;
    let unlimited = false, raw = null;
    if (m === "setApprovalForAll") {
      if (String(paramOf(t, ["approved", "_approved"])).toLowerCase() !== "true") continue;
    } else {
      raw = paramOf(t, ["value", "amount", "_value", "addedValue", "subtractedValue"]);
      try { unlimited = raw != null && BigInt(raw) >= 2n ** 255n; } catch { unlimited = false; }
    }
    const token = t.to?.name || `a token (${short(t.to?.hash)})`;
    const what = m === "setApprovalForAll" ? `to manage all of its ${token} tokens of that kind` : unlimited ? `to spend an unlimited amount of ${token}` : `to spend some of its ${token}`;
    const did = failed(t) ? `tried to allow ${short(spender)} ${what} (an approval), but the transaction failed, so it did not take effect` : `allowed ${short(spender)} ${what} (an approval)`;
    signals.push({
      key: unlimited ? "approval-unlimited" : "approval",
      text: `This wallet ${did}. ${niceTime(t.timestamp) || ""}`.trim(),
      technical: [`Call: ${m}`, `Token contract: ${t.to?.hash || "unknown"}`, `Approved address: ${spender}`, ...(raw ? [`Raw amount: ${raw}`] : []), `Transaction: ${t.hash}`],
      suggest: { hash: t.hash, purpose: "movements", label: "Run a Deep Investigation on this approval" },
    });
  }

  const statement = events.length === 0 && !mine.length
    ? "There was not enough recent activity to check."
    : signals.length ? null : `Checked the last ${plural(events.length, "event")} for repeated failures, new contacts and approvals. None was found. This does not mean the wallet is safe.`;
  return { window, signals, statement, checks: ["repeated failures in 24 hours", "new contacts", "approvals"] };
}
