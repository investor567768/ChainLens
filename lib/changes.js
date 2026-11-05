// "What changed" for a watched wallet: for the newest activity since the last visit, a few plain lines
// per item, built from the free investigation. It never starts a paid check.
import { HASH_RE, plural } from "./format.js";
import { investigateFree } from "./investigate.js";

export async function explainChanges(w, since, deps = {}) {
  if (!w || !w.ok || !HASH_RE.test(since || "")) return [];
  const idx = w.items.findIndex((i) => i.hash === since);
  const fresh = (idx === -1 ? w.items : w.items.slice(0, idx)).filter((i) => HASH_RE.test(i.hash || "")).slice(0, 3);
  const run = deps.investigateFree || investigateFree;
  const newContact = new Set((w.intel?.signals || []).filter((s) => s.key === "new-contact").flatMap((s) => (s.technical || []).filter((t) => t.startsWith("Transaction: ")).map((t) => t.slice("Transaction: ".length))));
  const out = [];
  for (const it of fresh) {
    const lines = [];
    let free = null;
    try { free = await run(it.hash, {}, {}); } catch { free = null; }
    if (free && free.ok && free.headline && free.facts) {
      lines.push(free.headline.title + ".");
      if (newContact.has(it.hash)) lines.push("It involves an address that does not appear earlier in the history checked.");
      const n = (free.facts.transfers || []).length;
      if (free.transfersKnown !== false) lines.push(n ? `${plural(n, "token transfer record")} detected.` : "No token transfer records detected.");
      if (free.kind === "failed") {
        const first = free.autopsy?.stages?.[2]?.lines?.[0];
        lines.push(first && first.level === "confirmed" ? first.text : "The reason is not established yet. A Deep Investigation can look inside it.");
      }
      if (free.kind === "success" && (free.autopsy?.unknown || []).some((u) => u.startsWith("What the contract interaction was for"))) lines.push("The purpose of the contract interaction is not established.");
    } else {
      lines.push("Details could not be loaded for this item.");
    }
    out.push({ hash: it.hash, summary: it.summary, when: it.when || null, status: it.status, lines });
  }
  return out;
}
