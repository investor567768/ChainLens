// Tap-to-ask follow-ups. Each answer is assembled from the stored evidence for that investigation.
// There is no free-text guessing: if the evidence does not answer a question, the answer says so.
import { short, fromUnits, plural } from "./format.js";

export const FOLLOW_UPS = [
  { key: "fee", label: "How much did it cost?" },
  { key: "moved", label: "Did any tokens move?" },
  { key: "unknown", label: "What can a Deep Investigation add?" },
  { key: "sources", label: "Where did this come from?" },
];
const L = (text, level = "confirmed") => ({ text, level });

export function answerFollowUp(key, ctx) {
  const item = FOLLOW_UPS.find((f) => f.key === key);
  if (!item) return { ok: false, error: "That question is not available." };
  const { kind, facts, autopsy } = ctx || {};
  if (!facts) return { ok: false, error: "That investigation expired. Run it again." };
  const failed = kind === "failed", pending = kind === "pending";
  let lines = [];

  if (key === "fee") {
    const fee = fromUnits(facts.feeWei, 18, 8);
    if (pending) lines = [L("No fee has been charged yet, because the transaction has not been included in a block.")];
    else if (fee && fee !== "0") lines = [L(`The explorer reports a network fee of ${fee}${facts.feeCurrency ? " " + facts.feeCurrency : ""}${failed ? ". It was charged even though the transaction failed" : ""}.`, "confirmed"), L("ChainLens has not independently verified this amount.")];
    else lines = [L("No fee amount is available for this transaction.")];
  } else if (key === "moved") {
    const v = fromUnits(facts.valueWei);
    const tr = facts.transfers || [];
    if (pending) lines = [L("Nothing has moved yet. The transaction has not been included in a block.")];
    else {
      if (failed) lines.push(L("The transaction failed, so the steps it attempted did not take effect."));
      if (v && v !== "0") lines.push(L(`${v} CELO was part of this transaction${failed ? ", but it failed, so that amount was not transferred by it" : ""}.`));
      if (tr.length) {
        lines.push(L(`The explorer lists ${plural(tr.length, "token transfer record")}${failed ? " alongside the failure" : ""}:`));
        for (const t of tr.slice(0, 3)) lines.push(L(`${fromUnits(t.value, t.decimals) ?? "an amount of"} ${t.symbol} from ${short(t.from)} to ${short(t.to)}.`));
        if (tr.length > 3) lines.push(L(`And ${tr.length - 3} more.`));
      } else if (!failed) lines.push(L("The explorer lists no token transfers for this transaction."));
    }
  } else if (key === "unknown") {
    const u = autopsy?.unknown || [];
    lines = u.length ? u.map((x) => L(x + " A Deep Investigation can check.", "deepcheck")) : [L("The basic investigation found nothing that a Deep Investigation could add.")];
  } else if (key === "sources") {
    lines = (autopsy?.evidence || []).map((e) => L(`${e.label}: ${e.detail}`));
    if (!lines.length) lines = [L("Data: the Celo explorer.")];
  }
  const paymentTxHash = key === "sources" ? (autopsy?.evidence || []).find((e) => e.paymentTxHash)?.paymentTxHash || null : null;
  return { ok: true, key, question: item.label, lines, paymentTxHash };
}
