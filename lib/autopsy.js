import { providerName } from "./provider.js";
// Transaction Autopsy: the transaction told as an ordered story, built ONLY from evidence.
// Every line carries a level (confirmed / likely / unknown) and where it came from (free explorer
// or the paid Deep Investigation). Nothing here is written by an AI, so nothing can be invented.
// Anything the evidence does not establish is listed under "unknown", never filled in.
import { short, fromUnits, plural } from "./format.js";
import { niceTime, isSystemAddr, movementFinding } from "./classify.js";
import { decodeErc20Call } from "./plan.js";
const TOPICS = new Set(["reason", "balance", "allowance", "status", "nonce", "gas", "logs"]);

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const line = (text, level = "confirmed", source = "free", extra = {}) => ({ text, level, source, ...extra });
const fromFinding = (x) => line(x.text, x.confidence, "deep", x.technical ? { technical: x.technical } : {});

// opts: { transfersKnown, deepState: "none" | "running" | "done" | "unavailable", deepText, paid }
export function buildAutopsy(kind, facts, deepFindings = null, opts = {}) {
  if (!facts || !["success", "failed", "pending", "unclear"].includes(kind)) return null;
  const deep = Array.isArray(deepFindings) ? deepFindings : [];
  const deepDone = opts.deepState === "done";
  const failed = kind === "failed", pending = kind === "pending";
  const topic = (t) => deep.filter((x) => x.topic === t);
  const stages = [];
  const unknown = [];

  // 1. Submission
  const when = niceTime(facts.timestamp);
  const subLines = [line(`The sender (${short(facts.from)}) submitted the transaction${when ? " on " + when : ""}.`)];
  if (facts.block) subLines.push(line(`It was recorded in block ${facts.block}.`));
  stages.push({ title: "Submission", lines: subLines });

  // 2. Execution target
  let target;
  if (facts.createdContract) target = `The transaction created a new smart contract (${short(facts.createdContract)}).`;
  else if (facts.toIsContract) target = `It was sent to a smart contract (${facts.toName ? facts.toName + " " : ""}${short(facts.to)})${facts.method ? `, asking it to run "${facts.method}"` : ""}.`;
  else { const v = fromUnits(facts.valueWei); target = `It was sent to an address (${short(facts.to)})${v && v !== "0" ? ` with ${v} CELO` : ""}.`; }
  const sentLines = [line(target)];
  const cv = fromUnits(facts.valueWei);
  if (facts.toIsContract && cv && cv !== "0") sentLines.push(line(`${cv} CELO was sent along with it.`));
  stages.push({ title: "Where it was sent", lines: sentLines });

  // 3. What happened inside
  const inside = [];
  let needsDeep = false;
  if (failed) {
    const reason = topic("reason");
    if (reason.length) {
      for (const x of reason) inside.push(fromFinding(x));
      const first = reason.find((x) => x.technical && x.technical[0]?.startsWith("Contract address: "));
      const failingTo = first?.technical[0].slice("Contract address: ".length);
      if (failingTo && facts.to && !same(failingTo, facts.to)) inside.push(line("The failure came from a contract deeper inside the call, not the one the transaction was sent to.", "confirmed", "deep"));
    } else if (facts.revertReason) {
      inside.push(line(`The explorer reports this reason: "${facts.revertReason}".`));
    } else {
      if (facts.result && facts.result !== "success") inside.push(line(`The explorer reports this result: "${facts.result}".`));
      if (!deepDone && opts.deepState !== "unavailable") inside.push(line("Where it stopped is not in the basic investigation. A Deep Investigation looks inside the transaction.", "deepcheck", null));
      needsDeep = !deepDone && opts.deepState !== "unavailable" && opts.deepState !== "running";
    }
    for (const t of ["balance", "allowance"]) for (const x of topic(t)) inside.push(fromFinding(x));
    if (facts.gasUsed && facts.gasLimit && facts.gasUsed >= facts.gasLimit) inside.push(line("It used all of the gas it was allowed, which is a likely cause.", "likely", "free"));
  } else if (pending) {
    inside.push(line("It has not been included in a block yet."));
    const why = [...topic("nonce"), ...topic("gas")];
    for (const x of why) inside.push(fromFinding(x));
    for (const x of topic("status")) inside.push(fromFinding(x));
    if (!why.length) { if (!deepDone && opts.deepState !== "unavailable") inside.push(line("Why it is still waiting is not in the basic investigation. A Deep Investigation can check.", "deepcheck", null)); needsDeep = !deepDone && opts.deepState !== "unavailable" && opts.deepState !== "running"; }
  } else if (kind === "success") {
    inside.push(line("The call ran to the end without an error."));
  } else {
    if (!deepDone && opts.deepState !== "unavailable") inside.push(line("The status is not clear from the basic investigation. A Deep Investigation can check.", "deepcheck", null));
    needsDeep = !deepDone && opts.deepState !== "unavailable" && opts.deepState !== "running";
  }
  stages.push({ title: failed ? "Where it stopped" : pending ? "Waiting" : kind === "success" ? "Execution" : "Status", lines: inside });

  // 4. Outcome
  const outcome = failed ? "The transaction did not complete." : pending ? "The transaction is not complete yet." : kind === "success" ? "The transaction completed." : "The outcome is unclear.";
  const outLines = [line(outcome, kind === "unclear" ? "unknown" : "confirmed", kind === "unclear" ? null : "free")];
  if (!pending) for (const x of topic("status")) outLines.push(fromFinding(x));
  stages.push({ title: "Outcome", lines: outLines });

  // 5. Financial impact
  const money = [];
  const fee = fromUnits(facts.feeWei, 18, 8);
  if (fee && fee !== "0") {
    money.push(facts.feeCurrency
      ? line(`A network fee of ${fee} ${facts.feeCurrency} was charged${failed ? ", even though the transaction failed" : ""}. This is the explorer's figure; ChainLens has not independently verified the amount.`)
      : line(`A network fee of ${fee} was charged${failed ? ", even though the transaction failed" : ""}.`));
  }
  const allT = facts.transfers || [];
  const sys = allT.filter((t) => isSystemAddr(t.from) || isSystemAddr(t.to));
  const main = allT.filter((t) => !sys.includes(t));
  const call = failed ? decodeErc20Call(facts) : null;
  if (failed) {
    if (call) money.push(line(`It tried to call a token "${call.kind}" function. Because the transaction failed, no tokens were moved.`, "confirmed", "free",
      { technical: [`Token contract: ${call.token}`, `Raw amount requested: ${call.amount.toString()}`, call.recipient ? `Intended recipient: ${call.recipient}` : null].filter(Boolean) }));
    else money.push(line("The steps the transaction attempted did not take effect."));
    if (main.length) money.push(line(`The explorer still lists ${plural(main.length, "token movement")} alongside it. Treat them with care: a failed transaction does not move tokens by itself.`, "likely"));
  } else if (kind === "success") {
    if (opts.transfersKnown === false) { if (!deepDone && opts.deepState !== "unavailable") money.push(line("Token transfer details could not be loaded by the basic investigation. A Deep Investigation can check.", "deepcheck", null)); }
    else if (!main.length && !sys.length) money.push(line("The explorer lists no token transfers for this transaction."));
    if (main.length && !main.every((t) => t.symbol && t.from && t.to)) money.push(line(`The explorer reports ${plural(main.length, "token transfer record")}.`));
    else for (const t of main) {
      const amt = fromUnits(t.value, t.decimals);
      money.push(line(`${amt ?? "An amount of"} ${t.symbol} moved from ${short(t.from)} to ${short(t.to)}.`, "confirmed", "free",
        { technical: [t.token ? `Token contract: ${t.token}` : null, facts.method && same(facts.to, t.token) ? `Function called: ${facts.method}` : null].filter(Boolean) }));
    }
  }
  if (sys.length && kind !== "pending") { const m = movementFinding(sys, facts); money.push(line(m.text, m.confidence, "free", m.technical ? { technical: m.technical } : {})); }
  for (const x of topic("logs")) money.push(fromFinding(x));
  for (const x of deep.filter((y) => !TOPICS.has(y.topic))) money.push(fromFinding(x));
  stages.push({ title: "Financial impact", lines: money });

  // What remains unknown
  if (failed) {
    const noMsg = topic("reason").some((x) => /no readable message/i.test(x.text));
    if (inside.some((l) => l.level === "deepcheck")) unknown.push("Why it failed.");
  }
  if (pending && !deepDone && !topic("nonce").length && !topic("gas").length) unknown.push("Why it is still waiting.");
  if (kind === "unclear" && !deepDone) unknown.push("The transaction's status.");

  // Where this comes from
  const evidence = [{ label: "Data", detail: "The Celo explorer." }];
  if (deepDone && opts.paid) {
    const L = opts.paid.ledger || {};
    evidence.push({ label: "Deep Investigation", detail: `Extra information from ${providerName()}, bought by ChainLens through Buy${opts.paid.reused ? " (previously paid; no new charge)" : ""}.`, paymentTxHash: opts.paid.paymentTxHash || L.paymentTxHash || null });
  }

  return { state: kind, outcome: failed ? "Failed" : pending ? "Pending" : kind === "success" ? "Successful" : "Unclear", stages, unknown, evidence, needsDeep };
}
