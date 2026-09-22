import test from "node:test";
import assert from "node:assert/strict";
import { classifyBuilding, readProposalSnapshot, readFootprint, readHeight } from "../dist/index.js";
import { fixture, graphLevel, identity, path, rootUrn, square, triangle } from "./helpers.mjs";

test("snapshot waits for persistence, pins queries, deduplicates and removes nested building paths", async () => {
  const { sdk, snapshot } = fixture();
  let persisted = false;
  sdk.proposal.awaitProposalPersisted = async () => { persisted = true; };
  sdk.proposal.getRootUrn = async () => { assert.ok(persisted); return rootUrn; };
  sdk.geometry.getPathsByCategory = async ({ category, urn }) => {
    assert.equal(urn, rootUrn);
    return category === "building" ? [path, `${path}/floor`, path, `${path}2`] : ["root/site", "root/site"];
  };
  const result = await readProposalSnapshot({ sdk });
  assert.deepEqual(result.buildingPaths, [path, `${path}2`]);
  assert.deepEqual(result.siteLimitPaths, ["root/site"]);
  assert.equal(result.rootTree, snapshot.rootTree);
});

for (const property of ["getRootUrn", "getId"]) {
  test(`snapshot rejects a changed ${property}`, async () => {
    const { sdk } = fixture();
    const original = sdk.proposal[property];
    let calls = 0;
    sdk.proposal[property] = async () => ++calls === 1 ? original() : "changed";
    await assert.rejects(readProposalSnapshot({ sdk }), /Proposal changed/);
  });
}

test("persistence waits are bounded", async () => {
  const { sdk } = fixture();
  sdk.proposal.awaitProposalPersisted = () => new Promise(() => {});
  await assert.rejects(readProposalSnapshot({ sdk, timeoutMs: 10 }), /awaitProposalPersisted timed out/);
});

test("classifier ignores the building's own URN and its own flagged key", async () => {
  const { snapshot, element, root } = fixture();
  element.urn = "urn:adsk-forma-elements:group:p:base:own-overture-integrate";
  root.children[0].urn = element.urn;
  root.properties.flags = { building: { base: true } };
  assert.equal(await classifyBuilding(path, snapshot), "proposal");
});

test("classifier accepts root base flags for nested ancestry", async () => {
  const { snapshot, root } = fixture();
  root.properties.flags = { baseKey: { base: true } };
  assert.equal(await classifyBuilding("root/baseKey/group/building", snapshot), "existing");
});

test("classifier detects base-group ancestor URNs and base roots", async () => {
  const { snapshot, root } = fixture();
  root.children = [{ key: "context", urn: "urn:adsk-forma-elements:group:p:base:r" }];
  assert.equal(await classifyBuilding("root/context/nested/building", snapshot), "existing");
  root.urn = "urn:adsk-forma-elements:group:p:base:r";
  assert.equal(await classifyBuilding(path, snapshot), "existing");
});

test("classifier resolves nested proposal groups and shares in-flight ancestor reads", async () => {
  const { snapshot, root, sdk } = fixture();
  const outer = { urn: "urn:outer", children: [{ key: "inner", urn: "urn:inner" }] };
  const inner = { urn: "urn:inner", children: [] };
  root.children = [{ key: "outer", urn: outer.urn }];
  let reads = 0;
  sdk.elements.get = async () => { reads++; return { element: outer, elements: { [inner.urn]: inner } }; };
  const results = await Promise.all([1, 2].map(() => classifyBuilding("root/outer/inner/building", snapshot, { sdk })));
  assert.deepEqual(results, ["proposal", "proposal"]);
  assert.equal(reads, 1);
});

test("classifier detects a nested base group in a fetched ancestor", async () => {
  const { snapshot, root, sdk } = fixture();
  root.children = [{ key: "outer", urn: "urn:outer" }];
  sdk.elements.get = async () => ({ element: {
    urn: "urn:outer", children: [{ key: "base", urn: "urn:adsk-forma-elements:group:p:base:r" }],
  }, elements: {} });
  assert.equal(await classifyBuilding("root/outer/base/building", snapshot, { sdk }), "existing");
});

test("classifier rejects unresolved ancestry and invalid paths", async () => {
  const { snapshot } = fixture();
  await assert.rejects(classifyBuilding("root/missing/building", snapshot), /Cannot resolve/);
  await assert.rejects(classifyBuilding("building", snapshot), /Invalid building path/);
});

