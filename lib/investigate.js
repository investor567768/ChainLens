import { providerName, viaBuy } from "./provider.js";
// Two layers of one explanation.
//   Basic investigation  : free public explorer data, always available.
//   Deep Investigation   : extra evidence from an independent provider, bought by ChainLens
//                          through Buy. The user pays nothing.
// The Deep layer adds to the explanation. It is never required: if it is unavailable,
// the basic investigation still stands on its own.

import { HASH_RE, fromUnits, short, joinList, plural } from "./format.js";
import { fetchTransaction } from "./blockscout.js";
import { normalizeTx, classify, needsPaidEvidence, buildHeadline } from "./classify.js";
import { newInvestigationId } from "./evidence.js";
import { defaultPurpose, PURPOSES, OFFERED_PURPOSES, decodeErc20Call } from "./plan.js";
import { getPaidEvidence } from "./paid.js";
import { buildAutopsy } from "./autopsy.js";

const clean = (s, n = 200) => (typeof s === "string" ? s.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, n) : "");

// What a Deep Investigation would add for THIS transaction, in plain words. Built from what we found.
export function offerAdds(kind, facts, findings) {
  const adds = [];
  if (kind === "failed") {
    adds.push("Look inside the transaction to find where it broke, and the message it gave, when that data is available.");
    if (decodeErc20Call(facts)) adds.push("Check the sender's token balance and spending allowance just before the failure.");
  } else if (kind === "pending") {
    adds.push("Check whether earlier transactions from the same wallet are holding it up.");
    adds.push("Check whether the fee offered is high enough for the network right now.");
  } else {
    adds.push(`Cross-check the result with ${providerName()}, a second source.`);
    if (findings.some((x) => x.confidence === "unknown" && x.technical)) adds.push("Show which contracts moved tokens inside the transaction, and whether any approvals were involved.");
  }
  return adds;
}

export const REASON_OPTIONS = OFFERED_PURPOSES.map((key) => ({ key, label: PURPOSES[key] }));

// Phase 1: free facts only. Fast. Never pays.
export async function investigateFree(hash, deps = {}, opts = {}) {
  const fetchTx = deps.fetchTransaction || fetchTransaction;
  const investigationId = newInvestigationId();

  if (!HASH_RE.test(hash || "")) {
    return { investigationId, ok: false, error: "That does not look like a transaction hash. It should start with 0x and be 66 characters long." };
  }
  const res = await fetchTx(hash);
  if (res.notFound) {
    return {
      investigationId, ok: true, kind: "notfound",
      findings: [
        { layer: "basic", text: "The explorer has no record of this hash on Celo mainnet.", confidence: "confirmed" },
        { layer: "basic", text: "Possible reasons: a typo in the hash, a different network, or a very new transaction that has not been indexed yet. We cannot tell which.", confidence: "unknown" },
      ],
      headline: buildHeadline("notfound", {}),
      deep: { state: "none", text: "There is nothing to investigate yet." },
      paid: { used: false, pending: false, reason: "There is nothing to investigate yet." },
    };
  }
  if (!res.ok) {
    return { investigationId, ok: false, error: `Could not get data right now (${res.error || "unknown error"}). Try again shortly.` };
  }

  const facts = normalizeTx(res.tx, res.transfers);
  const { kind, findings } = classify(facts);
  const basic = findings.map((x) => ({ layer: "basic", ...x }));
  let decision = needsPaidEvidence(kind, facts);
  const asked = !!opts.forcePaid;
  if (!decision.needed && asked) decision = { needed: true, reason: "you asked for it" };

  const notes = [];
  if (res.transfersError) notes.push(`Token transfer details were unavailable (${res.transfersError}).`);

  const purpose = PURPOSES[opts.purpose] ? opts.purpose : defaultPurpose(kind);
  const note = purpose === "other" ? clean(opts.note) || null : null;
  // The user decides. ChainLens never pays on its own: when the free data is not enough it
  // says so, gives the reason, and offers the Deep Investigation. Paying starts only on request.
  const run = asked;
  const paid = run
    ? { used: false, pending: true, reason: decision.reason, started: "by you", purpose, purposeLabel: PURPOSES[purpose], note }
    : { used: false, pending: false, reason: decision.reason };

  const deep = run
    ? { state: "running", why: "You asked for a Deep Investigation." }
    : { state: "offer", recommended: decision.needed ? decision.reason : null, adds: offerAdds(kind, facts, basic), reasons: REASON_OPTIONS };

  return { investigationId, sessionId: opts.sessionId || null, transfersKnown: !res.transfersError, ok: true, hash, kind, facts, headline: buildHeadline(kind, facts), findings: basic, notes, deep, paid,
    autopsy: buildAutopsy(kind, facts, null, { transfersKnown: !res.transfersError, deepState: run ? "running" : "none" }) };
}

