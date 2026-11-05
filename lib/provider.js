// The name of the independent provider, taken from the Buy route so the wording can never
// disagree with what is actually paid. Default route: .../chainstack/celo -> "Chainstack".
export function providerName(route = process.env.BUY_ROUTE || "https://gateway.usebuy.ai/chainstack/celo") {
  try {
    const seg = new URL(route).pathname.split("/").filter(Boolean)[0] || "";
    if (/^[a-z0-9-]{2,30}$/i.test(seg)) return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
  } catch { /* fall through */ }
  return "an independent provider";
}
export const viaBuy = () => `${providerName()}, through Buy`;
