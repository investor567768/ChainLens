// Turns what someone typed into what to do. Fixed rules, no AI: it can only find a hash or an
// address in the text, and read a few plain keywords. If it cannot tell, it says so.

const HASH = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const ADDR = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const ANY_HEX = /0x[0-9a-fA-F]{8,}/;

const HELP = 'Paste a transaction hash (0x and 64 characters) or a wallet address (0x and 40 characters). You can add a question, for example: "why did this fail? 0x..."';

export function parseAsk(text) {
  const t = String(text ?? "").slice(0, 600);
  const low = t.toLowerCase();
  const deep = /\b(deep|verify|double.?check|independent|second opinion|make sure)\b/.test(low);
  let purpose = "";
  if (/\b(fail|failed|failing|revert|reverted|error|rejected|didn.?t go through)\b/.test(low)) purpose = "failed";
  else if (/\b(stuck|pending|waiting|slow|not confirmed|hasn.?t confirmed)\b/.test(low)) purpose = "pending";
  else if (/\b(approv\w*|allowance|permission|unexpected|suspicious)\b/.test(low)) purpose = "movements";

  const hash = t.match(HASH)?.[0];
  if (hash) {
    const bits = ["I read this as a transaction hash."];
    if (purpose || deep) bits.push(deep ? "You asked for a deeper check, so a Deep Investigation will run." : "If the basic investigation is not enough, ChainLens will offer a Deep Investigation. It only runs when you ask.");
    return { kind: "tx", hash, purpose, deep, understood: bits.join(" ") };
  }
  const address = t.match(ADDR)?.[0];
  if (address && /\b(approv\w*|allowance|permission\w*|spend\w*|revoke)\b/.test(low)) {
    return { kind: "permissions", address, purpose: "", deep: false, understood: "I read this as a wallet address and a question about approvals. Opening the Approvals tab." };
  }
  if (address) {
    return { kind: "wallet", address, purpose, deep: false, understood: "I read this as a wallet address. Here is what it holds and what it has done recently." };
  }
  if (ANY_HEX.test(t)) {
    return { kind: "invalid", understood: "That looks like a hash or an address, but the length is wrong. A transaction hash has 64 characters after 0x and a wallet address has 40. Check that it was copied in full." };
  }
  return { kind: "unknown", understood: HELP };
}
