# forma-extension-kit

Read-only TypeScript host adapters for Autodesk Forma embedded extensions.
The package provides proposal snapshots, ancestry classification, geometry fallbacks, change watching, panel messaging and decimal helpers.
It is ESM only, includes declarations, and has no runtime dependencies beyond the `forma-embedded-view-sdk` peer (`>=0.96 <1`).
The implementation and tests target SDK 0.96.0; the peer range does not establish live compatibility with every release.

## Install

```sh
npm install forma-extension-kit forma-embedded-view-sdk@">=0.96 <1"
```

Node 20 or later is required for development and package verification.
Host reads run in a Forma browser extension.
Importing the package, using decimal helpers or classifying a fully bundled tree does not load the SDK or access the DOM.
The default SDK singleton loads on the first host read.
Outside a browser, host reads require an injected `sdk`.

All host-read functions accept an optional final `{ sdk, timeoutMs }` argument.
`sdk` is the exported structural `HostSdk` subset; an existing `Forma` instance satisfies it.
Each SDK request has an 8000 ms deadline by default, including persistence and SDK loading.
A multi-provider read can take more than one deadline in total.
Timeouts stop waiting; the SDK supplies no cancellation mechanism in these source adapters.

## Proposal snapshots and classification

`readProposalSnapshot()` awaits proposal persistence, captures root URN and proposal id, reads the tree and category paths, then checks both identifiers again.
A changed revision rejects with a refresh error.
Duplicate building paths and descendants of another building path are removed; duplicate site-limit paths are removed without selecting a parcel.
The returned object contains `{ rootUrn, proposalId, rootTree, buildingPaths, siteLimitPaths }`.

```ts
import { readProposalSnapshot, classifyBuilding } from "forma-extension-kit";

const snapshot = await readProposalSnapshot();
for (const path of snapshot.buildingPaths) {
  const kind = await classifyBuilding(path, snapshot);
  console.log(path, kind); // "proposal" or "existing"
}
```

`classifyBuilding(path, snapshot)` is asynchronous.
It returns `"existing"` when an ancestor key has `root.properties.flags[key].base === true`, or an ancestor URN matches `/:group:[^:]+:base:/`.
The root itself also qualifies as an ancestor.
The building's own key and URN do not determine its classification.
Missing ancestor elements are fetched by URN and cached per root tree, with shared in-flight reads.
Unresolvable ancestry rejects instead of assuming a source.
Snapshots are revision-scoped; callers should treat the tree as immutable.

## Footprints

`readFootprint(path, snapshot)` returns `{ footprint, attempts }`.
The footprint is `null` when all applicable providers fail.
Every attempted provider retains its name and, on failure, its error text; successful attempts have no `error` field.
Failure to resolve the element, failure to check the revision, or a changed revision rejects the call.

```ts
import { readProposalSnapshot, readFootprint } from "forma-extension-kit";

const snapshot = await readProposalSnapshot();
const path = snapshot.buildingPaths[0];
if (path) {
  const { footprint, attempts } = await readFootprint(path, snapshot);
  console.log(footprint?.source, footprint?.parts, attempts);
}
```

The provider order is:

1. `graphBuilding`, then `grossFloorAreaPolygons`, when advertised by the element or when its URN identifies `basicbuilding`.
2. Direct `geometry.getFootprint`.
3. Direct footprints for all immediate child paths, using child keys as path segments.
4. XY projection of `geometry.getTriangles`, excluding zero-area vertical faces.
5. A last direct-footprint retry.

This adapter consistently places the first direct attempt before children, including native buildings.
The template prioritises children and triangles over the direct footprint for native buildings; the uniform order here is package policy, not a new host observation.
Partial child results are rejected as an incomplete building footprint.
The final retry is defensive; transient provider recovery is unverified in Forma.

The footprint shape follows the template:

```ts
type Point = [number, number];
type Polygon = Point[][]; // outer ring, followed by zero or more holes
type Footprint = {
  operation: "union";
  parts: Polygon[];
  source: "graphBuilding" | "grossFloorAreaPolygons" | "footprint" | "children" | "triangles";
};
```

