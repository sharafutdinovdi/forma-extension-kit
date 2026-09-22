import test from "node:test";
import assert from "node:assert/strict";
import { createPanelChannel } from "../dist/index.js";
import { replaceGlobal } from "./helpers.mjs";

function browser(t, fallback = false) {
  const win = new EventTarget();
  const channels = [];
  const stored = new Map();
  const messages = [];
  win.BroadcastChannel = class {
    constructor(name) {
      if (fallback) throw new Error("BroadcastChannel unavailable");
      this.name = name;
      channels.push(this);
    }
    postMessage(value) {
      messages.push(value);
      for (const channel of channels) {
        // Deliberate self echo tests the sender guard independently of browser behavior.
        if (!channel.closed && channel.name === this.name) channel.onmessage?.({ data: structuredClone(value) });
      }
    }
    close() { this.closed = true; }
  };
  const storageEvent = (key, newValue) => {
    const event = new Event("storage");
    Object.assign(event, { key, newValue });
    win.dispatchEvent(event);
  };
  win.localStorage = {
    setItem(key, value) { stored.set(key, value); storageEvent(key, value); },
    removeItem(key) { stored.delete(key); storageEvent(key, null); },
  };
  replaceGlobal(t, "window", win);
  return { win, channels, stored, messages, storageEvent };
}

for (const fallback of [false, true]) {
  test(`${fallback ? "storage" : "BroadcastChannel"}: own, other-proposal, stale and equal messages are ignored`, t => {
    const { stored } = browser(t, fallback);
    const a = createPanelChannel("shared"), b = createPanelChannel("shared");
    t.after(() => { a.close(); b.close(); });
    const own = [], peer = [];
    a.subscribe("p1", message => own.push(message));
    const unlisten = b.subscribe("p1", message => peer.push(message));
    assert.equal(a.publish({ proposalId: "p1", timestamp: 100, value: { number: 1 } }), true);
    assert.deepEqual(own, []);
    assert.equal(peer.length, 1);
    a.publish({ proposalId: "p2", timestamp: 200, value: 2 });
    assert.equal(peer.length, 1);
    const c = createPanelChannel("shared");
    t.after(() => c.close());
    c.publish({ proposalId: "p1", timestamp: 99, value: "old" });
    c.publish({ proposalId: "p1", timestamp: 100, value: "equal" });
    assert.equal(peer.length, 1);
    c.publish({ proposalId: "p1", timestamp: 101, value: "new" });
    assert.equal(peer.length, 2);
    assert.equal(peer[1].value, "new");
    unlisten();
    c.publish({ proposalId: "p1", timestamp: 102, value: "unsubscribed" });
    assert.equal(peer.length, 2);
    assert.equal(stored.size, 0);
  });
}

test("sender identity independently blocks a newer self-echo", t => {
  const { channels, messages } = browser(t);
  const channel = createPanelChannel("self");
  t.after(() => channel.close());
  let received = 0;
  channel.subscribe("p", () => { received++; });
  channel.publish({ proposalId: "p", timestamp: 1, value: "self" });
  channels[0].onmessage({ data: { ...messages[0], message: { proposalId: "p", timestamp: 2, value: "newer-self" } } });
  assert.equal(received, 0);
});

test("channel names isolate state and close removes listeners and prevents sends", t => {
  const { channels } = browser(t);
  const a = createPanelChannel("a"), b = createPanelChannel("b");
  t.after(() => { a.close(); b.close(); });
  let received = 0;
  b.subscribe("p", () => { received++; });
  a.publish({ proposalId: "p", timestamp: 1, value: 1 });
  assert.equal(received, 0);
  b.close();
  b.close();
  assert.ok(channels[1].closed);
  assert.equal(b.publish({ proposalId: "p", timestamp: 2, value: 2 }), false);
  assert.throws(() => b.subscribe("p", () => {}), /closed/);
});

test("storage ignores malformed envelopes and proposal subscriptions can switch", t => {
  const { storageEvent } = browser(t, true);
  const channel = createPanelChannel("storage");
  t.after(() => channel.close());
  const seen = [];
  const remove = channel.subscribe("p1", message => seen.push(message));
  const send = message => storageEvent("forma-extension-kit:storage", JSON.stringify({ sender: "peer", message }));
  storageEvent("forma-extension-kit:storage", "broken json");
  for (const message of [null, {}, { proposalId: "p1", timestamp: -1, value: 0 }, { proposalId: "p1", timestamp: 1 }]) send(message);
  assert.equal(seen.length, 0);
  remove();
  channel.subscribe("p2", message => seen.push(message));
  send({ proposalId: "p1", timestamp: 2, value: 1 });
  send({ proposalId: "p2", timestamp: 3, value: 2 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].proposalId, "p2");
  channel.close();
  send({ proposalId: "p2", timestamp: 4, value: 3 });
  assert.equal(seen.length, 1);
});

test("blocked transports and Node without window degrade to a false publish result", t => {
  const { win } = browser(t, true);
  win.localStorage.setItem = () => { throw new Error("blocked"); };
  const channel = createPanelChannel("blocked");
  assert.equal(channel.publish({ proposalId: "p", timestamp: 1, value: 1 }), false);
  channel.close();
  replaceGlobal(t, "window", undefined);
  const headless = createPanelChannel("node");
  assert.equal(headless.publish({ proposalId: "p", timestamp: 1, value: 1 }), false);
  headless.close();
});