// Phase 2: the Deep Investigation. Pays at most once per transaction and call set.
export async function addPaid(hash, free, deps = {}) {
  const paid = deps.getPaidEvidence || getPaidEvidence;
  const p = await paid(hash, free.investigationId, { facts: free.facts, purpose: free.paid.purpose, note: free.paid.note, sessionId: free.sessionId || null, orderer: deps.orderer || null });
  const base = { used: false, pending: false, reason: free.paid.reason, purpose: free.paid.purpose, purposeLabel: free.paid.purposeLabel };
  if (p.available) {
    const deepFindings = independentFindings(p, free.facts);
    const done = { state: "done", why: free.deep?.why || null, reused: !!p.reused, verdict: deepVerdict(deepFindings), completeness: completeness(p.perCall) };
    return {
      headline: buildHeadline(free.kind, free.facts, p),
      autopsy: buildAutopsy(free.kind, free.facts, deepFindings, { transfersKnown: free.transfersKnown !== false, deepState: "done", paid: { reused: !!p.reused, paymentTxHash: p.paymentTxHash, ledger: p.ledger } }),
      findings: deepFindings,
      deep: done,
      paid: { ...base, used: true, reused: !!p.reused, paymentTxHash: p.paymentTxHash, perCall: p.perCall, ledger: p.ledger },
    };
  }
  return {
    findings: [],
    autopsy: buildAutopsy(free.kind, free.facts, null, { deepState: "unavailable", deepText: p.reason }),
    deep: { state: "unavailable", why: free.deep?.why || null, text: p.reason || "The Deep Investigation could not be completed." },
    paid: { ...base, unavailable: p.reason, ledger: p.ledger },
  };
}

// Both phases in one call (used by tests and scripts).
export async function investigate(hash, deps = {}, opts = {}) {
  const free = await investigateFree(hash, deps, opts);
  if (!free.ok || !free.paid.pending) return free;
  const more = await addPaid(hash, free, deps);
  return { ...free, headline: more.headline || free.headline, autopsy: more.autopsy || free.autopsy, findings: [...free.findings, ...more.findings], deep: more.deep, paid: more.paid };
}

export function completeness(perCall) {
  const total = (perCall || []).length;
  if (!total) return null;
  const returned = perCall.filter((c) => c.ok).length;
  return { returned, total, text: `${returned} of ${total} checks returned data.` };
}

const TOPIC_TEXT = {
  reason: "the reason it failed",
  balance: "the sender's token balance at the time",
  allowance: "the spending allowance at the time",
  nonce: "whether earlier transactions are holding it up",
  gas: "whether the fee offered is high enough",
  movements: "which contracts moved tokens and whether any approvals were involved",
};

// One line saying what the Deep Investigation changed. Built from the findings, never fixed.
export function deepVerdict(findings) {
  const deep = findings.filter((x) => x.layer === "deep");
  if (deep.some((x) => x.kind === "differ")) {
    return { kind: "differs", line: "The Deep Investigation reports something different from the free explorer. See below." };
  }
  const added = [...new Set(deep.filter((x) => x.kind === "new").map((x) => TOPIC_TEXT[x.topic]).filter(Boolean))];
  const agreed = deep.some((x) => x.kind === "agree" && x.topic === "status");
  if (added.length) {
    return { kind: "added", line: `${agreed ? "The Deep Investigation agreed on the outcome and added: " : "The Deep Investigation added: "}${joinList(added)}.` };
  }
  if (agreed) return { kind: "agrees", line: "The Deep Investigation agreed with the basic investigation. It did not find anything new." };
  return { kind: "nothing", line: "The Deep Investigation could not add anything for this transaction." };
}

