import { assertRevision, context, positive, type ReadOptions, type RootUrn } from "./internal.js";
import type { ProposalSnapshot } from "./proposal.js";

export interface HeightOptions extends ReadOptions {
  /** Explicit assumption for missing floor counts; no floor height is assumed by default. */
  floorHeightM?: number;
}

export interface HeightResult {
  heightM: number | null;
  floors: number | null;
  /** Height provider, or grossFloorAreaPolygons if only the floor count is known. */
  source: "graphBuilding" | "grossFloorAreaPolygons" | "triangles" | "properties.height" | null;
  /** True for assumed floors or the unverified properties.height fallback. */
  estimated: boolean;
}

/** Source adapters use graph levels, mesh Z extents and an unverified numeric height property; context has no floor count. */
export async function readHeight(
  path: string,
  snapshot: Pick<ProposalSnapshot, "rootUrn" | "proposalId">,
  options: HeightOptions = {},
): Promise<HeightResult> {
  if (options.floorHeightM !== undefined) positive(options.floorHeightM, "floorHeightM");
  const ctx = await context(options);
  const { sdk, request } = ctx;
  await assertRevision(ctx, snapshot);
  const { element } = await request("elements.getByPath", () => sdk.elements.getByPath({
    path, rootUrn: snapshot.rootUrn as RootUrn,
  }));
  const result: HeightResult = { heightM: null, floors: null, source: null, estimated: false };
  const native = /:basicbuilding:/.test(element.urn);
  if (native || element.representations?.graphBuilding) {
    try {
      const graph = await request("graphBuilding", () => sdk.elements.representations.graphBuilding({ urn: element.urn }));
      const { transform: t } = await request("elements.getWorldTransform", () => sdk.elements.getWorldTransform({ path }));
      if (!graph?.data.levels.length || t.length !== 16 || t.some(n => !Number.isFinite(n)) ||
        [2, 3, 6, 7, 8, 9, 11].some(i => Math.abs(t[i]) > 1e-8) || t[10] <= 0 || Math.abs(t[15] - 1) > 1e-8) {
        throw new Error("Invalid graph levels or floor transform");
      }
      let height = 0;
      for (const level of graph.data.levels) {
        if (!Number.isFinite(level.height) || level.height <= 0 || !level.spaces.length) throw new Error("Invalid graph level");
        height += level.height * t[10];
      }
      if (!Number.isFinite(height)) throw new Error("Invalid graph height");
      result.heightM = height;
      result.floors = graph.data.levels.length;
      result.source = "graphBuilding";
    } catch { /* Continue through the source adapter's height providers. */ }
  }
  if (result.floors === null && (native || element.representations?.grossFloorAreaPolygons)) {
    try {
      const gfa = await request("grossFloorAreaPolygons", () => sdk.elements.representations.grossFloorAreaPolygons({ urn: element.urn }));
      if (gfa?.data.length && gfa.data.every(floor => Number.isFinite(floor.elevation))) {
        result.floors = new Set(gfa.data.map(floor => floor.elevation)).size;
        result.source = "grossFloorAreaPolygons";
      }
    } catch { /* Missing floor plates leave the floor count unknown. */ }
  }
  if (result.heightM === null) {
    try {
      const vertices = await request("geometry.getTriangles", () => sdk.geometry.getTriangles({ path, urn: snapshot.rootUrn }));
      if (!vertices.length || vertices.length % 9 || vertices.some(n => !Number.isFinite(n))) throw new Error("Invalid triangles");
      let min = Infinity, max = -Infinity;
      for (let i = 2; i < vertices.length; i += 3) {
        min = Math.min(min, vertices[i]);
        max = Math.max(max, vertices[i]);
      }
      if (max > min && Number.isFinite(max - min)) {
        result.heightM = max - min;
        result.source = "triangles";
      }
    } catch { /* A finite positive property is the last, unverified fallback. */ }
  }
  if (result.heightM === null) {
    const height = element.properties?.height;
    if (typeof height === "number" && Number.isFinite(height) && height > 0) {
      result.heightM = height;
      result.source = "properties.height";
      result.estimated = true;
    }
  }
  if (result.floors === null && result.heightM !== null && options.floorHeightM !== undefined) {
    const floors = Math.ceil(result.heightM / options.floorHeightM);
    if (Number.isFinite(floors)) {
      result.floors = floors;
      result.estimated = true;
    }
  }
  await assertRevision(ctx, snapshot);
  return result;
}