`parts` denotes a **set union of polygons**, not a dissolved boundary.
Parts can overlap or be disconnected; summing their areas double-counts overlaps.
Rings omit the duplicate closing coordinate; no winding order is promised.
Ring validation rejects non-finite coordinates, degenerate rings and self-intersections; it does not establish topology between holes and outer rings.
The direct SDK footprint is a single flat XY ring, unlike nested GeoJSON Polygon coordinates, and cannot supply holes through that shape.
Representations retain outer rings and holes and use the element world transform; invalid or tilted floor transforms are rejected.
The transform call has no root argument, hence the revision check after acquisition.
Host coordinate placement and provider completeness remain subject to the evidence limits below.

## Heights

`readHeight(path, snapshot)` returns `{ heightM, floors, source, estimated }`, with `null` for unavailable height, floor count or source.

```ts
import { readProposalSnapshot, readHeight } from "forma-extension-kit";

const snapshot = await readProposalSnapshot();
const path = snapshot.buildingPaths[0];
if (path) {
  const measured = await readHeight(path, snapshot);
  const assumed = await readHeight(path, snapshot, { floorHeightM: 3.5 });
  console.log(measured, assumed);
}
```

Graph level heights, scaled by the world transform's Z scale, supply height and model floor count first.
Distinct GFA elevations supply a floor count when graph levels are unavailable; elevations alone do not supply the top storey's height.
Mesh height is `max Z - min Z` over valid triangles.
A finite positive numeric `properties.height` is the last fallback; the property and its assumed metre units are **unverified** and set `estimated: true`.
No string height or missing value becomes zero.

The optional `floorHeightM` explicitly enables `ceil(heightM / floorHeightM)` when a model floor count is unavailable.
No floor height is assumed by default.
`source` identifies the height provider (`graphBuilding`, `triangles`, `properties.height`), or `grossFloorAreaPolygons` when only floors are known, or `null` when neither value is known.
`estimated` is true for assumed floors or the unverified height property; false does not certify regulatory accuracy or live host verification.
Provider failures fall through to the next source; element-resolution and revision errors reject.

## Proposal watching

`watchProposal(handler, options)` resolves to an idempotent unsubscribe function.
It uses the optional SDK `proposal.subscribe` with `{ debouncedPersistedOnly: true }`; missing, rejected or timed-out subscriptions select fingerprint polling.

```ts
import { watchProposal, readProposalSnapshot } from "forma-extension-kit";

const stop = await watchProposal(async () => {
  const snapshot = await readProposalSnapshot();
  console.log(snapshot.rootUrn);
}, { onError: error => console.warn(error) });

window.addEventListener("pagehide", stop, { once: true });
```

The default polling interval is 4000 ms; the default change debounce is 600 ms.
Options `intervalMs`, `debounceMs`, `timeoutMs` and `onError` override those policies.
The fingerprint includes proposal id, root revision and sorted site-limit/building paths with their counts implicit in the arrays.
Its first successful read establishes a baseline without invoking the handler; identical fingerprints are ignored.
Changes without a root, proposal id or path change remain undetectable.
The handler receives a root URN for subscription events and `undefined` for fingerprint changes.

Polling pauses while `document.hidden`; pending changes are delivered when the document becomes visible.
Without `document`, polling operates as visible.
Subscription setup, each complete fingerprint and each handler wait have bounded deadlines.
A late subscription is disposed after setup times out, and late callbacks are ignored.
Unsubscribe clears timers/listeners and stops future delivery; already-running SDK calls and handlers cannot be cancelled.
Background failures reach `onError` when supplied; no console logging is forced.
Live subscription delivery and iframe visibility behavior remain unverified.

## Panel channels

`createPanelChannel<T>(name)` returns `{ publish, subscribe, close }` for browser views sharing a channel name.
Proposal scope is explicit in `subscribe(proposalId, handler)`; a proposal switch requires unsubscribing and subscribing with the new id.

```ts
import { createPanelChannel } from "forma-extension-kit";

const channel = createPanelChannel<{ selectedPath: string | null }>("example-panel");
const unsubscribe = channel.subscribe("active-proposal-id", message => {
  console.log(message.value.selectedPath);
});
channel.publish({
  proposalId: "active-proposal-id",
  timestamp: Date.now(),
  value: { selectedPath: null },
});

window.addEventListener("pagehide", () => {
  unsubscribe();
  channel.close();
}, { once: true });
```

Messages contain `{ proposalId, timestamp, value }`; timestamps must be finite and positive.
The channel ignores its own sender id, other proposals, malformed envelopes, and timestamps less than or equal to the newest received or successfully published timestamp for that proposal.
`publish` returns false for stale messages, a closed channel or an unavailable transport; malformed messages throw.
The application owns payload validation and uses comparable, increasing timestamps across both views; equal timestamps do not resolve concurrent edits.
The payload must support both structured cloning and JSON serialization if storage fallback is required.

