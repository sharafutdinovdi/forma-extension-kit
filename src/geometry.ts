import { assertRevision, context, errorText, type ReadOptions, type RootUrn } from "./internal.js";
import type { ProposalSnapshot } from "./proposal.js";

export type Point = [number, number];
export type Polygon = Point[][];

export interface Footprint {
  /** Set union; overlapping parts are not dissolved and their areas must not be summed. */
  operation: "union";
  /** Each polygon is an outer ring followed by holes, with no repeated closing point. */
  parts: Polygon[];
  source: "graphBuilding" | "grossFloorAreaPolygons" | "footprint" | "children" | "triangles";
}

export interface FootprintResult {
  footprint: Footprint | null;
  attempts: { provider: string; error?: string }[];
}

function ring(points: readonly (readonly number[])[]): Point[] {
  const result = points.map(([x, y]): Point => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Non-finite footprint coordinate");
    return [x, y];
  });
  if (result.length > 1 && result[0][0] === result.at(-1)![0] && result[0][1] === result.at(-1)![1]) result.pop();
  const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = result.reduce((sum, point, index) => sum + cross(result[0], point, result[(index + 1) % result.length]), 0);
  if (result.length < 3 || Math.abs(area) < 1e-8) throw new Error("Empty or degenerate footprint ring");
  // Reject self-crossing boundaries rather than inventing a hull for invalid geometry.
  const on = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) < 1e-8 &&
    p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 2; j < result.length; j++) {
      if (i === 0 && j === result.length - 1) continue;
      const a = result[i], b = result[(i + 1) % result.length], c = result[j], d = result[(j + 1) % result.length];
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
        on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) throw new Error("Self-intersecting footprint ring");
    }
  }
  return result;
}

