export interface PanelMessage<T> {
  proposalId: string;
  timestamp: number;
  value: T;
}

export interface PanelChannel<T> {
  /** Returns false if closed or neither browser transport can send. */
  publish(message: PanelMessage<T>): boolean;
  /** Proposal scope is explicit; unsubscribe/resubscribe when the active proposal changes. */
  subscribe(proposalId: string, handler: (message: PanelMessage<T>) => void): () => void;
  close(): void;
}

/** Source panels share proposal-scoped, newer state through BroadcastChannel or transient storage events. */
export function createPanelChannel<T = unknown>(name: string): PanelChannel<T> {
  if (!name.trim()) throw new Error("Channel name must not be empty");
  const win = typeof window === "undefined" ? undefined : window;
  const sender = globalThis.crypto?.randomUUID() ?? `${Date.now()}-${Math.random()}`;
  const key = `forma-extension-kit:${name}`;
  const listeners = new Map<(message: PanelMessage<T>) => void, string>();
  const latest = new Map<string, number>();
  let closed = false;
  let channel: BroadcastChannel | undefined;
  const valid = (value: unknown): value is PanelMessage<T> => {
    if (!value || typeof value !== "object") return false;
    const m = value as PanelMessage<T>;
    return typeof m.proposalId === "string" && m.proposalId.length > 0 &&
      Number.isFinite(m.timestamp) && m.timestamp > 0 && Object.hasOwn(m, "value");
  };
  const accept = (value: unknown) => {
    if (closed || !value || typeof value !== "object") return;
    const envelope = value as { sender?: unknown; message?: unknown };
    if (typeof envelope.sender !== "string" || envelope.sender === sender || !valid(envelope.message)) return;
    const message = envelope.message;
    if (![...listeners.values()].includes(message.proposalId) || message.timestamp <= (latest.get(message.proposalId) ?? -Infinity)) return;
    latest.set(message.proposalId, message.timestamp);
    for (const [handler, proposalId] of listeners) if (proposalId === message.proposalId) handler(message);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key || !event.newValue) return;
    let value: unknown;
    try { value = JSON.parse(event.newValue); } catch { return; }
    accept(value);
  };
  try { if (win) channel = new win.BroadcastChannel(key); } catch { /* Storage fallback. */ }
  if (channel) channel.onmessage = event => accept(event.data);
  else win?.addEventListener("storage", onStorage);
  return {
    publish(message) {
      if (closed) return false;
      if (!valid(message)) throw new TypeError("Expected proposalId, positive finite timestamp and value");
      if (message.timestamp <= (latest.get(message.proposalId) ?? -Infinity)) return false;
      const envelope = { sender, message };
      try {
        if (channel) channel.postMessage(envelope);
        else if (win) {
          win.localStorage.setItem(key, JSON.stringify(envelope));
          win.localStorage.removeItem(key);
        } else return false;
        latest.set(message.proposalId, message.timestamp);
        return true;
      } catch { return false; }
    },
    subscribe(proposalId, handler) {
      if (closed) throw new Error("Channel is closed");
      if (!proposalId) throw new Error("Proposal id must not be empty");
      const listener = (message: PanelMessage<T>) => handler(message);
      listeners.set(listener, proposalId);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (closed) return;
      closed = true;
      channel?.close();
      win?.removeEventListener("storage", onStorage);
      listeners.clear();
      latest.clear();
    },
  };
}
