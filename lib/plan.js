// What the paid check should ask for, depending on WHY the user wants independent proof.
// Everything here is a standard JSON-RPC read. One payment covers the whole batch.

export const PURPOSES = {
  failed:    "Why did it fail?",
  pending:   "Why is it stuck?",
  movements: "Check unexpected token movements",
  verify:    "Get more detailed verification",
  other:     "Other (a note you wrote)",
  research:  "Everything (internal)",
};
// Reasons offered to the user. "research" stays internal.
export const OFFERED_PURPOSES = ["failed", "pending", "movements", "verify", "other"];

export function defaultPurpose(kind) {
  return kind === "failed" ? "failed" : kind === "pending" ? "pending" : "verify";
}

const SEL = { transfer: "0xa9059cbb", transferFrom: "0x23b872dd", balanceOf: "0x70a08231", allowance: "0xdd62ed3e", decimals: "0x313ce567" };
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const pad = (hexNo0x) => hexNo0x.toLowerCase().padStart(64, "0");
const addrWord = (a) => pad(a.replace(/^0x/, ""));

// Read a standard ERC-20 transfer / transferFrom out of the raw input. Returns null if it is anything else.
export function decodeErc20Call(facts) {
  const input = facts?.input;
  if (typeof input !== "string" || !facts.to || !facts.from) return null;
  const sel = input.slice(0, 10).toLowerCase();
  const words = input.slice(10).match(/.{1,64}/g) || [];
  try {
    if (sel === SEL.transfer && words.length >= 2) return { kind: "transfer", token: facts.to, holder: facts.from, spender: null, recipient: "0x" + words[0].slice(24), amount: BigInt("0x" + words[1]) };
    if (sel === SEL.transferFrom && words.length >= 3) return { kind: "transferFrom", token: facts.to, holder: "0x" + words[0].slice(24), spender: facts.from, recipient: "0x" + words[1].slice(24), amount: BigInt("0x" + words[2]) };
  } catch { /* fall through */ }
  return null;
}

export function planCalls(hash, facts, purpose) {
  const calls = [
    { id: 1, role: "tx", method: "eth_getTransactionByHash", params: [hash] },
    { id: 2, role: "receipt", method: "eth_getTransactionReceipt", params: [hash] },
    { id: 3, role: "trace", method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] },
  ];
  const wantFailed = ["failed", "research"].includes(purpose);
  const wantPending = ["pending", "research"].includes(purpose);

  if (wantFailed && facts?.status === "error" && facts.block != null) {
    const d = decodeErc20Call(facts);
    if (d) {
      const tag = "0x" + (Number(facts.block) - 1).toString(16);
      const call = (data) => ({ to: d.token, data });
      calls.push({ id: 4, role: "balance", method: "eth_call", params: [call(SEL.balanceOf + addrWord(d.holder)), tag] });
      calls.push({ id: 5, role: "decimals", method: "eth_call", params: [call(SEL.decimals), tag] });
      if (d.kind === "transferFrom") calls.push({ id: 6, role: "allowance", method: "eth_call", params: [call(SEL.allowance + addrWord(d.holder) + addrWord(d.spender)), tag] });
    }
  }
  if (wantPending && facts && facts.block == null && facts.status == null && facts.from) {
    calls.push({ id: 7, role: "nonceLatest", method: "eth_getTransactionCount", params: [facts.from, "latest"] });
    calls.push({ id: 8, role: "noncePending", method: "eth_getTransactionCount", params: [facts.from, "pending"] });
    calls.push({ id: 9, role: "gasPrice", method: "eth_gasPrice", params: [] });
  }
  return calls;
}

const toBig = (h) => { try { return typeof h === "string" && /^0x[0-9a-fA-F]+$/.test(h) ? BigInt(h) : null; } catch { return null; } };

// Turn raw answers into structured, checkable facts. Missing or failed calls simply give null.
export function analyzeEvidence(facts, plan, byId) {
  const res = (role) => { const c = plan.find((p) => p.role === role); const r = c && byId[String(c.id)]; return r && !r.error ? r.result : null; };
  const out = {};
  const d = decodeErc20Call(facts);

  const bal = toBig(res("balance"));
  if (d && bal !== null) {
    const dec = toBig(res("decimals"));
    out.balance = { holder: d.holder, token: d.token, balance: bal.toString(), amount: d.amount.toString(), decimals: dec === null ? null : Number(dec), enough: bal >= d.amount, atBlock: Number(facts.block) - 1 };
    const al = toBig(res("allowance"));
    if (d.kind === "transferFrom" && al !== null) out.allowance = { allowance: al.toString(), amount: d.amount.toString(), enough: al >= d.amount };
  }

  const latest = toBig(res("nonceLatest")), pend = toBig(res("noncePending")), gp = toBig(res("gasPrice"));
  if (latest !== null && pend !== null && facts?.nonce != null) {
    const txn = BigInt(facts.nonce);
    out.nonce = { txNonce: txn.toString(), latest: latest.toString(), pending: pend.toString(), earlierUnconfirmed: txn > latest ? (txn - latest).toString() : "0", alreadyUsed: txn < latest };
  }
  if (gp !== null && facts?.gasPrice != null) {
    try { const off = BigInt(facts.gasPrice); out.gas = { offered: off.toString(), network: gp.toString(), belowNetwork: off < gp }; } catch { /* ignore */ }
  }

  const receipt = res("receipt");
  if (receipt && Array.isArray(receipt.logs) && Array.isArray(facts?.transfers)) {
    const erc20Logs = receipt.logs.filter((l) => l.topics && l.topics[0] === ERC20_TRANSFER_TOPIC && l.topics.length === 3).length;
    const explorer = facts.transfers.filter((t) => !t.type || t.type === "ERC-20").length;
    out.logs = { receiptTransferLogs: erc20Logs, explorerTransfers: explorer, agree: erc20Logs === explorer };
  }
  return out;
}
