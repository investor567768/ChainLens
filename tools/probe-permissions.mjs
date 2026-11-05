// Shows, step by step, what the live data sources return for one wallet. Read-only. Free. Pays nothing.
// Usage: node tools/probe-permissions.mjs 0xYourWalletAddress
import { checkPermissions } from "../lib/permissions.js";
const address = process.argv[2];
if (!address) { console.log("Give a wallet address: node tools/probe-permissions.mjs 0x..."); process.exit(1); }
const SQD = process.env.SQD_BASE || "https://gateway.usebuy.ai/sqd/datasets/celo-mainnet";
const show = async (label, url) => { try { const r = await fetch(url); const t = await r.text(); console.log(`\n[${label}] HTTP ${r.status}\n${t.slice(0, 300)}`); } catch (e) { console.log(`\n[${label}] failed: ${e.message}`); } };
await show("SQD head", SQD + "/head");
await show("Explorer, this wallet", `${process.env.BLOCKSCOUT_BASE || "https://celo.blockscout.com/api/v2"}/addresses/${address}`);
const r = await checkPermissions(address);
console.log("\n[Result] ok:", r.ok, "| source:", r.source, "| active:", r.permissions?.length, "| cancelled:", r.cancelledCount);
if (!r.ok) console.log("Error:", r.error);
for (const p of r.permissions || []) console.log("-", p.level, "|", p.text);
for (const n of r.notes || []) console.log("Note:", n);
