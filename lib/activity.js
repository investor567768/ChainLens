import { providerName } from "./provider.js";
// The agent's activity feed: every decision ChainLens makes, including the decision NOT to pay.
// Text is built from the actual results. Plain JSON lines, next to the ledger.
import { appendFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { short, plural } from "./format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dirNow = () => process.env.CHAINLENS_DATA_DIR || path.join(here, "..", "data");
const fileNow = () => path.join(dirNow(), "activity.jsonl");

export async function logEvent(ev) {
  const row = { at: new Date().toISOString(), ...ev };
  try {
    await mkdir(dirNow(), { recursive: true });
    await appendFile(fileNow(), JSON.stringify(row) + "\n", "utf8");
  } catch { /* the feed is best effort and must never break an investigation */ }
  return row;
}

export async function readEvents(limit = 50) {
  try {
    const rows = (await readFile(fileNow(), "utf8")).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit).reverse();
  } catch { return []; }
}

// After the free step: what ChainLens decided, and why.
export function describeFree(free) {
  if (!free || !free.ok || !free.hash && free.kind !== "notfound") return null;
  const h = short(free.hash || "");
  if (free.kind === "notfound") return { type: "free", text: `Basic investigation of ${h || "a hash"}. The explorer has no record of it, so there is nothing for a Deep Investigation to look at.` };
  if (free.paid?.pending) {
    return { type: "decision", text: `Basic investigation of ${h}. You asked for a Deep Investigation. ChainLens is paying for it.` };
  }
  if (free.deep?.recommended) {
    return { type: "offer", text: `Basic investigation of ${h}. The basic investigation was not enough because ${free.deep.recommended}. A Deep Investigation was offered. Nothing was paid, it is your choice.` };
  }
  return { type: "free", text: `Basic investigation of ${h}. No Deep Investigation needed: ${free.paid?.reason || "the basic investigation was enough"}.` };
}

// After the Deep Investigation.
export function describePaid(hash, more) {
  const h = short(hash || "");
  const d = more?.deep || {};
  if (d.state === "done" && d.reused) return { type: "reused", text: `Deep Investigation for ${h}: previously paid. No new charge.` };
  if (d.state === "done") {
    const L = more.paid?.ledger || {};
    const n = (more.paid?.perCall || []).length;
    return { type: "paid", text: `Deep Investigation of ${h}: paid ${L.amount || "?"} ${L.currency || ""} to ${providerName()}, through Buy, for ${plural(n, "check")}. ${d.verdict?.line || ""}`.replace(/\s+/g, " ").trim(), paymentTxHash: more.paid?.paymentTxHash || L.paymentTxHash || null };
  }
  return { type: "unavailable", text: `Deep Investigation for ${h} could not be completed: ${d.text || "no reason given"}` };
}
