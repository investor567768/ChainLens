// Helpers to read a callTracer result and an EVM receipt without guessing.

export function decodeRevertOutput(output) {
  // Standard Solidity Error(string): 0x08c379a0 + abi-encoded string.
  if (typeof output !== "string" || !output.startsWith("0x08c379a0")) return null;
  try {
    const hex = output.slice(10);
    const len = parseInt(hex.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 2000) return null;
    const bytes = hex.slice(128, 128 + len * 2);
    return Buffer.from(bytes, "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "");
  } catch { return null; }
}

export function summarizeTrace(trace) {
  if (!trace || typeof trace !== "object") return null;
  let calls = 0;
  let failing = null;
  (function walk(n, depth) {
    if (!n || typeof n !== "object") return;
    calls++;
    if (n.error && (!failing || depth > failing.depth)) {
      failing = { depth, error: String(n.error), to: n.to || null, selector: typeof n.input === "string" ? n.input.slice(0, 10) : null, output: n.output || null, revertReason: n.revertReason || null };
    }
    if (Array.isArray(n.calls)) n.calls.forEach((c) => walk(c, depth + 1));
  })(trace, 0);
  const reason = failing ? (failing.revertReason || decodeRevertOutput(failing.output)) : null;
  return { calls, topLevelError: trace.error ? String(trace.error) : null, failing: failing ? { error: failing.error, to: failing.to, selector: failing.selector, reason } : null };
}

export function receiptSucceeded(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  if (receipt.status === "0x1" || receipt.status === 1) return true;
  if (receipt.status === "0x0" || receipt.status === 0) return false;
  return null;
}

// Which contracts did the transaction touch, and which calls moved tokens or granted approvals?
// Read straight from the execution trace; nothing is inferred.
const SELECTORS = {
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
  "0x095ea7b3": "approve",
  "0x39509351": "increaseAllowance",
  "0xa22cb465": "setApprovalForAll",
};
const word = (words, i) => (words[i] ? words[i] : null);
const asAddr = (w) => (w ? "0x" + w.slice(24) : null);
const MAX_UNLIMITED = 2n ** 255n;

export function summarizeMovements(trace) {
  if (!trace || typeof trace !== "object") return null;
  const contracts = new Set();
  const calls = [];
  (function walk(n, failedAbove) {
    if (!n || typeof n !== "object") return;
    const failed = failedAbove || !!n.error;
    if (typeof n.to === "string") contracts.add(n.to.toLowerCase());
    const input = typeof n.input === "string" ? n.input : "";
    const kind = SELECTORS[input.slice(0, 10).toLowerCase()];
    if (kind) {
      const w = input.slice(10).match(/.{1,64}/g) || [];
      const row = { kind, token: n.to || null, failed };
      try {
        if (kind === "transfer") { row.recipient = asAddr(word(w, 0)); row.amount = BigInt("0x" + word(w, 1)).toString(); }
        else if (kind === "transferFrom") { row.holder = asAddr(word(w, 0)); row.recipient = asAddr(word(w, 1)); row.amount = BigInt("0x" + word(w, 2)).toString(); }
        else if (kind === "approve" || kind === "increaseAllowance") { row.spender = asAddr(word(w, 0)); const a = BigInt("0x" + word(w, 1)); row.amount = a.toString(); row.unlimited = a >= MAX_UNLIMITED; }
        else if (kind === "setApprovalForAll") { row.spender = asAddr(word(w, 0)); row.unlimited = BigInt("0x" + word(w, 1)) !== 0n; }
        calls.push(row);
      } catch { /* malformed input: skip rather than guess */ }
    }
    if (Array.isArray(n.calls)) n.calls.forEach((c) => walk(c, failed));
  })(trace, false);
  return { contractCount: contracts.size, contracts: [...contracts].slice(0, 10), calls: calls.slice(0, 20) };
}
