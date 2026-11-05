// Small helpers for turning raw chain numbers into readable text.

export function fromUnits(value, decimals = 18, maxDp = 6) {
  if (value === null || value === undefined || value === "") return null;
  let big;
  try { big = BigInt(value); } catch { return null; }
  const neg = big < 0n;
  if (neg) big = -big;
  const base = 10n ** BigInt(decimals);
  const whole = big / base;
  let frac = (big % base).toString().padStart(decimals, "0").slice(0, maxDp);
  frac = frac.replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

export function short(addr) {
  if (!addr || addr.length < 12) return addr || "unknown";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

// Token symbols can be spelled differently by different sources (USDT vs USD₮).
// Compare them on their letters only.
export function normSym(s) {
  return String(s ?? "").replace(/₮/g, "T").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
export const sameSym = (a, b) => normSym(a) !== "" && normSym(a) === normSym(b);

// "a, b and c"
export function joinList(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// "1 step", "3 steps". Never "step(s)".
export function plural(n, one, many) {
  const k = Number(n);
  return `${n} ${k === 1 ? one : (many || one + "s")}`;
}
