// Start-up for a hosted copy. Safe to run anywhere; every step is optional and never stops the app.
//  1. Seed: if there is no payment ledger yet and seed/ledger.jsonl exists, copy it in (so Payments is not empty).
//  2. Buy account: if BUY_IMPORT_KEY is set and the account is not set up yet, import it once.
//     The key is read by Buy from the environment, never printed, and removed from this process afterwards.
//  3. Start the server.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scrub = (s) => String(s || "").replace(/(0x)?[0-9a-fA-F]{64}/g, "[hidden]").trim().slice(0, 600);

function seedLedger() {
  try {
    const dir = process.env.CHAINLENS_DATA_DIR || path.join(root, "data");
    const dest = path.join(dir, "ledger.jsonl");
    const src = path.join(root, "seed", "ledger.jsonl");
    if (existsSync(dest) || !existsSync(src)) return;
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, dest);
    console.log("[start] Seeded the payment ledger from seed/ledger.jsonl");
  } catch (e) { console.log("[start] Ledger seed skipped:", scrub(e && e.message)); }
}

function importBuyAccount() {
  const key = process.env.BUY_IMPORT_KEY;
  if (!key) return;
  try {
    const account = process.env.BUY_ACCOUNT || "agent";
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(account)) { console.log("[start] BUY_ACCOUNT has odd characters. Import skipped."); return; }
    const cmd = process.env.BUY_CMD || "buy";
    const run = (args) => spawnSync(`${cmd} ${args}`, { shell: true, env: process.env, encoding: "utf8", timeout: 90000 });
    const before = run(`--account ${account} whoami`);
    if (before.status === 0) { console.log("[start] Buy account '" + account + "' already set up. Nothing to import."); return; }
    const made = run(`setup --name ${account} --import`);
    if (made.status !== 0) { console.log("[start] Buy import failed:", scrub(made.stderr || made.stdout)); return; }
    const after = run(`--account ${account} whoami`);
    console.log("[start] Buy account imported. whoami:", scrub(after.stdout || after.stderr));
    console.log("[start] You can now delete the BUY_IMPORT_KEY variable.");
  } catch (e) {
    console.log("[start] Buy import error:", scrub(e && e.message));
  } finally {
    delete process.env.BUY_IMPORT_KEY; // never hand the key to the server or to later Buy calls
  }
}

seedLedger();
importBuyAccount();
await import("../server.js");
