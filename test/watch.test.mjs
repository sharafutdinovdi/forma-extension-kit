import test from "node:test";
import assert from "node:assert/strict";
import { watchProposal } from "../dist/index.js";
import { fixture, replaceGlobal, until, wait } from "./helpers.mjs";

function visibility(t) {
  const doc = new EventTarget();
  doc.hidden = false;
  replaceGlobal(t, "document", doc);
  return hidden => { doc.hidden = hidden; doc.dispatchEvent(new Event("visibilitychange")); };
}

test("fingerprint ignores unchanged or reordered paths and detects revision/id/path changes", async t => {
  visibility(t);
  const { sdk } = fixture();
  let root = "root-r1", id = "p1", paths = ["root/a", "root/b"], reads = 0, changes = 0;
  sdk.proposal.getRootUrn = async () => root;
  sdk.proposal.getId = async () => id;
  sdk.geometry.getPathsByCategory = async ({ category }) => {
    if (category === "building") { reads++; return paths; }
    return [];
  };
  const stop = await watchProposal(() => { changes++; }, { sdk, intervalMs: 10, debounceMs: 0 });
  t.after(stop);
  await until(() => reads >= 3);
  assert.equal(changes, 0);
  paths = [...paths].reverse();
  await wait(40);
  assert.equal(changes, 0);
  root = "root-r2";
  await until(() => changes === 1);
  id = "p2";
  await until(() => changes === 2);
  paths = ["root/c"];
  await until(() => changes === 3);
  stop();
  await wait(20);
  const stoppedReads = reads;
  await wait(30);
  assert.equal(reads, stoppedReads);
});

test("fingerprint polling pauses while document.hidden and checks immediately when visible", async t => {
  const hide = visibility(t);
  const { sdk } = fixture();
  let root = "r1", reads = 0, changes = 0;
  sdk.proposal.getRootUrn = async () => { reads++; return root; };
  const stop = await watchProposal(() => { changes++; }, { sdk, intervalMs: 10, debounceMs: 0 });
  t.after(stop);
  await until(() => reads >= 4);
  hide(true);
  await wait(20);
  const hiddenReads = reads;
  root = "r2";
  await wait(40);
  assert.equal(reads, hiddenReads);
  assert.equal(changes, 0);
  hide(false);
  await until(() => changes === 1);
});

test("subscription is preferred, debounced, deferred while hidden and unsubscribed once", async t => {
  const hide = visibility(t);
  const { sdk } = fixture();
  let emit, unsubscribed = 0;
  const seen = [];
  sdk.proposal.subscribe = async (callback, options) => {
    assert.deepEqual(options, { debouncedPersistedOnly: true });
    emit = callback;
    return { unsubscribe() { unsubscribed++; } };
  };
  sdk.geometry.getPathsByCategory = async () => { assert.fail("subscription must not poll"); };
  const stop = await watchProposal(root => { seen.push(root); }, { sdk, debounceMs: 10 });
  t.after(stop);
  emit({ rootUrn: "r1" });
  emit({ rootUrn: "r2" });
  await until(() => seen.length === 1);
  assert.deepEqual(seen, ["r2"]);
  emit({ rootUrn: "r3" });
  hide(true);
  await wait(30);
  assert.equal(seen.length, 1);
  hide(false);
  await until(() => seen.length === 2);
  assert.equal(seen[1], "r3");
  stop();
  stop();
  emit({ rootUrn: "r4" });
  await wait(20);
  assert.equal(seen.length, 2);
  assert.equal(unsubscribed, 1);
});

test("rejected subscription falls back to polling and reports the error", async t => {
  visibility(t);
  const { sdk } = fixture();
  const errors = [];
  let reads = 0;
  sdk.proposal.subscribe = async () => { throw new Error("host rejected subscription"); };
  sdk.geometry.getPathsByCategory = async () => { reads++; return []; };
  const stop = await watchProposal(() => {}, { sdk, intervalMs: 10, onError: error => errors.push(error.message) });
  t.after(stop);
  await until(() => reads >= 2);
  assert.match(errors[0], /host rejected/);
});

test("subscription timeout falls back and disposes a late subscription without accepting its callbacks", async t => {
  visibility(t);
  const { sdk } = fixture();
  let resolve, emit, disposed = 0, changes = 0;
  const errors = [];
  sdk.proposal.subscribe = callback => {
    emit = callback;
    return new Promise(done => { resolve = done; });
  };
  const stop = await watchProposal(() => { changes++; }, {
    sdk, timeoutMs: 10, intervalMs: 10, debounceMs: 0, onError: error => errors.push(error.message),
  });
  t.after(stop);
  assert.match(errors[0], /proposal.subscribe timed out/);
  resolve({ unsubscribe() { disposed++; } });
  emit({ rootUrn: "late" });
  await until(() => disposed === 1);
  await wait(30);
  assert.equal(changes, 0);
});

test("a hung fingerprint does not lock polling forever; rejected handlers are observed", async t => {
  visibility(t);
  const { sdk } = fixture();
  let reads = 0, root = "r1";
  const errors = [];
  sdk.proposal.getRootUrn = () => ++reads === 1 ? new Promise(() => {}) : Promise.resolve(root);
  const stop = await watchProposal(async () => { throw new Error("handler rejected"); }, {
    sdk, timeoutMs: 10, intervalMs: 15, debounceMs: 0, onError: error => errors.push(error.message),
  });
  t.after(stop);
  await until(() => reads >= 5);
  assert.ok(errors.some(error => /fingerprint timed out/.test(error)));
  root = "r2";
  await until(() => errors.includes("handler rejected"));
});

test("watch options reject unbounded timer values", async () => {
  const { sdk } = fixture();
  for (const options of [{ intervalMs: 0 }, { timeoutMs: Infinity }, { debounceMs: -1 }]) {
    await assert.rejects(watchProposal(() => {}, { sdk, ...options }), RangeError);
  }
});