export function independentFindings(p, facts) {
  const out = [];
  const source = p.reused ? `${providerName()}, through Buy (previously paid; no new charge)` : viaBuy();
  const mk = (text, confidence, kind, topic, extra = {}) => ({ layer: "deep", text, confidence, kind, topic, source, ...extra });
  const freeOk = facts.status === "ok" ? true : facts.status === "error" ? false : null;

  if ((p.receiptSucceeded === null || p.receiptSucceeded === undefined) && p.receiptMissing && freeOk === null) {
    out.push(mk(`${providerName()} also has no receipt for this transaction yet. That fits with it still waiting to be included, but it does not tell us why.`, "confirmed", "agree", "status"));
  } else if (p.receiptSucceeded === null || p.receiptSucceeded === undefined) {
    out.push(mk(`${providerName()} did not return a readable receipt for this transaction.`, "unknown", "missing", "status"));
  } else if (freeOk === null) {
    out.push(mk(`The Deep Investigation's receipt says the transaction ${p.receiptSucceeded ? "succeeded" : "failed"}.`, "confirmed", "new", "status"));
  } else if (freeOk === p.receiptSucceeded) {
    out.push(mk(`The Deep Investigation agrees: the transaction ${p.receiptSucceeded ? "succeeded" : "failed"}.`, "confirmed", "agree", "status"));
  } else {
    out.push(mk("The free explorer and the Deep Investigation disagree about whether this transaction succeeded. Treat the result as unresolved.", "confirmed", "differ", "status"));
  }

  const t = p.trace;
  if (!t) {
    const c = (p.perCall || []).find((x) => x.method === "debug_traceTransaction");
    out.push(mk(`The inside of the transaction could not be retrieved${c?.error ? " (" + clean(c.error, 120) + ")" : ""}.`, "unknown", "missing", "reason"));
  } else if (t.failing) {
    const where = short(t.failing.to) === "unknown" ? "a smart contract" : `a smart contract (${short(t.failing.to)})`;
    const tx = tech(`Contract address: ${t.failing.to || "unknown"}`, `Error reported: ${t.failing.error}`, t.failing.selector ? `Function selector: ${t.failing.selector}` : null);
    if (t.failing.reason) {
      out.push(mk(/revert/i.test(t.failing.error) ? `Inside the transaction, ${where} rejected the request with the message "${t.failing.reason}".` : `Inside the transaction, ${where} stopped with this message: "${t.failing.reason}".`, "confirmed", "new", "reason", tx));
    } else {
      out.push(mk(`Inside the transaction, ${where} stopped with an error ("${t.failing.error}"), but gave no readable message.`, "confirmed", "new", "reason", tx));
    }
  } else if (facts.status === "error") {
    out.push(mk(`The inside of the transaction (${plural(t.calls, "step")}) did not show exactly where it failed.`, "unknown", "missing", "reason"));
  } else {
    out.push(mk(`The inside of the transaction shows ${plural(t.calls, "step")} and no errors.`, "confirmed", "agree", "trace"));
  }

  out.push(...extraFindings(p.extras || {}, mk));
  out.push(...movementFindings(p, facts, mk));
  return out;
}

const gwei = (wei) => fromUnits(wei, 9, 4);

