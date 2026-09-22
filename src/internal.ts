import type { Forma } from "forma-embedded-view-sdk/auto";

export type HostSdk = {
  proposal: Pick<typeof Forma.proposal, "awaitProposalPersisted" | "getRootUrn" | "getId"> &
    Partial<Pick<typeof Forma.proposal, "subscribe">>;
  elements: Pick<typeof Forma.elements, "get" | "getByPath" | "getWorldTransform"> & {
    representations: Pick<typeof Forma.elements.representations, "graphBuilding" | "grossFloorAreaPolygons">;
  };
  geometry: Pick<typeof Forma.geometry, "getPathsByCategory" | "getFootprint" | "getTriangles">;
};

export interface ReadOptions {
  /** Defaults to the lazily loaded Forma singleton; injectable for synthetic tests. */
  sdk?: HostSdk;
  /** Per-request deadline, including SDK loading; defaults to 8000 ms. */
  timeoutMs?: number;
}

export type RootTree = Awaited<ReturnType<HostSdk["elements"]["get"]>>;
export type RootUrn = Awaited<ReturnType<HostSdk["proposal"]["getRootUrn"]>>;

export function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be positive and at most 2147483647`);
  }
  return value;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

export async function bounded<T>(read: () => Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function context(options: ReadOptions) {
  const timeoutMs = positive(options.timeoutMs ?? 8000, "timeoutMs");
  const request = <T>(operation: string, read: () => Promise<T>) => bounded(read, timeoutMs, operation);
  const sdk = options.sdk ?? await request("SDK loading", async () => {
    if (typeof window === "undefined") throw new Error("Forma reads require a browser host or options.sdk");
    return (await import("forma-embedded-view-sdk/auto")).Forma;
  });
  return { sdk, request };
}

export async function assertRevision(
  ctx: Awaited<ReturnType<typeof context>>,
  snapshot: { rootUrn: string; proposalId: string },
): Promise<void> {
  const [root, id] = await Promise.all([
    ctx.request("proposal.getRootUrn", () => ctx.sdk.proposal.getRootUrn()),
    ctx.request("proposal.getId", () => ctx.sdk.proposal.getId()),
  ]);
  if (root !== snapshot.rootUrn || id !== snapshot.proposalId) {
    throw new Error("Proposal changed while reading; refresh");
  }
}
