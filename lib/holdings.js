// What a wallet holds right now. Two independent free sources are compared:
//   1. the public Celo explorer (Blockscout)
//   2. a public Celo node (JSON-RPC), which reads the chain's own state
// If they agree, the number is "confirmed by the chain". If they differ, we say so.
// If only one answered, we say which one. Dollar values are never shown.
import { ADDR_RE, fromUnits } from "./format.js";

const EXPLORER = () => process.env.BLOCKSCOUT_BASE || "https://celo.blockscout.com/api/v2";
const NODE = () => process.env.CELO_RPC || "https://forno.celo.org";

// Well-known Celo tokens we check against the chain. Anything else is listed as "unverified":
// anyone can create a token with any name, so a name alone proves nothing.
export const KNOWN_TOKENS = [
  { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", symbol: "USDT", decimals: 6 },
  { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", symbol: "USDC", decimals: 6 },
  { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", symbol: "cUSD", decimals: 18 },
  { address: "0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73", symbol: "cEUR", decimals: 18 },
  { address: "0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787", symbol: "cREAL", decimals: 18 },
];
const lc = (s) => String(s || "").toLowerCase();
const CELO_TOKEN = "0x471ece3750da237f93b8e339c536989b8978a438";

async function getJson(url, f, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false };
    return { ok: true, data: await res.json() };
  } catch { return { ok: false }; } finally { clearTimeout(t); }
}

async function rpc(method, params, f, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(NODE(), { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || j.error || typeof j.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(j.result)) return null;
    return j.result === "0x" ? "0" : BigInt(j.result).toString();
  } catch { return null; } finally { clearTimeout(t); }
}

const balanceOfData = (addr) => "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0");

function compare(explorerVal, chainVal) {
  if (explorerVal != null && chainVal != null) return explorerVal === chainVal ? "confirmed" : "differs";
  if (chainVal != null) return "chain-only";
  if (explorerVal != null) return "explorer-only";
  return "none";
}

export async function getHoldings(address, deps = {}) {
  if (!ADDR_RE.test(address || "")) return { ok: false, error: "That does not look like a wallet address." };
  const f = deps.fetch || fetch;

  const [acct, toks, nativeChain, ...chainTokens] = await Promise.all([
    getJson(`${EXPLORER()}/addresses/${address}`, f),
    getJson(`${EXPLORER()}/addresses/${address}/token-balances`, f),
    rpc("eth_getBalance", [address, "latest"], f),
    ...KNOWN_TOKENS.map((k) => rpc("eth_call", [{ to: k.address, data: balanceOfData(address) }, "latest"], f)),
  ]);

  const explorerOk = acct.ok || toks.ok;
  const chainOk = nativeChain != null || chainTokens.some((x) => x != null);
  if (!explorerOk && !chainOk) return { ok: false, error: "Could not read balances from the explorer or from a Celo node right now." };

  const explorerNative = acct.ok ? (acct.data?.coin_balance ?? "0") : null;
  const native = { symbol: "CELO", amount: fromUnits(nativeChain ?? explorerNative, 18, 6), check: compare(explorerNative, nativeChain) };
  if (native.check === "differs") { native.explorerAmount = fromUnits(explorerNative, 18, 6); native.chainAmount = fromUnits(nativeChain, 18, 6); }

  // The explorer may send the list bare, or wrapped as { items: [...] }. Accept both.
  const listed = toks.ok ? (Array.isArray(toks.data) ? toks.data : Array.isArray(toks.data?.items) ? toks.data.items : null) : null;
  const rows = listed || [];
  const byAddr = new Map(rows.map((r) => [lc(r?.token?.address || r?.token?.address_hash), r]));

  const tokens = [];
  KNOWN_TOKENS.forEach((k, i) => {
    const hit = byAddr.get(lc(k.address));
    const dec = hit ? Number(hit.token?.decimals ?? k.decimals) : k.decimals;
    // A token the explorer does not list is "not checked", never "zero".
    const explorerVal = listed && hit ? String(hit.value ?? "0") : null;
    const chainVal = chainTokens[i];
    const raw = chainVal ?? explorerVal;
    if (raw == null || raw === "0") return;
    const check = compare(explorerVal, chainVal);
    tokens.push({ symbol: hit?.token?.symbol || k.symbol, amount: fromUnits(raw, dec, 6), check, address: k.address, ...(listed && !hit && chainVal != null ? { explorerNotListed: true } : {}), ...(check === "differs" ? { explorerAmount: fromUnits(explorerVal, dec, 6), chainAmount: fromUnits(chainVal, dec, 6), explorerRaw: explorerVal, chainRaw: chainVal, explorerHadToken: !!hit } : {}) });
  });

  const knownSet = new Set(KNOWN_TOKENS.map((k) => lc(k.address)));
  // CELO also exists as a token contract. It is the same money as the native balance shown above, so it is not listed again.
  knownSet.add(CELO_TOKEN);
  const other = rows
    .filter((r) => (r?.token?.type || "ERC-20") === "ERC-20" && !knownSet.has(lc(r?.token?.address || r?.token?.address_hash)) && r.value && r.value !== "0")
    .map((r) => ({ symbol: String(r.token?.symbol || "unnamed").slice(0, 24), name: String(r.token?.name || "").slice(0, 40), amount: fromUnits(r.value, Number(r.token?.decimals ?? 18), 6) }))
    .filter((r) => r.amount)
    .slice(0, 10);

  const notes = [];
  if (!explorerOk) notes.push("The public explorer did not answer, so these numbers come from a Celo node only.");
  if (!chainOk) notes.push("A Celo node did not answer, so these numbers come from the explorer only and are not cross-checked.");
  const empty = (native.amount === null || native.amount === "0") && !tokens.length && !other.length;
  return { ok: true, address, native, tokens, other, empty, notes, sources: { explorer: explorerOk, chain: chainOk }, checkedAt: new Date().toISOString() };
}