test("graph footprint reconstructs surface loops, preserves holes and applies the world transform", async () => {
  const { sdk, snapshot } = fixture({ native: true });
  const level = graphLevel();
  level.points.push([2, 2], [2, 4], [4, 4], [4, 2]);
  level.surfaces.push(...[4, 5, 6, 7].map((n, i) => ({ id: `h${i}`, pointA: n, pointB: 4 + ((i + 1) % 4) })));
  level.spaces[0].innerLoops = [[0, 1, 2, 3].map(i => ({ surfaceId: `h${i}`, directionAToB: true }))];
  sdk.elements.representations.graphBuilding = async () => ({ data: { levels: [level, level] } });
  sdk.elements.getWorldTransform = async () => ({ transform: identity.map((n, i) => i === 12 ? 100 : n) });
  const result = await readFootprint(path, snapshot, { sdk });
  assert.equal(result.footprint.source, "graphBuilding");
  assert.equal(result.footprint.operation, "union");
  assert.equal(result.footprint.parts.length, 2);
  assert.equal(result.footprint.parts[0].length, 2);
  assert.deepEqual(result.footprint.parts[0][0][0], [100, 0]);
  assert.deepEqual(result.attempts, [{ provider: "graphBuilding" }]);
});

test("GFA provider follows a failed graph provider and preserves holes", async () => {
  const { sdk, snapshot } = fixture({ advertised: true });
  sdk.elements.representations.grossFloorAreaPolygons = async () => ({ data: [{
    elevation: 0, grossFloorPolygon: [square, [[2, 2], [4, 2], [2, 4]]],
  }] });
  const result = await readFootprint(path, snapshot, { sdk });
  assert.equal(result.footprint.source, "grossFloorAreaPolygons");
  assert.equal(result.footprint.parts[0].length, 2);
  assert.equal(result.attempts[0].error, "unavailable");
});

test("direct footprint follows representations, accepts the flat XY ring and removes closing point", async () => {
  const { sdk, snapshot } = fixture({ native: true });
  sdk.geometry.getFootprint = async () => ({ type: "Polygon", coordinates: [...square, square[0]] });
  const result = await readFootprint(path, snapshot, { sdk });
  assert.equal(result.footprint.source, "footprint");
  assert.deepEqual(result.footprint.parts, [[square]]);
  assert.deepEqual(result.attempts.map(a => a.provider), ["graphBuilding", "grossFloorAreaPolygons", `getFootprint:${path}`]);
});

test("child footprints form a complete undissolved union using child keys", async () => {
  const { sdk, snapshot } = fixture({ children: [{ key: "a", urn: "urn:a" }, { key: "b", urn: "urn:b" }] });
  sdk.geometry.getFootprint = async ({ path: target }) => {
    if (target === path) throw new Error("parent unavailable");
    assert.ok([`${path}/a`, `${path}/b`].includes(target));
    return { type: "Polygon", coordinates: square };
  };
  const result = await readFootprint(path, snapshot, { sdk });
  assert.equal(result.footprint.source, "children");
  assert.deepEqual(result.footprint.parts, [[square], [square]]);
  assert.equal(result.attempts[0].error, "parent unavailable");
});

test("partial children are rejected; XY triangle projection ignores vertical faces", async () => {
  const { sdk, snapshot } = fixture({ children: [{ key: "a", urn: "urn:a" }, { key: "b", urn: "urn:b" }] });
  sdk.geometry.getFootprint = async ({ path: target }) => target.endsWith("/a") ? { type: "Polygon", coordinates: square } : undefined;
  sdk.geometry.getTriangles = async () => new Float32Array([...triangle, 0, 0, 0, 0, 0, 3, 0, 1, 3]);
  const result = await readFootprint(path, snapshot, { sdk });
  assert.equal(result.footprint.source, "triangles");
  assert.equal(result.footprint.parts.length, 1);
  assert.ok(result.attempts.some(a => a.provider === "children" && /Some child/.test(a.error)));
  assert.ok(result.attempts.some(a => a.provider.endsWith("/b") && /undefined/.test(a.error)));
});

test("last-resort direct retry follows failed triangles", async () => {
  const { sdk, snapshot } = fixture();
  let reads = 0;
  sdk.geometry.getFootprint = async () => ++reads === 1 ? undefined : { type: "Polygon", coordinates: square };
  const result = await readFootprint(path, snapshot, { sdk });
  assert.equal(result.footprint.source, "footprint");
  assert.deepEqual(result.attempts.map(a => a.provider), [`getFootprint:${path}`, "triangles", `getFootprint:${path}`]);
});

test("all providers failing returns null with every attempted provider's error", async () => {
  const { sdk, snapshot } = fixture({ native: true, children: [{ key: "a", urn: "urn:a" }] });
  const result = await readFootprint(path, snapshot, { sdk });
  assert.equal(result.footprint, null);
  assert.deepEqual(result.attempts.map(a => a.provider), [
    "graphBuilding", "grossFloorAreaPolygons", `getFootprint:${path}`,
    `getFootprint:${path}/a`, "children", "triangles", `getFootprint:${path}`,
  ]);
  assert.ok(result.attempts.every(a => typeof a.error === "string" && a.error.length));
});