/** Direct footprints can be unavailable; retains provider failures and returns an undissolved union of parts. */
export async function readFootprint(
  path: string,
  snapshot: Pick<ProposalSnapshot, "rootUrn" | "proposalId">,
  options: ReadOptions = {},
): Promise<FootprintResult> {
  const ctx = await context(options);
  const { sdk, request } = ctx;
  const { rootUrn, proposalId } = snapshot;
  await assertRevision(ctx, { rootUrn, proposalId });
  const { element } = await request("elements.getByPath", () => sdk.elements.getByPath({ path, rootUrn: rootUrn as RootUrn }));
  const attempts: FootprintResult["attempts"] = [];
  const attempt = async (provider: string, read: () => Promise<Polygon[]>): Promise<Polygon[] | null> => {
    try {
      const parts = await read();
      if (!parts.length || parts.some(polygon => !polygon.length)) throw new Error("No footprint polygons");
      attempts.push({ provider });
      return parts;
    } catch (error) {
      attempts.push({ provider, error: errorText(error) });
      return null;
    }
  };
  const direct = (target: string) => attempt(`getFootprint:${target}`, async () => {
    const value = await request("geometry.getFootprint", () => sdk.geometry.getFootprint({ path: target, urn: rootUrn }));
    // SDK footprint coordinates are one flat XY ring, unlike GeoJSON Polygon coordinates.
    if (value?.type !== "Polygon") throw new Error(`getFootprint returned ${value === undefined ? "undefined" : "no Polygon"}`);
    return [[ring(value.coordinates)]];
  });
  let transform: number[] | undefined;
  const worldPolygon = async (polygon: Polygon): Promise<Polygon> => {
    // Representations are element-local; the transform API cannot pin a root, so recheck below.
    transform ??= (await request("elements.getWorldTransform", () => sdk.elements.getWorldTransform({ path }))).transform;
    const t = transform;
    if (t.length !== 16 || t.some(n => !Number.isFinite(n)) ||
      [2, 3, 6, 7, 8, 9, 11].some(i => Math.abs(t[i]) > 1e-8) || t[10] <= 0 || Math.abs(t[15] - 1) > 1e-8) {
      throw new Error("Invalid or tilted floor transform");
    }
    return polygon.map(points => ring(points.map(([x, y]) => [t[0] * x + t[4] * y + t[12], t[1] * x + t[5] * y + t[13]])));
  };
  const native = /:basicbuilding:/.test(element.urn);
  let parts: Polygon[] | null = null;
  let source: Footprint["source"] = "graphBuilding";
  if (native || element.representations?.graphBuilding) {
    parts = await attempt(source, async () => {
      const graph = await request("graphBuilding", () => sdk.elements.representations.graphBuilding({ urn: element.urn }));
      if (!graph?.data.levels.length) throw new Error("graphBuilding returned no levels");
      const polygons: Polygon[] = [];
      for (const level of graph.data.levels) {
        if (!Number.isFinite(level.height) || level.height <= 0 || !level.spaces.length) throw new Error("Invalid graph level");
        const surfaces = new Map(level.surfaces.map(surface => [surface.id, surface]));
        // Graph points are indexed, not an ordered ring; reconstruct directed surface loops.
        const loop = (edges: typeof level.spaces[number]["outerLoop"]): Point[] => {
          const segments = edges.map(edge => {
            const surface = surfaces.get(edge.surfaceId);
            if (!surface) throw new Error("Missing graph surface");
            return edge.directionAToB ? [surface.pointA, surface.pointB] : [surface.pointB, surface.pointA];
          });
          return segments.map(([start, end], i) => {
            if (end !== segments[(i + 1) % segments.length][0] || !level.points[start]) throw new Error("Disconnected graph loop");
            return level.points[start];
          });
        };
        for (const space of level.spaces) polygons.push(await worldPolygon([loop(space.outerLoop), ...(space.innerLoops ?? []).map(loop)]));
      }
      return polygons;
    });
  }
  if (!parts && (native || element.representations?.grossFloorAreaPolygons)) {
    source = "grossFloorAreaPolygons";
    parts = await attempt(source, async () => {
      const floors = await request("grossFloorAreaPolygons", () => sdk.elements.representations.grossFloorAreaPolygons({ urn: element.urn }));
      if (!floors?.data.length) throw new Error("grossFloorAreaPolygons returned no floors");
      const polygons: Polygon[] = [];
      for (const floor of floors.data) {
        if (!Number.isFinite(floor.elevation)) throw new Error("Invalid floor elevation");
        polygons.push(await worldPolygon(floor.grossFloorPolygon));
      }
      return polygons;
    });
  }
  // Context/basic elements have readable direct footprints; authored basicbuilding often does not.
  if (!parts) { source = "footprint"; parts = await direct(path); }
  if (!parts && element.children?.length) {
    source = "children";
    parts = await attempt(source, async () => {
      const polygons: Polygon[] = [];
      let complete = true;
      for (const child of element.children!) {
        // Child keys are path segments; a partial set must never look like a complete footprint.
        const childParts = await direct(`${path}/${child.key}`);
        if (childParts) polygons.push(...childParts); else complete = false;
      }
      if (!complete) throw new Error("Some child footprints are unavailable");
      return polygons;
    });
  }
  if (!parts) {
    source = "triangles";
    parts = await attempt(source, async () => {
      const vertices = await request("geometry.getTriangles", () => sdk.geometry.getTriangles({ path, urn: rootUrn }));
      if (!vertices.length || vertices.length % 9 || vertices.some(n => !Number.isFinite(n))) throw new Error("Invalid or empty triangle array");
      const polygons: Polygon[] = [];
      for (let i = 0; i < vertices.length; i += 9) {
        const a: Point = [vertices[i], vertices[i + 1]], b: Point = [vertices[i + 3], vertices[i + 4]], c: Point = [vertices[i + 6], vertices[i + 7]];
        // Vertical faces have zero XY area; retain all other parts, including disconnected ones.
        if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) >= 1e-8) polygons.push([[a, b, c]]);
      }
      return polygons;
    });
  }
  // Retry the direct provider after all alternatives; transient availability is not assumed.
  if (!parts) { source = "footprint"; parts = await direct(path); }
  await assertRevision(ctx, { rootUrn, proposalId });
  return { footprint: parts ? { operation: "union", parts, source } : null, attempts };
}
