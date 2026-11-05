// Deterministic classification. No guessing: every finding carries a confidence label,
// and every sentence is built from the evidence in hand, never from a fixed story.
//   confirmed = directly stated by the data source
//   likely    = a reasonable inference from confirmed facts (explained)
//   unknown   = we do not know and say so
//
// Plain words go in the main text. Anything technical (function names, contract names,
// raw amounts) goes in `technical`, which the page keeps collapsed.

import { fromUnits, short, sameSym, plural } from "./format.js";
import { readableReason } from "./reason.js";
import { decodeErc20Call } from "./plan.js";

export function niceTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

// Addresses with a long run of leading zeros are system-style addresses (not ordinary wallets).
export const isSystemAddr = (a) => typeof a === "string" && /^0x0{30,}[0-9a-fA-F]*$/.test(a);

export function normalizeTx(raw, transfersPage) {
  const tx = raw || {};
  const items = (transfersPage && transfersPage.items) || [];
  const rr = readableReason(tx.revert_reason);
  return {
    hash: tx.hash || null,
    status: tx.status || null,           // "ok" | "error" | null (pending)
    result: tx.result || null,
    block: tx.block_number ?? tx.block ?? null,
    timestamp: tx.timestamp || null,
    from: tx.from?.hash || null,
    to: tx.to?.hash || null,
    toName: tx.to?.name || null,
    toIsContract: !!tx.to?.is_contract,
    createdContract: tx.created_contract?.hash || null,
    valueWei: tx.value ?? null,
    feeWei: tx.fee?.value ?? null,
    feeCurrency: tx.celo?.gas_token?.symbol || tx.gas_token?.symbol || tx.fee_currency?.symbol || null,
    gasUsed: tx.gas_used != null ? Number(tx.gas_used) : null,
    gasLimit: tx.gas_limit != null ? Number(tx.gas_limit) : null,
    method: tx.method || null,
    input: tx.raw_input || null,
    nonce: tx.nonce ?? null,
    gasPrice: tx.gas_price ?? null,
    revertReason: rr.text,                       // readable text, or null
    revertReasonUnreadable: rr.unreadable,       // the explorer gave something, but not readable
    revertReasonRaw: rr.raw,
    confirmations: tx.confirmations ?? null,
    transfers: items.map((t) => ({
      from: t.from?.hash || null,
      to: t.to?.hash || null,
      symbol: t.token?.symbol || "tokens",
      decimals: t.token?.decimals != null ? Number(t.token.decimals) : 18,
      value: t.total?.value ?? null,
      type: t.token?.type || t.token_type || null,
      token: t.token?.address_hash || t.token?.address || null,
    })),
  };
}

const f = (text, confidence, why, extra) => ({ text, confidence, ...(why ? { why } : {}), ...(extra || {}) });
const tech = (...lines) => ({ technical: lines.filter(Boolean) });
const sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function feeFinding(facts, failed) {
  const fee = fromUnits(facts.feeWei, 18, 8);
  if (!fee || fee === "0") return null;
  if (facts.feeCurrency) {
    return f(failed ? `A network fee of ${fee} ${facts.feeCurrency} was still charged, even though the transaction failed.` : `A network fee of ${fee} ${facts.feeCurrency} was charged.`, "confirmed");
  }
  return f(`The network fee was ${fee}.`, "confirmed");
}

