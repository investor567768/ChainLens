// Evidence ledger: one line per paid call. Plain JSON lines, easy to inspect.
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the ledger lives. Tests point CHAINLENS_DATA_DIR at a scratch folder so they never touch the real ledger.
const here = path.dirname(fileURLToPath(import.meta.url));
const dirNow = () => process.env.CHAINLENS_DATA_DIR || path.join(here, "..", "data");
const fileNow = () => path.join(dirNow(), "ledger.jsonl");

export function newInvestigationId() {
  return "inv_" + randomUUID().slice(0, 8);
}

export function digest(obj) {
  return createHash("sha256").update(JSON.stringify(obj ?? null)).digest("hex");
}

// entry fields: investigationId, provider, requestId, amount, currency,
// paymentTxHash, status ("ok"|"failed"|"unknown"), resultDigest, resultSummary, error
export async function record(entry) {
  const row = { at: new Date().toISOString(), ...entry };
  await mkdir(dirNow(), { recursive: true });
  await appendFile(fileNow(), JSON.stringify(row) + "\n", "utf8");
  return row;
}

export async function readAll() {
  try {
    const txt = await readFile(fileNow(), "utf8");
    return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Find an earlier successful paid check for the same transaction (so we never pay twice).
export async function findPaidFor(subject) {
  const rows = await readAll();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === "paid-call" && r.status === "ok" && r.subject === subject && r.summary) return r;
  }
  return null;
}
