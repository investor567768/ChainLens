import test from "node:test";
import assert from "node:assert/strict";
import { summarizeUsers } from "../lib/payments.js";

const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222";

test("users: counts visitors, wallets, orders and people who came back", () => {
  const ev = [
    { at: "2026-11-05T09:00:00Z", sid: "u_aaaaaa", type: "lookup", address: A },
    { at: "2026-11-05T09:05:00Z", sid: "u_aaaaaa", type: "paid", address: A, text: "x" },
    { at: "2026-11-06T09:00:00Z", sid: "u_aaaaaa", type: "reused", address: A },
    { at: "2026-11-05T10:00:00Z", sid: "u_bbbbbb", type: "free", hash: "0xabc", address: B },
    { at: "2026-11-05T10:01:00Z", sid: "u_bbbbbb", type: "unavailable", hash: "0xabc" },
    { at: "2026-11-05T10:02:00Z", type: "free", address: A },
  ];
  const u = summarizeUsers(ev, { ignore: "" });
  assert.equal(u.totals.visitors, 2);
  assert.equal(u.totals.returning, 1);
  assert.equal(u.totals.wallets, 2);
  assert.equal(u.totals.orders, 3);
  assert.equal(u.totals.paid, 1);
  assert.equal(u.totals.reused, 1);
  assert.equal(u.totals.notDone, 1);
  assert.equal(u.people[0].id, "u_aaaaaa");
  assert.deepEqual(u.people[0].wallets, [A]);
});

test("users: a transaction hash is matched to the sender found when it was first looked up", () => {
  const u = summarizeUsers([
    { at: "2026-11-05T09:00:00Z", sid: "u_cccccc", type: "free", hash: "0xdef", address: A },
    { at: "2026-11-05T09:01:00Z", sid: "u_cccccc", type: "paid", hash: "0xdef" },
  ], { ignore: "" });
  assert.deepEqual(u.people[0].wallets, [A]);
  assert.equal(u.people[0].orders, 1);
});

test("users: our own browsers can be left out", () => {
  const u = summarizeUsers([{ at: "2026-11-05T09:00:00Z", sid: "u_owner1", type: "lookup", address: A }, { at: "2026-11-05T09:00:00Z", sid: "u_other1", type: "lookup", address: B }], { ignore: "u_owner1" });
  assert.equal(u.totals.visitors, 1);
  assert.equal(u.totals.wallets, 1);
});

test("users: empty log gives zeros, not an error", () => {
  const u = summarizeUsers([], { ignore: "" });
  assert.equal(u.totals.visitors, 0);
  assert.deepEqual(u.people, []);
});

import { summarizePayments } from "../lib/payments.js";
test("payments page: successful Deep Investigations only, with who ordered them", () => {
  const O = "0x" + "a".repeat(40);
  const rows = [
    { kind: "paid-call", status: "ok", at: "t1", tx: "0x1", amount: "0.01", currency: "USDT", orderer: O, paymentTxHash: "0x9" },
    { kind: "paid-call", status: "paid-but-failed", at: "t2", tx: "0x2", amount: "0.01", currency: "USDT", orderer: O },
    { kind: "paid-call", status: "ok", at: "t3", tx: "0x3", amount: "0.01", currency: "USDT", orderer: "0x" + "b".repeat(40) },
  ];
  const s = summarizePayments(rows, []);
  assert.equal(s.totals.ordered, 2); assert.equal(s.totals.usersWhoOrdered, 2); assert.equal(s.totals.totalPaid, 0.02);
  assert.equal(s.calls.length, 2); assert.equal(s.calls[1].orderer, O);
});