export function classify(facts) {
  const out = [];
  const pending = facts.block === null && facts.status !== "ok" && facts.status !== "error";

  if (pending) {
    out.push(f("The network has seen this transaction but it has not been included in a block yet.", "confirmed"));
    out.push(f("Why it is still waiting is not in the basic investigation. A Deep Investigation can check.", "deepcheck"));
    return { kind: "pending", findings: out };
  }

  const when = niceTime(facts.timestamp);
  const where = `block ${facts.block}${when ? " on " + when : ""}`;
  const route = `${short(facts.from)} to ${facts.to ? short(facts.to) : "a newly created contract"}`;
  const sys = facts.transfers.filter((t) => isSystemAddr(t.from) || isSystemAddr(t.to));
  const main = facts.transfers.filter((t) => !sys.includes(t));

  if (facts.status === "ok") {
    out.push(f(`Transaction successful. It was recorded in ${where}.`, "confirmed"));
    out.push(f(`From ${route}.`, "confirmed"));
    const v = fromUnits(facts.valueWei);
    if (v && v !== "0") out.push(f(`${v} CELO was sent as part of this transaction.`, "confirmed"));
    if (facts.createdContract) out.push(f("It created a new smart contract.", "confirmed", null, tech(`New contract: ${facts.createdContract}`)));
    for (const t of main) {
      const amt = fromUnits(t.value, t.decimals);
      out.push(f(`A token transfer was recorded: ${amt ?? "an amount of"} ${t.symbol} from ${short(t.from)} to ${short(t.to)}.`, "confirmed", null,
        tech(t.token ? `Token contract: ${t.token}` : null, facts.method && sameAddr(facts.to, t.token) ? `Function called: ${facts.method}` : null)));
    }
    if (sys.length) out.push(movementFinding(sys, facts));
    // A direct call to the token itself is already described by the transfer above.
    const callIsTheTransfer = main.some((t) => t.token && sameAddr(t.token, facts.to));
    if (facts.toIsContract && !callIsTheTransfer) {
      out.push(f("Interacted with a smart contract.", "confirmed", null, tech(facts.method ? `Function called: ${facts.method}` : null, `Contract: ${facts.toName ? facts.toName + " " : ""}${facts.to}`)));
    }
    const fee = feeFinding(facts, false);
    if (fee) out.push(fee);
    return { kind: "success", findings: out };
  }

  if (facts.status === "error") {
    out.push(f(`The transaction failed. It was recorded in ${where}, but it did not complete.`, "confirmed"));
    out.push(f(`From ${route}.`, "confirmed"));
    const fee = feeFinding(facts, true);
    if (fee) out.push(fee);

    const d = decodeErc20Call(facts);
    if (d) {
      out.push(f(`It tried to call a token "${d.kind}" function. Because the transaction failed, no tokens were moved.`, "confirmed", null,
        tech(`Token contract: ${d.token}`, `Raw amount requested: ${d.amount.toString()}`, d.recipient ? `Intended recipient: ${d.recipient}` : null)));
    } else if (facts.toIsContract) {
      out.push(f("It tried to interact with a smart contract. Because it failed, none of its changes took effect.", "confirmed", null, tech(facts.method ? `Function called: ${facts.method}` : null, `Contract: ${facts.toName ? facts.toName + " " : ""}${facts.to}`)));
    }

    if (sys.length) out.push(movementFinding(sys, facts));

    if (facts.revertReason) {
      out.push(f(`The explorer reports this reason: "${facts.revertReason}".`, "confirmed"));
    } else if (facts.revertReasonUnreadable) {
      out.push(f("The explorer did not provide a readable failure reason. A Deep Investigation can look inside the transaction.", "deepcheck", null, tech(facts.revertReasonRaw ? `Raw data from the explorer: ${facts.revertReasonRaw}` : "The explorer returned a reason in a format we cannot read.")));
    } else {
      out.push(f("The basic investigation did not find a failure reason. A Deep Investigation can look inside the transaction.", "deepcheck"));
    }
    if (facts.result && facts.result !== "success" && !facts.revertReason) {
      out.push(f(`The explorer reports this result: "${facts.result}".`, "confirmed"));
    }
    if (facts.gasUsed && facts.gasLimit && facts.gasUsed >= facts.gasLimit) {
      out.push(f("It likely ran out of gas.", "likely", `It used ${facts.gasUsed} of ${facts.gasLimit} allowed gas (100%).`));
    }
    return { kind: "failed", findings: out };
  }

  out.push(f("The status is not clear from the basic investigation. A Deep Investigation can check.", "deepcheck"));
  return { kind: "unclear", findings: out };
}

// Should ChainLens buy independent evidence for this transaction without being asked?
// The answer follows what is still unexplained, not just whether basic data came back.
export function needsPaidEvidence(kind, facts) {
  if (kind === "failed" && !facts.revertReason) {
    return { needed: true, reason: facts.revertReasonUnreadable ? "the explorer's failure reason could not be read" : "the explorer did not give a reason for the failure" };
  }
  if (kind === "pending") return { needed: true, reason: "the transaction is still pending and the basic investigation cannot say why" };
  if (kind === "unclear") return { needed: true, reason: "the basic investigation did not make the status clear" };
  return { needed: false, reason: "the basic investigation already explains this transaction" };
}

// Show each system-style movement and test the one claim we can check with arithmetic:
// money taken from the sender minus money returned to the sender should equal the reported fee.
export function reconcileFee(sys, facts) {
  if (!facts.feeWei || !facts.from || !sys.length) return null;
  const sym = sys[0].symbol;
  if (sys.some((t) => !sameSym(t.symbol, sym))) return null;
  if (facts.feeCurrency && !sameSym(facts.feeCurrency, sym)) return null;
  const dec = sys[0].decimals;
  if (!Number.isInteger(dec) || dec > 18 || sys.some((t) => t.decimals !== dec)) return null;
  const lc = (x) => (x || "").toLowerCase();
  let out = 0n, back = 0n;
  try {
    for (const t of sys) {
      if (lc(t.from) === lc(facts.from) && isSystemAddr(t.to)) out += BigInt(t.value);
      else if (isSystemAddr(t.from) && lc(t.to) === lc(facts.from)) back += BigInt(t.value);
    }
    if (out === 0n) return null;
    const net = out - back;
    const unit = 10n ** BigInt(18 - dec);
    const diff = net * unit - BigInt(facts.feeWei);
    const ok = (diff < 0n ? -diff : diff) <= unit; // within one smallest token unit (rounding)
    return { symbol: sym, net: fromUnits(net.toString(), dec, dec), fee: fromUnits(facts.feeWei, 18, 8), matches: ok };
  } catch { return null; }
}

