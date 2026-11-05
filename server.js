import { providerName } from "./lib/provider.js";
import { plural } from "./lib/format.js";
import { getCeloPrice } from "./lib/price.js";
import { checkPermissions } from "./lib/permissions.js";
import { getPaidPermissions, orderedToday, ORDER_CAP } from "./lib/paid.js";
import { newInvestigationId } from "./lib/evidence.js";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { investigateFree, addPaid } from "./lib/investigate.js";
import { summarizeWallet } from "./lib/wallet.js";
import { readAll } from "./lib/evidence.js";
import { parseAsk } from "./lib/ask.js";
import { getHoldings } from "./lib/holdings.js";
import { logEvent, readEvents, describeFree, describePaid } from "./lib/activity.js";
import { summarizePayments } from "./lib/payments.js";
import { answerFollowUp, FOLLOW_UPS } from "./lib/followups.js";
import { explainChanges } from "./lib/changes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

// Very small per-IP limiter to protect free data sources and (later) the paid budget.
const hits = new Map();
function limited(key, max) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

// Remember free results briefly so the paid step can follow without re-fetching.
const contexts = new Map();
const permChecks = new Map();
function remember(id, ctx) {
  contexts.set(id, ctx);
  setTimeout(() => contexts.delete(id), 30 * 60_000).unref();
}

