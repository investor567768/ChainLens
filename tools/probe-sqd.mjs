// Shows exactly how SQD answers an approval-history request. Read-only. Free. Pays nothing.
// Usage: node tools/probe-sqd.mjs 0xYourWalletAddress
const owner = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(owner || "")) { console.log("Give a wallet address: node tools/probe-sqd.mjs 0x..."); process.exit(1); }
const BASE = process.env.SQD_BASE || "https://gateway.usebuy.ai/sqd/datasets/celo-mainnet";
const TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const pad = "0x" + owner.slice(2).toLowerCase().padStart(64, "0");
const head = await (await fetch(BASE + "/head")).json();
console.log("Head block:", head.number);
async function tryRange(label, from, to) {
  const body = { type: "evm", fromBlock: from, toBlock: to, fields: { block: { number: true, timestamp: true }, log: { address: true, topics: true, data: true, transactionHash: true } }, logs: [{ topic0: [TOPIC], topic1: [pad] }] };
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + "/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const txt = await r.text();
    console.log(`\n[${label}] blocks ${from}..${to} -> HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${txt.length} bytes`);
    console.log(txt.slice(0, 400) || "(empty body)");
  } catch (e) { console.log(`\n[${label}] failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`); }
}
await tryRange("small range", head.number - 200000, head.number);
await tryRange("from the very start", 0, head.number);
