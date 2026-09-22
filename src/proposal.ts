import { assertRevision, context, type ReadOptions, type RootTree } from "./internal.js";

export interface ProposalSnapshot {
  rootUrn: string;
  proposalId: string;
  rootTree: RootTree;
  buildingPaths: string[];
  siteLimitPaths: string[];
}

export type BuildingKind = "proposal" | "existing";

/** Proposal reads can span revisions; awaits persistence and checks root/id again before returning. */
export async function readProposalSnapshot(options: ReadOptions = {}): Promise<ProposalSnapshot> {
  const { sdk, request } = await context(options);
  await request("proposal.awaitProposalPersisted", () => sdk.proposal.awaitProposalPersisted());
  const [rootUrn, proposalId] = await Promise.all([
    request("proposal.getRootUrn", () => sdk.proposal.getRootUrn()),
    request("proposal.getId", () => sdk.proposal.getId()),
  ]);
  const [rootTree, buildings, sites] = await Promise.all([
    request("elements.get", () => sdk.elements.get({ urn: rootUrn })),
    request("building paths", () => sdk.geometry.getPathsByCategory({ category: "building", urn: rootUrn })),
    request("site limit paths", () => sdk.geometry.getPathsByCategory({ category: "site_limit", urn: rootUrn })),
  ]);
  const unique = [...new Set(buildings)];
  const snapshot = {
    rootUrn, proposalId, rootTree,
    buildingPaths: unique.filter(path => !unique.some(parent => path.startsWith(`${parent}/`))),
    siteLimitPaths: [...new Set(sites)],
  };
  await assertRevision({ sdk, request }, snapshot);
  return snapshot;
}

const caches = new WeakMap<RootTree, {
  elements: RootTree["elements"];
  pending: Map<string, Promise<void>>;
}>();

/** Observed context buildings are under base groups; their own basic/basicbuilding URNs are not source markers. */
export async function classifyBuilding(
  path: string,
  snapshot: ProposalSnapshot,
  options: ReadOptions = {},
): Promise<BuildingKind> {
  const segments = path.split("/");
  if (segments[0] !== "root" || segments.length < 2 || segments.some(key => !key)) {
    throw new Error(`Invalid building path: ${path}`);
  }
  const root = snapshot.rootTree.element;
  const keys = segments.slice(1, -1);
  const base = /:group:[^:]+:base:/;
  if (base.test(root.urn) || keys.some(key => root.properties?.flags?.[key]?.base === true)) return "existing";
  let cache = caches.get(snapshot.rootTree);
  if (!cache) {
    cache = { elements: { ...snapshot.rootTree.elements, [root.urn]: root }, pending: new Map() };
    caches.set(snapshot.rootTree, cache);
  }
  let parent = root;
  for (const key of keys) {
    const child = parent.children?.find(item => item.key === key);
    if (!child) throw new Error(`Cannot resolve building ancestry: ${path}`);
    if (base.test(child.urn)) return "existing";
    if (!cache.elements[child.urn]) {
      if (!cache.pending.has(child.urn)) {
        const target = cache;
        const pending = (async () => {
          const { sdk, request } = await context(options);
          const tree = await request("ancestor elements.get", () => sdk.elements.get({ urn: child.urn }));
          Object.assign(target.elements, tree.elements, { [tree.element.urn]: tree.element });
        })().finally(() => target.pending.delete(child.urn));
        cache.pending.set(child.urn, pending);
      }
      await cache.pending.get(child.urn);
    }
    parent = cache.elements[child.urn];
    if (!parent) throw new Error(`Cannot resolve building ancestry: ${path}`);
  }
  return "proposal";
}
