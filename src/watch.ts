import { assertRevision, bounded, context, positive, type ReadOptions } from "./internal.js";

export interface WatchOptions extends ReadOptions {
  intervalMs?: number;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

/** Proposal subscription is declared in 0.96; the source fallback polls root/id/paths and defers hidden-view updates. */
export async function watchProposal(
  handler: (rootUrn?: string) => void | Promise<void>,
  options: WatchOptions = {},
): Promise<() => void> {
  const intervalMs = positive(options.intervalMs ?? 4000, "intervalMs");
  const timeoutMs = positive(options.timeoutMs ?? 8000, "timeoutMs");
  const debounceMs = options.debounceMs ?? 600;
  if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 2_147_483_647) throw new RangeError("Invalid debounceMs");
  const ctx = await context(options);
  const { sdk } = ctx;
  const doc = typeof document === "undefined" ? undefined : document;
  let stopped = false, busy = false, dirty = false, acceptingSubscription = true;
  let last: string | undefined, root: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = () => {};
  const report = (error: unknown) => {
    if (!stopped) options.onError?.(error);
  };
  // An error observer must not turn a background task into an unhandled rejection.
  const safelyReport = (error: unknown) => { try { report(error); } catch { /* Observer isolation. */ } };
  const schedule = (nextRoot?: string) => {
    if (stopped) return;
    root = nextRoot;
    dirty = true;
    clearTimeout(timer);
    if (!doc?.hidden) timer = setTimeout(() => {
      timer = undefined;
      if (stopped || doc?.hidden) return;
      dirty = false;
      void bounded(async () => { await handler(root); }, timeoutMs, "proposal handler").catch(safelyReport);
    }, debounceMs);
  };
  const poll = async () => {
    if (stopped || busy || doc?.hidden) return;
    busy = true;
    try {
      const fingerprint = await bounded(async () => {
        const [rootUrn, proposalId] = await Promise.all([sdk.proposal.getRootUrn(), sdk.proposal.getId()]);
        const [sites, buildings] = await Promise.all([
          sdk.geometry.getPathsByCategory({ category: "site_limit", urn: rootUrn }),
          sdk.geometry.getPathsByCategory({ category: "building", urn: rootUrn }),
        ]);
        await assertRevision(ctx, { rootUrn, proposalId });
        return JSON.stringify([proposalId, rootUrn, [...sites].sort(), [...buildings].sort()]);
      }, timeoutMs, "proposal fingerprint");
      if (stopped) return;
      if (last !== undefined && last !== fingerprint) schedule();
      last = fingerprint;
    } catch (error) { safelyReport(error); }
    finally { busy = false; }
  };
  const visible = () => {
    if (doc?.hidden) clearTimeout(timer);
    else if (dirty) schedule(root);
    else if (interval) void poll();
  };
  try {
    if (!sdk.proposal.subscribe) throw new Error("proposal.subscribe is unavailable; using fingerprint polling");
    const subscription = await bounded(() => sdk.proposal.subscribe!(payload => {
      if (acceptingSubscription) schedule(payload.rootUrn);
    }, { debouncedPersistedOnly: true }).then(value => {
      if (!acceptingSubscription) value.unsubscribe();
      return value;
    }), timeoutMs, "proposal.subscribe");
    unsubscribe = () => subscription.unsubscribe();
  } catch (error) {
    acceptingSubscription = false;
    clearTimeout(timer);
    dirty = false;
    safelyReport(error);
    void poll();
    interval = setInterval(() => { void poll(); }, intervalMs);
  }
  doc?.addEventListener("visibilitychange", visible);
  return () => {
    if (stopped) return;
    stopped = true;
    acceptingSubscription = false;
    clearTimeout(timer);
    clearInterval(interval);
    doc?.removeEventListener("visibilitychange", visible);
    try { unsubscribe(); } catch (error) {
      try { options.onError?.(error); } catch { /* Observer isolation. */ }
    }
  };
}
