// CELO price strip: today's price, whether it is up or down over 24 hours, and one small bar per day
// for the last 14 days (green = closed higher than the day before, red = lower).
// Source: the same free Celo explorer data the rest of the app uses. Context only: it never explains a transaction.
const EXPLORER = () => process.env.BLOCKSCOUT_BASE || "https://celo.blockscout.com/api/v2";
let cache = null;
// Daily candles (open, high, low, close) from Binance public market data. No key. If it is unreachable the chart falls back to the explorer closes.
const KLINES = ["https://api.binance.com/api/v3/klines?symbol=CELOUSDT&interval=1d&limit=14", "https://data-api.binance.vision/api/v3/klines?symbol=CELOUSDT&interval=1d&limit=14"];

async function getJson(url, f, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

const num = (x) => { const n = typeof x === "string" ? Number(x) : x; return Number.isFinite(n) ? n : null; };

export function priceText(p) {
  if (p == null) return null;
  const s = p >= 1 ? p.toFixed(2) : p.toFixed(4).replace(/0+$/, "");
  return "$" + (/\.\d{2}$/.test(s) || p >= 1 ? s : s + "0".repeat(Math.max(0, 3 - (s.split(".")[1] || "").length)));
}

export function parseKlines(k) {
  if (!Array.isArray(k)) return null;
  const out = k.map((r) => ({ date: new Date(Number(r[0])).toISOString().slice(0, 10), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]) })).filter((c) => c.open != null && c.high != null && c.low != null && c.close != null);
  return out.length ? out.slice(-14) : null;
}

export function buildPrice(stats, chart, now = new Date(), klines = null) {
  const price = num(stats && stats.coin_price);
  if (price == null) return { ok: false, error: "The explorer did not return a CELO price right now." };
  const changePct = num(stats.coin_price_change_percentage);
  const direction = changePct == null ? null : changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";
  const raw = Array.isArray(chart && chart.chart_data) ? chart.chart_data : [];
  const closes = raw.map((d) => ({ date: String(d.date || ""), close: num(d.closing_price) })).filter((d) => d.date && d.close != null)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-15);
  const days = closes.slice(1).map((d, i) => ({ date: d.date, close: d.close, dir: d.close > closes[i].close ? "up" : d.close < closes[i].close ? "down" : "flat" }));
  return { ok: true, candles: klines || null, price, priceText: priceText(price), firstOpen: closes.length ? closes[0].close : null, changePct: changePct == null ? null : Math.round(changePct * 100) / 100, direction, days, asOf: now.toISOString(), source: "the Celo explorer" };
}

let lastGood = null;
const STALE_OK_MS = 3 * 60 * 60 * 1000;

async function fetchOnce(f) {
  const [stats, chart, k1] = await Promise.all([getJson(EXPLORER() + "/stats", f), getJson(EXPLORER() + "/stats/charts/market", f), getJson(KLINES[0], f, 6000)]);
  let k = parseKlines(k1);
  if (!k) k = parseKlines(await getJson(KLINES[1], f, 6000));
  return stats ? buildPrice(stats, chart, new Date(), k) : { ok: false, error: "The explorer did not answer right now." };
}

export async function getCeloPrice(deps = {}) {
  const f = deps.fetch || fetch;
  if (!process.env.CHAINLENS_NO_CACHE && cache && Date.now() - cache.at < 60000) return cache.value;
  let value = await fetchOnce(f);
  if (!value.ok) { await new Promise((r) => setTimeout(r, deps.retryMs ?? 800)); value = await fetchOnce(f); }
  if (value.ok) { cache = { at: Date.now(), value }; lastGood = cache; return value; }
  // One failed refresh should not make the strip disappear. Keep showing the last good price for a few hours.
  if (lastGood && Date.now() - lastGood.at < STALE_OK_MS) return { ...lastGood.value, stale: true };
  return value;
}
