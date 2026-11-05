import test from "node:test";
import assert from "node:assert/strict";
import { buildPrice, priceText, getCeloPrice } from "../lib/price.js";

const chart = { chart_data: [
  { date: "2026-10-01", closing_price: "0.10" }, { date: "2026-10-02", closing_price: "0.12" },
  { date: "2026-10-03", closing_price: "0.11" }, { date: "2026-10-04", closing_price: "0.11" } ] };

test("price: up/down from 24h change and daily bars", () => {
  const r = buildPrice({ coin_price: "0.1234", coin_price_change_percentage: -2.345 }, chart);
  assert.equal(r.ok, true);
  assert.equal(r.direction, "down");
  assert.equal(r.changePct, -2.35);
  assert.deepEqual(r.days.map((d) => d.dir), ["up", "down", "flat"]);
  const u = buildPrice({ coin_price: "0.2", coin_price_change_percentage: "1.5" }, null);
  assert.equal(u.direction, "up"); assert.deepEqual(u.days, []);
});
test("price: missing price is a graceful failure", () => {
  assert.equal(buildPrice({}, chart).ok, false);
  assert.equal(buildPrice(null, null).ok, false);
});
test("price: formatting", () => {
  assert.equal(priceText(0.1234), "$0.1234");
  assert.equal(priceText(1.5), "$1.50");
});
test("price: fetch failure returns not ok", async () => {
  process.env.CHAINLENS_NO_CACHE = "1";
  const r = await getCeloPrice({ fetch: async () => { throw new Error("x"); } });
  assert.equal(r.ok, false);
});

test("price: one failed refresh keeps the last good price for a while, then gives up", async () => {
  process.env.CHAINLENS_NO_CACHE = "1";
  const good = async (u) => ({ ok: true, json: async () => (String(u).endsWith("/stats") ? { coin_price: "0.07", coin_price_change_percentage: 1 } : { chart_data: [] }) });
  const a = await getCeloPrice({ fetch: good, retryMs: 0 });
  assert.equal(a.ok, true);
  const b = await getCeloPrice({ fetch: async () => { throw new Error("down"); }, retryMs: 0 });
  assert.equal(b.ok, true); assert.equal(b.stale, true); assert.equal(b.priceText, a.priceText);
});
