export const rootUrn = "urn:adsk-forma-elements:proposal:project:proposal:revision";
export const path = "root/building";
export const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const triangle = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 12]);

export function fixture({ native = false, advertised = false, children = [] } = {}) {
  const element = {
    urn: `urn:adsk-forma-elements:${native ? "basicbuilding" : "basic"}:project:building:revision`,
    properties: {},
    children,
    representations: advertised ? { graphBuilding: {}, grossFloorAreaPolygons: {} } : {},
  };
  const root = { urn: rootUrn, properties: {}, children: [{ key: "building", urn: element.urn }] };
  const snapshot = {
    rootUrn, proposalId: "proposal", rootTree: { element: root, elements: { [element.urn]: element } },
    buildingPaths: [path], siteLimitPaths: [],
  };
  const unavailable = async () => { throw new Error("unavailable"); };
  const sdk = {
    proposal: {
      awaitProposalPersisted: async () => {},
      getRootUrn: async () => rootUrn,
      getId: async () => "proposal",
    },
    elements: {
      get: async () => snapshot.rootTree,
      getByPath: async () => ({ element, elements: {} }),
      getWorldTransform: async () => ({ transform: identity }),
      representations: { graphBuilding: unavailable, grossFloorAreaPolygons: unavailable },
    },
    geometry: {
      getPathsByCategory: async ({ category }) => category === "building" ? [path] : [],
      getFootprint: unavailable,
      getTriangles: unavailable,
    },
  };
  return { sdk, snapshot, element, root };
}

export function graphLevel(height = 3) {
  return {
    height, points: square.map(point => [...point]),
    surfaces: square.map((_, i) => ({ id: `s${i}`, pointA: i, pointB: (i + 1) % 4 })),
    spaces: [{ outerLoop: square.map((_, i) => ({ surfaceId: `s${i}`, directionAToB: true })), innerLoops: [] }],
  };
}

export function replaceGlobal(t, name, value) {
  const old = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, name, old);
    else delete globalThis[name];
  });
}

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Test condition timed out");
    await wait(5);
  }
}
