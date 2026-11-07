// Builds /proof.md from the live payment records, so it is always current and never hand-edited.
const short = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "not recorded");
const day = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") + " UTC" : "");

export function proofMarkdown(pay, agentWallet, provider) {
  const t = pay.totals || {};
  const rows = (pay.list || pay.calls || pay.payments || []).filter((r) => r.paymentTxHash);
  const lines = [];
  lines.push("# ChainLens: proof of payment and services used", "");
  lines.push("ChainLens is a read-only assistant for Celo. It explains transactions and approvals in plain language. When a person presses **Deep Investigation**, ChainLens pays for extra data itself, through Buy. The person pays nothing.", "");
  lines.push("## Services used", "");
  lines.push(`- **Buy** (Celo): the agent pays through Buy using x402.`);
  lines.push(`- **${provider || "Chainstack"}**: the paid data provider, reached through Buy's gateway (https://gateway.usebuy.ai/chainstack/celo).`);
  lines.push("- **Celo**: the chain being explained, and where every payment settles.", "");
  lines.push("## Who pays", "");
  lines.push(`- Paying agent wallet: [\`${agentWallet}\`](https://celoscan.io/address/${agentWallet})`);
  lines.push("- ERC-8004 agent identity: #10027", "");
  lines.push("## Totals (live)", "");
  lines.push(`- Deep Investigations paid for: ${t.paidCalls ?? 0}`);
  lines.push(`- Total paid: ${t.totalPaid ?? 0} ${t.currency || "USDT"}`);
  lines.push(`- From other people: ${t.fromOthers ?? 0}`);
  lines.push(`- Builder tests (made by the builder while testing): ${t.builderTests ?? 0}`);
  lines.push(`- Different people who ordered (builder tests are not counted): ${t.usersWhoOrdered ?? 0}`, "");
  lines.push("## Payments", "");
  if (!rows.length) lines.push("No payments yet.");
  else {
    lines.push("| Date | Investigated | Ordered by | Amount | Proof |", "|---|---|---|---|---|");
    for (const r of rows) {
      const what = r.tx ? `tx ${short(r.tx)}` : r.address ? `wallet ${short(r.address)}` : "";
      lines.push(`| ${day(r.at)} | ${what} | ${short(r.orderer)}${r.builderTest ? " (builder test)" : ""} | ${r.amount || ""} ${r.currency || ""} | [Celoscan](https://celoscan.io/tx/${r.paymentTxHash}) |`);
    }
  }
  lines.push("", "## Honest notes", "");
  lines.push("- The ordering wallet is typed in by the person. It is not signed or verified. It is only used to count different people.");
  lines.push("- Payments marked builder test were made by the builder while testing. They are real payments, shown openly, and are not counted as independent users.");
  lines.push("- Each payment link shows the payment on Celoscan. It shows the payment to Buy's gateway; it does not by itself show which provider answered.", "");
  return lines.join("\n");
}
