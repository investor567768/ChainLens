// Free data source: a public Blockscout explorer for Celo.
// NOTE: base URL can be changed with BLOCKSCOUT_BASE without touching code.

const BASE = process.env.BLOCKSCOUT_BASE || "https://celo.blockscout.com/api/v2";

async function getJson(path, { timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return { ok: false, notFound: true, status: 404 };
    if (!res.ok) return { ok: false, status: res.status, error: `explorer returned HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    const why = err && err.name === "AbortError" ? "explorer timed out" : "could not reach explorer";
    return { ok: false, error: why };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTransaction(hash) {
  const [tx, tr] = await Promise.all([
    getJson(`/transactions/${hash}`),
    getJson(`/transactions/${hash}/token-transfers`),
  ]);
  if (!tx.ok) return tx;
  if (!tx.data?.celo?.gas_token && !tx.data?.gas_token && !tx.data?.fee_currency) {
    const sym = await nodeFeeCurrency(hash);
    if (sym) tx.data = { ...tx.data, fee_currency: { symbol: sym } };
  }
  return { ok: true, tx: tx.data, transfers: tr.ok ? tr.data : null, transfersError: tr.ok ? null : (tr.error || "no token transfer data") };
}

export async function fetchAddressTransactions(address) {
  return getJson(`/addresses/${address}/transactions`);
}

export async function fetchAddressTokenTransfers(address) {
  return getJson(`/addresses/${address}/token-transfers`);
}

// Pending transactions for an address. The caller never trusts the filter alone:
// each item's own status decides whether it is shown as pending.
export async function fetchAddressPending(address) {
  return getJson(`/addresses/${address}/transactions?filter=pending`);
}

// Fee currency from the public Celo node (feeCurrency field). Returns a symbol, "CELO" when the
// field is empty, or null when the node cannot say. Never guessed.
const FEE_TOKENS = {
  "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e": "USD\u20AE", "0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72": "USD\u20AE",
  "0xceba9300f2b948710d2653dd7b07f33a8b32118c": "USDC", "0x2f25deb3848c207fc8e0c34035b3ba7fc157602b": "USDC",
  "0x765de816845861e75a25fca122bb6898b8b1282a": "cUSD", "0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73": "cEUR", "0xe8537a3d056da446677b9e9d6c5db704eaab4787": "cREAL",
};
export async function nodeFeeCurrency(hash) {
  try {
    const r = await fetch(process.env.CELO_RPC || "https://forno.celo.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }), signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (!j.result) return null;
    const a = j.result.feeCurrency;
    if (!a) return "CELO";
    return FEE_TOKENS[String(a).toLowerCase()] || null;
  } catch { return null; }
}