// A random per-browser ID, so the proof page can show how many different people used the app.
const lookedAt = new Map();
const ordererOf = (url) => { const v = (url.searchParams.get("orderer") || "").trim().toLowerCase(); return /^0x[0-9a-f]{40}$/.test(v) ? v : null; };
async function orderGate(url) {
  const o = ordererOf(url);
  if (!o) return { status: 400, body: { ok: false, needOrderer: true, error: "Enter your wallet address to order a Deep Investigation." } };
  if ((await orderedToday(o)) >= ORDER_CAP) return { status: 429, body: { ok: false, error: `You have used your ${ORDER_CAP} Deep Investigations for today. Try again tomorrow.` } };
  return { orderer: o };
}
const sidOf = (url) => { const v = (url.searchParams.get("sid") || "").trim(); return /^u_[a-z0-9]{6,16}$/.test(v) ? v : null; };

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/investigate") {
      if (limited(req.socket.remoteAddress, 20)) return send(res, 429, { ok: false, error: "Too many requests. Wait a minute." });
      const hash = (url.searchParams.get("hash") || "").trim();
      const free = await investigateFree(hash, {}, { forcePaid: url.searchParams.get("deep") === "1", purpose: url.searchParams.get("purpose") || "", note: url.searchParams.get("note") || "", sessionId: sidOf(url) });
      if (free.ok && free.kind !== "notfound") remember(free.investigationId, { hash, free });
      const ev = describeFree(free); if (ev) await logEvent({ ...ev, sid: sidOf(url), hash: free.hash || hash, address: free.facts?.from || null });
      const { facts, ...publicFree } = free;
      if (free.ok && free.kind !== "notfound") publicFree.followUps = FOLLOW_UPS;
      return send(res, 200, publicFree);
    }
    if (url.pathname === "/api/paid") {
      if (limited(req.socket.remoteAddress + ":paid", 5)) return send(res, 429, { ok: false, error: "Too many Deep Investigations. Wait a minute." });
      const ctx = contexts.get(url.searchParams.get("inv") || "");
      if (!ctx) return send(res, 404, { ok: false, error: "That investigation expired. Run it again." });
      const gate = await orderGate(url); if (!gate.orderer) return send(res, gate.status, gate.body);
      const more = await addPaid(ctx.hash, ctx.free, { orderer: gate.orderer });
      ctx.more = more;
      const ev = describePaid(ctx.hash, more); if (ev) await logEvent({ ...ev, sid: sidOf(url), hash: ctx.hash, orderer: gate.orderer });
      return send(res, 200, { ok: true, ...more });
    }
    if (url.pathname === "/api/wallet") {
      if (limited(req.socket.remoteAddress + ":wallet", 30)) return send(res, 429, { ok: false, error: "Too many requests. Wait a minute." });
      const w = await summarizeWallet((url.searchParams.get("address") || "").trim());
      if (w.ok && url.searchParams.get("look") === "1" && sidOf(url)) {
        const addr = (url.searchParams.get("address") || "").trim().toLowerCase(), key = sidOf(url) + addr, now = Date.now();
        if (/^0x[0-9a-f]{40}$/.test(addr) && !(lookedAt.get(key) > now - 600000)) {
          lookedAt.set(key, now);
          if (lookedAt.size > 5000) lookedAt.clear();
          await logEvent({ type: "lookup", sid: sidOf(url), address: addr, text: `Basic investigation of ${addr.slice(0, 6)}...${addr.slice(-4)}.` });
        }
      }
      const since = (url.searchParams.get("since") || "").trim();
      if (w.ok && since) w.changes = await explainChanges(w, since);
      return send(res, 200, w);
    }
    if (url.pathname === "/api/followup") {
      if (limited(req.socket.remoteAddress + ":followup", 60)) return send(res, 429, { ok: false, error: "Too many requests. Wait a minute." });
      const ctx = contexts.get(url.searchParams.get("inv") || "");
      if (!ctx) return send(res, 404, { ok: false, error: "That investigation expired. Run it again." });
      const autopsy = ctx.more?.autopsy || ctx.free.autopsy;
      return send(res, 200, answerFollowUp(url.searchParams.get("q") || "", { kind: ctx.free.kind, facts: ctx.free.facts, autopsy }));
    }
    if (url.pathname === "/api/ask") {
      if (limited(req.socket.remoteAddress + ":ask", 60)) return send(res, 429, { ok: false, error: "Too many requests. Wait a minute." });
      return send(res, 200, { ok: true, ...parseAsk(url.searchParams.get("q") || "") });
    }
    if (url.pathname === "/api/holdings") {
      if (limited(req.socket.remoteAddress + ":holdings", 30)) return send(res, 429, { ok: false, error: "Too many requests. Wait a minute." });
      return send(res, 200, await getHoldings((url.searchParams.get("address") || "").trim()));
    }
    if (url.pathname === "/api/permissions") {
      if (limited(req.socket.remoteAddress + ":perm", 20)) return send(res, 429, { ok: false, error: "Too many requests. Wait a minute." });
      const a = (url.searchParams.get("address") || "").trim();
      const r = await checkPermissions(a);
      if (r.ok) {
        r.checkId = "pc_" + Math.random().toString(36).slice(2, 10);
        permChecks.set(r.checkId, { address: a, permissions: r.permissions });
        setTimeout(() => permChecks.delete(r.checkId), 30 * 60_000).unref();
        const n = r.permissions.length, who = a.slice(0, 6) + "..." + a.slice(-4); await logEvent({ type: "free", sid: sidOf(url), address: a.toLowerCase(), text: `Basic investigation of the approvals of ${who}: ${n ? plural(n, "active approval") : "no active approvals"} found${r.cancelledCount ? `, ${plural(r.cancelledCount, "earlier one")} already cancelled` : ""}. Nothing was paid.` });
      }
      return send(res, 200, r);
    }
    if (url.pathname === "/api/permissions/verify") {
      if (limited(req.socket.remoteAddress + ":permpaid", 5)) return send(res, 429, { ok: false, error: "Too many Deep Investigations. Wait a minute." });
      const ctx = permChecks.get(url.searchParams.get("check") || "");
      if (!ctx) return send(res, 404, { ok: false, error: "That check expired. Run it again." });
      const gate = await orderGate(url); if (!gate.orderer) return send(res, gate.status, gate.body);
      const r = await getPaidPermissions(ctx.address, ctx.permissions, url.searchParams.get("check"), { sessionId: sidOf(url), orderer: gate.orderer });
      const a = ctx.address;
      if (r.available && !r.reused) { const P = r.permissions, who = a.slice(0, 6) + "..." + a.slice(-4); const result = P.agree === P.checked ? (P.checked === 1 ? "It matched the basic investigation." : "All matched the basic investigation.") : `${P.agree} of ${P.checked} matched the basic investigation${P.differ ? `, ${P.differ} did not` : ""}${P.noAnswer ? `, ${P.noAnswer} got no answer` : ""}.`; await logEvent({ type: "paid", sid: sidOf(url), orderer: gate.orderer, address: a.toLowerCase(), text: `Deep Investigation of the approvals of ${who}: paid ${r.ledger?.amount || "?"} ${r.ledger?.currency || ""} through Buy to ${providerName()}. It re-read ${plural(P.checked, "approval")}. ${result}`.replace("  ", " "), paymentTxHash: r.paymentTxHash || null }); }
      else if (r.available) await logEvent({ type: "reused", sid: sidOf(url), orderer: gate.orderer, address: a.toLowerCase(), text: `Deep Investigation of the approvals of ${a.slice(0, 6)}...${a.slice(-4)}: already checked today. No new charge.` });
      return send(res, 200, { ok: true, ...r });
    }
    if (url.pathname === "/api/price") {
      if (limited(req.socket.remoteAddress + ":price", 30)) return send(res, 429, { ok: false, error: "Too many requests. Wait a minute." });
      return send(res, 200, await getCeloPrice());
    }
    if (url.pathname === "/api/feed") {
      const me = sidOf(url);
      return send(res, 200, { ok: true, events: me ? (await readEvents(1000)).filter((e) => e.sid === me).slice(0, 50) : [] });
    }
    if (url.pathname === "/api/payments") {
      return send(res, 200, { ok: true, ...summarizePayments(await readAll(), await readEvents(1000)) });
    }
    if (url.pathname === "/api/ledger") {
      return send(res, 200, { ok: true, rows: (await readAll()).slice(-50).reverse() });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return send(res, 200, (await readFile(path.join(here, "public", "index.html"), "utf8")).replaceAll("__PROVIDER__", providerName()), "text/html; charset=utf-8");
    }
    const LOGOS = { "/celo-logo.svg": "image/svg+xml", "/celo-logo.png": "image/png" };
    if (LOGOS[url.pathname]) {
      try { return send(res, 200, await readFile(path.join(here, "public", url.pathname.slice(1))), LOGOS[url.pathname]); } catch { return send(res, 404, { ok: false, error: "Not found" }); }
    }
    send(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { ok: false, error: "Something went wrong on our side." });
  }
});

server.listen(PORT, process.env.HOST || "127.0.0.1", () => console.log(`Open http://localhost:${PORT}`));
