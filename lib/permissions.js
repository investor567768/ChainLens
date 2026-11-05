// Permission Check: which contracts can spend this wallet's tokens, in plain language.
// Read-only. We never ask for a wallet connection and we cannot cancel anything.
//   1. Discover: every approval this wallet ever gave. From SQD (reads all approval events) when it answers,
//      otherwise from the public Celo explorer (only approvals the wallet sent itself).
//   2. Read: the CURRENT allowance of each pair from a public Celo node. History alone can be out of date.
//   3. Identify: token name and what the explorer knows about the spender. If it knows nothing, we say so.
// The optional paid double-check lives in paid.js and only ever runs when a person presses a button.
import { ADDR_RE, fromUnits, short, plural } from "./format.js";
import { KNOWN_TOKENS } from "./holdings.js";

export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const APPROVE_SEL = "0x095ea7b3";
export const ALLOWANCE_SEL = "0xdd62ed3e";
export const allowanceCall = (token, owner, spender) => ({ to: token, data: ALLOWANCE_SEL + word(owner) + word(spender) });

const EXPLORER = () => process.env.BLOCKSCOUT_BASE || "https://celo.blockscout.com/api/v2";
const NODE = () => process.env.CELO_RPC || "https://forno.celo.org";
const SQD = () => process.env.SQD_BASE || "https://gateway.usebuy.ai/sqd/datasets/celo-mainnet";
const UNLIMITED = 2n ** 200n;
const MAX_PAIRS = 40, MAX_PAGES = 5, MAX_STREAM_ROUNDS = 40;
const lc = (s) => String(s || "").toLowerCase();
const word = (a) => lc(a).replace(/^0x/, "").padStart(64, "0");

async function request(f, url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await f(url, { ...opts, signal: ctrl.signal }); } catch { return null; } finally { clearTimeout(t); }
}
async function getJson(f, url) {
  const r = await request(f, url, { headers: { accept: "application/json" } }, 10000);
  if (!r || !r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// ---- SQD: one JSON object per line, one line per block that has a match.
export function parseSqdLines(text, owner) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let b; try { b = JSON.parse(line); } catch { continue; }
    const ts = Number(b?.header?.timestamp);
    const at = Number.isFinite(ts) ? new Date((ts > 1e12 ? ts : ts * 1000)).toISOString() : null;
    for (const l of Array.isArray(b?.logs) ? b.logs : []) {
      const t = l.topics || [];
      if (t.length !== 3 || lc(t[0]) !== APPROVAL_TOPIC || ("0x" + lc(t[1]).slice(26)) !== lc(owner)) continue;   // 4 topics = an NFT approval, not ours
      let amount; try { amount = BigInt(l.data && l.data !== "0x" ? l.data : "0x0").toString(); } catch { continue; }
      out.push({ token: l.address, spender: "0x" + lc(t[2]).slice(26), amountRaw: amount, at, block: Number(b?.header?.number) || null, tx: l.transactionHash || null });
    }
  }
  return out;
}