test("hanging provider times out and falls back; object errors retain their text", async () => {
  const { sdk, snapshot } = fixture({ advertised: true });
  sdk.elements.representations.graphBuilding = () => new Promise(() => {});
  sdk.elements.representations.grossFloorAreaPolygons = async () => { throw { reason: "no representation" }; };
  sdk.geometry.getFootprint = async () => ({ type: "Polygon", coordinates: square });
  const result = await readFootprint(path, snapshot, { sdk, timeoutMs: 10 });
  assert.match(result.attempts[0].error, /timed out/);
  assert.equal(result.attempts[1].error, '{"reason":"no representation"}');
  assert.equal(result.footprint.source, "footprint");
});

for (const coordinates of [[], [[0, 0], [1, 1], [2, 2]], [[0, 0], [NaN, 0], [0, 1]], [[0, 0], [4, 4], [0, 3], [4, 0]]]) {
  test(`invalid footprint ring is not accepted: ${JSON.stringify(coordinates)}`, async () => {
    const { sdk, snapshot } = fixture();
    sdk.geometry.getFootprint = async () => ({ type: "Polygon", coordinates });
    assert.equal((await readFootprint(path, snapshot, { sdk })).footprint, null);
  });
}

test("tilted representation falls back without inventing a projected floor", async () => {
  const { sdk, snapshot } = fixture({ native: true });
  sdk.elements.representations.graphBuilding = async () => ({ data: { levels: [graphLevel()] } });
  sdk.elements.getWorldTransform = async () => ({ transform: identity.map((n, i) => i === 2 ? 0.1 : n) });
  sdk.geometry.getTriangles = async () => triangle;
  const result = await readFootprint(path, snapshot, { sdk });
  assert.equal(result.footprint.source, "triangles");
  assert.match(result.attempts[0].error, /tilted/);
});

for (const read of [readFootprint, readHeight]) {
  test(`${read.name} rejects a revision change during geometry acquisition`, async () => {
    const { sdk, snapshot } = fixture();
    sdk.geometry.getTriangles = async () => {
      sdk.proposal.getId = async () => "another-proposal";
      return triangle;
    };
    await assert.rejects(read(path, snapshot, { sdk }), /Proposal changed/);
  });
}

test("height uses graph level heights scaled in Z and exact model floor count", async () => {
  const { sdk, snapshot } = fixture({ native: true });
  sdk.elements.representations.graphBuilding = async () => ({ data: { levels: [graphLevel(3), graphLevel(4)] } });
  sdk.elements.getWorldTransform = async () => ({ transform: identity.map((n, i) => i === 10 ? 2 : n) });
  assert.deepEqual(await readHeight(path, snapshot, { sdk }), { heightM: 14, floors: 2, source: "graphBuilding", estimated: false });
});

test("height combines distinct GFA elevations with mesh Z extents", async () => {
  const { sdk, snapshot } = fixture({ advertised: true });
  sdk.elements.representations.grossFloorAreaPolygons = async () => ({ data: [0, 0, 4].map(elevation => ({ elevation, grossFloorPolygon: [square] })) });
  sdk.geometry.getTriangles = async () => triangle;
  assert.deepEqual(await readHeight(path, snapshot, { sdk }), { heightM: 12, floors: 2, source: "triangles", estimated: false });
});

test("GFA elevations alone do not invent the top storey's height", async () => {
  const { sdk, snapshot } = fixture({ advertised: true });
  sdk.elements.representations.grossFloorAreaPolygons = async () => ({ data: [{ elevation: 0 }, { elevation: 3 }] });
  assert.deepEqual(await readHeight(path, snapshot, { sdk }), { heightM: null, floors: 2, source: "grossFloorAreaPolygons", estimated: false });
});

test("mesh floors remain unknown unless floor height estimation is requested", async () => {
  const { sdk, snapshot } = fixture();
  sdk.geometry.getTriangles = async () => triangle;
  assert.deepEqual(await readHeight(path, snapshot, { sdk }), { heightM: 12, floors: null, source: "triangles", estimated: false });
  assert.deepEqual(await readHeight(path, snapshot, { sdk, floorHeightM: 3.5 }), { heightM: 12, floors: 4, source: "triangles", estimated: true });
});

test("unverified properties.height is marked estimated and accepts only positive finite numbers", async () => {
  const { sdk, snapshot, element } = fixture();
  element.properties.height = 18;
  assert.deepEqual(await readHeight(path, snapshot, { sdk }), { heightM: 18, floors: null, source: "properties.height", estimated: true });
  for (const height of ["18", -1, 0, NaN, Infinity]) {
    element.properties.height = height;
    assert.deepEqual(await readHeight(path, snapshot, { sdk }), { heightM: null, floors: null, source: null, estimated: false });
  }
});