export function extraFindings(ex, mk) {
  const out = [];
  if (ex.balance) {
    const b = ex.balance, dec = b.decimals;
    const show = (raw) => (dec === null ? `${raw} (raw units)` : fromUnits(raw, dec, Math.min(dec, 6)));
    out.push(mk(`One block earlier (block ${b.atBlock}), the sender held ${show(b.balance)} of this token, and the call asked to move ${show(b.amount)}.`, "confirmed", "new", "balance", tech(`Token contract: ${b.token}`, `Raw balance: ${b.balance}`, `Raw amount: ${b.amount}`)));
    if (!b.enough) out.push(mk("Holding less than the amount requested is enough to make a standard token transfer fail, so this is a likely cause.", "likely", "new", "balance", { why: "Read from the chain's state one block earlier; the contract's own message was not required." }));
    else out.push(mk("The balance covered the amount, so a lack of funds does not explain this failure.", "confirmed", "new", "balance"));
  }
  if (ex.allowance) {
    const a = ex.allowance;
    out.push(mk(a.enough ? "The spending allowance covered the amount, so allowance does not explain this failure." : "The spending allowance was lower than the amount requested, which is a likely cause of the failure.", a.enough ? "confirmed" : "likely", "new", "allowance", tech(`Raw allowance: ${a.allowance}`, `Raw amount: ${a.amount}`)));
  }
  if (ex.nonce) {
    const n = ex.nonce;
    if (n.earlierUnconfirmed !== "0") out.push(mk(`${plural(Number(n.earlierUnconfirmed), "earlier transaction")} from this wallet ${Number(n.earlierUnconfirmed) === 1 ? "is" : "are"} not confirmed yet, and transactions must go in order, so this is a likely cause of the wait.`, "likely", "new", "nonce", tech(`This transaction's number: ${n.txNonce}`, `Wallet's confirmed count: ${n.latest}`)));
    else if (n.alreadyUsed) out.push(mk("The wallet has already moved past this transaction's place in line. It may have been replaced, or confirmed under a different hash.", "likely", "new", "nonce", tech(`This transaction's number: ${n.txNonce}`, `Wallet's confirmed count: ${n.latest}`)));
    else out.push(mk("It is next in line for this wallet, so ordering does not explain the delay.", "confirmed", "new", "nonce", tech(`This transaction's number: ${n.txNonce}`, `Wallet's confirmed count: ${n.latest}`)));
  }
  if (ex.gas) {
    const g = ex.gas;
    out.push(mk(g.belowNetwork ? "The fee offered is below the network's current minimum, which is a likely cause of the delay." : "The fee offered is at or above the network's current minimum, so the fee level does not explain the delay.", g.belowNetwork ? "likely" : "confirmed", "new", "gas", tech(`Offered: ${gwei(g.offered)} gwei`, `Network minimum now: ${gwei(g.network)} gwei`)));
  }
  if (ex.logs) {
    const l = ex.logs;
    out.push(l.agree
      ? mk(`The Deep Investigation's receipt shows the same ${plural(l.receiptTransferLogs, "token transfer record")} as the basic investigation.`, "confirmed", "agree", "logs")
      : mk(`The Deep Investigation's receipt shows ${plural(l.receiptTransferLogs, "token transfer record")} but the free explorer reported ${l.explorerTransfers}. They do not match, so treat the transfer list as unverified.`, "confirmed", "differ", "logs"));
  }
  return out;
}

// "Unexpected token movements": which contracts were touched, which calls moved tokens, which asked for approvals.
export function movementFindings(p, facts, mk) {
  const m = p.movements;
  if (!m) return [];
  const asked = ["movements", "research"].includes(p.ledger?.purpose) || p.purpose === "movements";
  const unlimited = m.calls.some((c) => (c.kind === "approve" || c.kind === "increaseAllowance" || c.kind === "setApprovalForAll") && c.unlimited && !c.failed);
  if (!asked && !unlimited) return [];
  const out = [];
  const txFailed = facts.status === "error" || p.receiptSucceeded === false;
  out.push(mk(`The transaction touched ${plural(m.contractCount, "smart contract")}.`, "confirmed", "new", "movements", tech(...m.contracts.map((c) => `Contract: ${c}`))));
  const moves = m.calls.filter((c) => ["transfer", "transferFrom"].includes(c.kind));
  const approvals = m.calls.filter((c) => !["transfer", "transferFrom"].includes(c.kind));
  for (const c of moves.slice(0, 5)) {
    const noEffect = c.failed || txFailed;
    out.push(mk(`A token contract (${short(c.token)}) was asked to move tokens to ${short(c.recipient)}.${noEffect ? " That step did not take effect because it, or the transaction around it, failed." : ""}`, "confirmed", "new", "movements", tech(`Call: ${c.kind}`, c.amount ? `Raw amount: ${c.amount}` : null, `Token contract: ${c.token}`)));
  }
  for (const c of approvals.slice(0, 5)) {
    const noEffect = c.failed || txFailed;
    const what = c.kind === "setApprovalForAll" ? "to manage all of its tokens of that kind" : c.unlimited ? "to spend an unlimited amount of tokens" : "to spend an amount of tokens";
    out.push(mk(`A token contract (${short(c.token)}) was asked to let ${short(c.spender)} ${what} (an approval).${noEffect ? " That step did not take effect because it, or the transaction around it, failed." : ""}`, "confirmed", "new", "movements", tech(`Call: ${c.kind}`, c.amount ? `Raw amount: ${c.amount}` : null, `Token contract: ${c.token}`, `Approved address: ${c.spender}`)));
  }
  if (!moves.length && !approvals.length) out.push(mk("The inside of the transaction shows no calls that move tokens or grant approvals.", "confirmed", "new", "movements"));
  return out;
}

function tech(...lines) { const t = lines.filter(Boolean); return t.length ? { technical: t } : {}; }
