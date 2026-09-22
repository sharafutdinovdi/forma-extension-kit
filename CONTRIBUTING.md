# Contributing

Changes require a small reproducible case and tests for observable adapter behavior.
Host assertions require evidence from SDK declarations, a cited source adapter, or a redacted live trace; declarations and synthetic fixtures do not establish live behavior.
Unverified host behavior remains explicitly labelled in the README.

## Local checks

```sh
npm install --package-lock=false
npm run typecheck
npm test
npm run build
npm pack --dry-run
node -e "import('./dist/index.js').then(m => console.log(Object.keys(m).sort().join(',')))"
```

CI runs the checks on Node 20 and 22.
Tests use `node:test` with injected SDK and browser stubs; they require no authenticated Forma session.
Build output and dependency lockfiles are not tracked in this repository.
Package entry points must remain importable without a browser or a host handshake.

## Scope

The public surface contains reusable read adapters and browser transport helpers.
Product rules, UI components, polygon-processing dependencies and model mutations are outside scope.
Changes to provider order, return shapes, deadlines or message ordering require matching documentation and regression tests.
Failures must preserve unknown data rather than replace it with fabricated measurements.
Reports and fixtures must omit credentials, private project identifiers and proprietary geometry.

Contributions are licensed under the repository's [MIT license](LICENSE).