export function movementFinding(sys, facts) {
  const lines = sys.map((t) => `${fromUnits(t.value, t.decimals, t.decimals) ?? "?"} ${t.symbol}: ${short(t.from)} to ${short(t.to)}`);
  const rec = reconcileFee(sys, facts);
  if (rec && rec.matches) {
    return f(`Some additional movements were recorded. Added up, they match the network fee, so they are likely fee handling. That is our inference; the chain does not label them.`, "likely",
      `Taken from the sender minus returned to the sender is ${rec.net} ${rec.symbol}, and the explorer reports a fee of ${rec.fee} ${rec.symbol}. They match within rounding.`,
      tech(...lines));
  }
  const one = sys.length === 1;
  return f(one ? "An additional movement was recorded." : "Additional movements were recorded.", "confirmed", null, tech(...lines));
}

// One plain-language headline for the top of the page. Always says what we know and how well.
export function buildHeadline(kind, facts, paidSummary) {
  const main = (facts.transfers || []).filter((t) => !isSystemAddr(t.from) && !isSystemAddr(t.to));
  const fee = fromUnits(facts.feeWei, 18, 8);
  const feeCharged = fee && fee !== "0";

  if (kind === "notfound") return { state: "notfound", title: "Not found", sentence: "The explorer has no record of this hash on Celo mainnet.", reason: null };

  if (kind === "pending") {
    const ex = paidSummary?.extras || {};
    let reason = paidSummary ? null : { level: "deepcheck", text: "Why it is pending is not in the basic investigation. A Deep Investigation can check." };
    if (ex.nonce && ex.nonce.earlierUnconfirmed !== "0") reason = { level: "likely", text: `This wallet has ${plural(Number(ex.nonce.earlierUnconfirmed), "earlier transaction")} that ${Number(ex.nonce.earlierUnconfirmed) === 1 ? "is" : "are"} not confirmed yet, and transactions go in order.` };
    else if (ex.gas && ex.gas.belowNetwork) reason = { level: "likely", text: "The fee offered is below the network's current minimum gas price." };
    return { state: "pending", title: "Transaction pending", sentence: "The network has seen this transaction but it is not in a block yet.", reason };
  }

  if (kind === "success") {
    let sentence;
    if (main.length === 1) { const t = main[0]; sentence = `A token transfer of ${fromUnits(t.value, t.decimals) ?? "an amount of"} ${t.symbol} from ${short(t.from)} to ${short(t.to)} was recorded.`; }
    else if (main.length > 1) sentence = `${main.length} token transfers were recorded.`;
    else {
      const v = fromUnits(facts.valueWei);
      if (v && v !== "0") sentence = `${v} CELO was sent from ${short(facts.from)} to ${short(facts.to)}.`;
      else if (facts.toIsContract) sentence = "Interacted with a smart contract.";
      else sentence = "The transaction completed.";
    }
    return { state: "success", title: "Transaction successful", sentence, reason: null };
  }

  if (kind === "failed") {
    const tr = paidSummary?.trace?.failing || null;
    let reason;
    if (facts.revertReason) reason = { level: "confirmed", text: `The explorer reports: "${facts.revertReason}".` };
    else if (tr && tr.reason) reason = { level: "confirmed", text: /revert/i.test(tr.error) ? `The Deep Investigation found that a smart contract rejected the transaction with the message "${tr.reason}".` : `The Deep Investigation found an error inside the transaction: "${tr.reason}".` };
    else if (tr) reason = { level: "confirmed", text: `The Deep Investigation found an error inside the transaction (${tr.error}), but no readable message.` };
    else if (paidSummary?.extras?.balance && paidSummary.extras.balance.enough === false) reason = { level: "likely", text: "The sender held less of the token than the amount it tried to move, at the block before." };
    else if (paidSummary?.extras?.allowance && paidSummary.extras.allowance.enough === false) reason = { level: "likely", text: "The spending allowance was lower than the amount it tried to move, at the block before." };
    else if (facts.gasUsed && facts.gasLimit && facts.gasUsed >= facts.gasLimit) reason = { level: "likely", text: "It probably ran out of gas (it used 100% of its gas limit)." };
    else if (paidSummary) reason = null;
    else if (facts.revertReasonUnreadable) reason = { level: "deepcheck", text: "The explorer did not provide a readable failure reason. A Deep Investigation can look inside the transaction." };
    else reason = { level: "deepcheck", text: "The reason it failed is not in the basic investigation. A Deep Investigation can check." };
    return {
      state: "failed", title: "Transaction failed",
      sentence: `The transaction was recorded on the blockchain but did not complete.${feeCharged ? " A network fee was still charged." : ""}`,
      reason,
    };
  }
  return { state: "unclear", title: "Status unclear", sentence: "The data source returned this transaction but its status is unclear.", reason: paidSummary ? null : { level: "deepcheck", text: "The status is not clear from the basic investigation. A Deep Investigation can check." } };
}
