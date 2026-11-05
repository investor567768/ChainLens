// The explorer may give a failure reason as text, as an object, or as raw hex.
// Turn it into readable text, or say honestly that it is not readable. Never print an object.
import { decodeRevertOutput } from "./trace.js";

const clean = (s) => String(s).replace(/[^\x20-\x7e]/g, "").trim().slice(0, 200);

export function readableReason(rr) {
  const none = { text: null, unreadable: false, raw: null };
  if (rr === null || rr === undefined || rr === "") return none;
  const unreadable = (raw = null) => ({ text: null, unreadable: true, raw: typeof raw === "string" ? raw.slice(0, 200) : null });

  const fromHex = (h) => { const d = decodeRevertOutput(h); const c = d ? clean(d) : ""; return c ? { text: c, unreadable: false, raw: null } : null; };

  if (typeof rr === "string") {
    const t = rr.trim();
    if (!t) return none;
    if (/^0x[0-9a-fA-F]*$/.test(t)) return fromHex(t) || unreadable(t);
    const c = clean(t);
    return c ? { text: c, unreadable: false, raw: null } : unreadable();
  }
  if (typeof rr === "object") {
    for (const k of ["message", "reason", "title", "description"]) {
      if (typeof rr[k] === "string" && clean(rr[k])) return { text: clean(rr[k]), unreadable: false, raw: null };
    }
    const params = Array.isArray(rr.parameters) ? rr.parameters : Array.isArray(rr.decoded?.parameters) ? rr.decoded.parameters : null;
    if (params) {
      const p = params.find((x) => typeof x?.value === "string" && clean(x.value));
      if (p) return { text: clean(p.value), unreadable: false, raw: null };
    }
    if (typeof rr.decoded === "string" && clean(rr.decoded)) return { text: clean(rr.decoded), unreadable: false, raw: null };
    const raw = typeof rr.raw === "string" ? rr.raw : typeof rr.hex === "string" ? rr.hex : null;
    if (raw && /^0x[0-9a-fA-F]+$/.test(raw)) return fromHex(raw) || unreadable(raw);
    return unreadable(raw);
  }
  return unreadable();
}