`BroadcastChannel` is preferred; unavailable construction selects `localStorage` storage events.
Storage messages are removed immediately after sending and are not a durable geometry cache.
There is no initial-state replay or peer snapshot request protocol.
Blocked transports and a missing `window` produce a channel whose `publish` returns false.
`close` is idempotent and clears transport resources and subscribers.
Origin/storage partitioning and delivery between real Forma embedded views remain unverified.

## Decimal helpers

`formatNumber` uses `Intl.NumberFormat("en-US")`, with grouping disabled and at most two fractional digits by default.
Additional `Intl.NumberFormatOptions` override formatting policies, and non-finite numbers throw.
`parseNumber` accepts trimmed signed decimals using `.` or `,` and returns `null` for invalid input.

```ts
import { formatNumber, parseNumber } from "forma-extension-kit";

formatNumber(1234.5); // "1234.5"
formatNumber(1234.5, { minimumFractionDigits: 2 }); // "1234.50"
parseNumber(" 12,5 "); // 12.5
parseNumber("12.5"); // 12.5
parseNumber("1,234.5"); // null: ambiguous/grouped input
```

Grouping, exponent notation, unit suffixes and blank strings are rejected by the parser.
A single separator is always decimal: `"1,234"` means `1.234`.
Parsing formatted output requires ungrouped decimal formatting, without currency or unit decoration.

## Evidence and limitations

The source of host claims is the supplied local adapters and notes, inspected for this implementation:

| Source | Contract or observation retained |
| --- | --- |
| `autodesk-forma-extension-template/src/forma.ts` | Persisted snapshot and revision guards; base ancestry; footprint providers; undissolved union shape and ring validation. |
| `forma-zoning-check/src/forma.ts` | Ancestor resolution; graph/GFA/triangle height reads; unverified height-property fallback; root/id/path fingerprint. |
| `forma-zoning-check/src/sync.ts` | Bounded subscription setup, polling and hidden-view deferral; BroadcastChannel and transient storage fallback. |
| `forma-zoning-check/NOTES.md` | Evidence boundaries, owner-supplied live observations and declaration/synthetic-test limitations. |

The notes report owner-supplied SDK 0.96.0 observations of existing Overture buildings under a flagged base group and a `:group:<project>:base:` parent URN.
Their own URNs contain neither `integrate` nor `overture` markers.
The initial authored ancestry sample is a site limit; the later native-geometry section reports two authored `basicbuilding` elements directly under the proposal root, with only `category: "building"` in their properties and an unavailable direct footprint.
The notes also retain the flat footprint-ring shape and report local metric coordinates and missing context floor counts.
These observations were not independently repeated for this package.

Representation availability/completeness, world-transform semantics, mesh positioning, subscription delivery, iframe visibility and real cross-panel transport remain unverified in a live Forma session.
Synthetic tests establish adapter behavior under supplied responses, not the accuracy of host geometry.
The proposal APIs used here are deprecated in SDK 0.96.0 in favor of UDM; this package retains the source adapters' API family without claiming UDM equivalence.

## What this does not do

- It does not write to the model, create panels, render overlays or manage extension registration.
- It does not dissolve polygons, calculate areas, determine plot membership or apply zoning rules.
- It does not infer legal height datums, floor semantics or missing building data.
- It does not provide durable state, automatic active-proposal discovery for channels, clock synchronisation or conflict resolution.
- It does not certify live Forma behavior, geometry completeness or host compatibility across the entire peer range.

## Development

```sh
npm install --package-lock=false
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The repository uses plain `tsc` and Node's built-in test runner.
The CI matrix runs on Node 20 and 22.
The package allowlist ships compiled `dist/**`; npm also includes this README, the MIT license and package metadata.
Source, tests and configuration are excluded.
Contributor and vulnerability-reporting instructions are in [CONTRIBUTING.md](https://github.com/sharafutdinovdi/forma-extension-kit/blob/main/CONTRIBUTING.md) and [SECURITY.md](https://github.com/sharafutdinovdi/forma-extension-kit/blob/main/SECURITY.md).

## License

[MIT](LICENSE), Copyright (c) 2026 Dinar Sharafutdinov.