async function discoverSqd(owner, f) {
  const head = await getJson(f, SQD() + "/head");
  const last = Number(head?.number);
  if (!Number.isFinite(last)) return null;
  let from = 0, text = "";
  for (let i = 0; i < MAX_STREAM_ROUNDS; i++) {
    const body = { type: "evm", fromBlock: from, toBlock: last, fields: { block: { number: true, timestamp: true }, log: { address: true, topics: true, data: true, transactionHash: true } }, logs: [{ topic0: [APPROVAL_TOPIC], topic1: ["0x" + word(owner)] }] };
    const r = await request(f, SQD() + "/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 25000);
    if (!r || !(r.ok || r.status === 204)) return null;
    if (r.status === 204) return { events: parseSqdLines(text, owner), complete: true };
    const chunk = await r.text();
    text += "\n" + chunk;
    let max = -1;
    for (const line of chunk.split("\n")) { try { const n = Number(JSON.parse(line)?.header?.number); if (n > max) max = n; } catch { /* skip */ } }
    if (max < 0) break;
    from = max + 1;
    if (from > last) return { events: parseSqdLines(text, owner), complete: true };
  }
  return { events: parseSqdLines(text, owner), complete: false };
}

// ---- Explorer fallback: approve() calls this wallet sent itself.
export function parseExplorerTxs(items, owner) {
  const out = [];
  for (const tx of Array.isArray(items) ? items : []) {
    const input = String(tx.raw_input || tx.input || "");
    const from = tx.from?.hash || tx.from;
    const token = tx.to?.hash || tx.to;
    if (lc(from) !== lc(owner) || !token || lc(input.slice(0, 10)) !== APPROVE_SEL) continue;
    if (!(tx.status === "ok" || tx.result === "success")) continue;
    const w = input.slice(10).match(/.{64}/g) || [];
    if (w.length < 2) continue;
    try { out.push({ token, spender: "0x" + w[0].slice(24).toLowerCase(), amountRaw: BigInt("0x" + w[1]).toString(), at: tx.timestamp || null, tx: tx.hash || null }); } catch { /* skip */ }
  }
  return out;
}

async function discoverExplorer(owner, f) {
  const events = []; let params = "", complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await getJson(f, `${EXPLORER()}/addresses/${owner}/transactions?filter=from${params}`);
    if (!d) return page === 0 ? null : { events, complete: false };
    events.push(...parseExplorerTxs(d.items, owner));
    if (!d.next_page_params) { complete = true; break; }
    params = "&" + Object.entries(d.next_page_params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  }
  return { events, complete };
}

// The newest approval for each (token, spender) pair wins.
export function latestPairs(events) {
  const m = new Map();
  for (const e of events) {
    const k = lc(e.token) + "|" + lc(e.spender);
    const old = m.get(k);
    if (!old || String(e.at || "") >= String(old.at || "")) m.set(k, e);
  }
  return [...m.values()];
}

async function readAllowances(owner, pairs, f) {
  const calls = pairs.map((p, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [allowanceCall(p.token, owner, p.spender), "latest"] }));
  const val = (r) => (r && !r.error && typeof r.result === "string" && /^0x[0-9a-fA-F]*$/.test(r.result) && r.result !== "0x" ? BigInt(r.result).toString() : null);
  const post = async (body) => { const r = await request(f, NODE(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 12000); if (!r || !r.ok) return null; try { return await r.json(); } catch { return null; } };
  if (!calls.length) return [];
  const batch = await post(calls);
  if (Array.isArray(batch)) { const by = Object.fromEntries(batch.map((r) => [String(r.id), r])); return calls.map((c) => val(by[String(c.id)])); }
  return Promise.all(calls.map(async (c) => val(await post(c))));
}

async function tokenInfo(token, f) {
  const k = KNOWN_TOKENS.find((x) => lc(x.address) === lc(token));
  if (k) return { symbol: k.symbol, decimals: k.decimals };
  const d = await getJson(f, `${EXPLORER()}/tokens/${token}`);
  const dec = Number(d?.decimals);
  return { symbol: d?.symbol ? String(d.symbol).slice(0, 24) : null, decimals: Number.isFinite(dec) ? dec : null };
}
async function spenderInfo(addr, f) {
  const d = await getJson(f, `${EXPLORER()}/addresses/${addr}`);
  if (!d) return { lookup: false, name: null, verified: false, isContract: null };
  return { lookup: true, name: d.name ? String(d.name).slice(0, 60) : null, verified: !!d.is_verified, isContract: d.is_contract == null ? null : !!d.is_contract };
}

export function levelOf({ unlimited, verified }) {
  if (unlimited && !verified) return "review-first";
  if (unlimited) return "review";
  return "limited";
}

export function describe({ spender, spenderLookup, unlimited, amountText, symbol, name, verified, isContract }) {
  const sym = symbol || "tokens";
  const who = name ? `${name} (${short(spender)})` : short(spender);
  const amount = unlimited ? `any amount of your ${sym}` : amountText ? `up to ${amountText} of your ${sym}` : `a limited amount of your ${sym}`;
  const tail = !spenderLookup ? "The explorer could not tell us anything about it." : isContract === false ? "It is a regular wallet, not a contract." : verified ? "Its code is verified." : "Its code is not verified.";
  return `${who} can spend ${amount}. ${tail}`;
}

const LIMITS = [
  "Permissions given by signature (permits) or through some other contracts cannot be seen from a wallet's history.",
  "ChainLens is read-only. It cannot cancel anything. To cancel an approval, use your wallet or a revoke tool you trust, such as revoke.cash.",
];
const rank = { "review-first": 0, review: 1, limited: 2 };

export async function checkPermissions(address, deps = {}) {
  if (!ADDR_RE.test(address || "")) return { ok: false, error: "That does not look like a wallet address." };
  const f = deps.fetch || fetch;
  const notes = [];
  let source = "sqd", found = await discoverSqd(address, f);
  if (!found) {
    source = "explorer"; found = await discoverExplorer(address, f);
    if (found) notes.push("The wallet's full approval history could not be read, so this list covers approvals sent directly from this wallet. Ones given another way may be missing.");
  }
  if (!found) return { ok: false, error: "Could not read this wallet's approval history right now. Try again in a minute." };
  if (!found.complete) notes.push("The history was too long to read in full, so the oldest approvals may be missing.");

  const all = latestPairs(found.events);
  const pairs = all.slice(0, MAX_PAIRS);
  if (all.length > pairs.length) notes.push(`Only the ${MAX_PAIRS} most recent of ${all.length} approvals were checked.`);
  const now = await readAllowances(address, pairs, f);
  const unread = now.filter((x) => x == null).length;
  if (unread) notes.push(`${plural(unread, "approval")} could not be read from the Celo node, so ${unread === 1 ? "it is" : "they are"} not listed.`);
  const live = pairs.map((p, i) => ({ ...p, allowanceRaw: now[i] })).filter((p) => p.allowanceRaw != null && BigInt(p.allowanceRaw) > 0n);
  const cancelledCount = pairs.filter((p, i) => now[i] != null && BigInt(now[i]) === 0n).length;

  const tokens = new Map(), spenders = new Map();
  await Promise.all([
    ...[...new Set(live.map((p) => lc(p.token)))].map(async (t) => tokens.set(t, await tokenInfo(live.find((p) => lc(p.token) === t).token, f))),
    ...[...new Set(live.map((p) => lc(p.spender)))].map(async (s) => spenders.set(s, await spenderInfo(s, f))),
  ]);
  const permissions = live.map((p) => {
    const t = tokens.get(lc(p.token)), s = spenders.get(lc(p.spender));
    const unlimited = BigInt(p.allowanceRaw) >= UNLIMITED;
    const amountText = !unlimited && t.decimals != null ? fromUnits(p.allowanceRaw, t.decimals, 6) : null;
    const base = { spender: p.spender, spenderLookup: s.lookup, unlimited, amountText, symbol: t.symbol, name: s.name, verified: s.verified, isContract: s.isContract };
    return { token: p.token, spender: p.spender, symbol: t.symbol, allowanceRaw: p.allowanceRaw, unlimited, level: levelOf(base), text: describe(base), grantedAt: p.at || null, grantTx: p.tx || null, decimals: t.decimals ?? null };
  }).sort((a, b) => rank[a.level] - rank[b.level] || String(b.grantedAt).localeCompare(String(a.grantedAt)));

  return { ok: true, address, source, permissions, cancelledCount, empty: permissions.length === 0, notes, limits: LIMITS, checkedAt: new Date().toISOString() };
}
