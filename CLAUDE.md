# MeltSim

An interactive, browser-based 2D thermodynamics sandbox that melts, freezes
and boils materials (ice, chocolate, cheese, wax, gallium, solder) via a
unit-tested, dependency-free enthalpy-method core: cells store specific
enthalpy rather than temperature, so the latent-heat plateau and bidirectional
phase change fall out of one conservation law. Covers melting, solidification/
casting (pour into a cold mould) and boiling with mass loss, plus an energy
ledger. Explicitly framed as an *educational* model, not a CFD solver.

## Directory layout

- `src/core/` — the physics: `enthalpy.ts`, `heat.ts`, `boiling.ts`,
  `viscosity.ts`, `flow.ts`, `grid.ts`, `materials.ts`, `sim.ts`.
- `src/render/` — bench views/renderer; `src/charts/` — instrument charts;
  `src/gif/`, `src/png/` — dependency-free encoders (used by both the app and
  the README's own animations); `src/scenario/`, `src/ui/`.
- `tests/` — flat, one file per concern (19 files, 221 tests), e.g.
  `stefan.test.ts` / `stefan_two_phase.test.ts` (analytic Stefan-problem
  benchmarks), `enthalpy.test.ts`, `boiling.test.ts`, `multimaterial.test.ts`.
- `scripts/export-frames.ts`, `docs/`.

## Install

```
npm ci
```
(canonical/CI command; the SessionStart hook uses `npm install` instead so
the container's cached `node_modules` layer is reused)

## Lint / format / typecheck

```
npm run lint        # eslint .
npm run typecheck   # tsc --noEmit
```

## Test

```
npm test            # vitest run — 19 files, 221 tests, ~2.4s
```
Fastest useful subset — one focused, fast file:
```
npx vitest run tests/stefan.test.ts
```

## Verification gate (source of truth)

The full `npm test` run (221 tests) is the gate and is cheap enough (~2.4s)
to run in full rather than sampling — there's little reason to use a subset
except for a quick sanity check while iterating. Within it,
`tests/stefan.test.ts` / `tests/stefan_two_phase.test.ts` are the
physics-accuracy anchor: they assert the simulated melt front against the
closed-form Stefan-problem solution `s(t) = 2*lambda*sqrt(alpha*t)` at
< 5% residual gap — this is what backs the "real, literature-informed
material constants" claim, as opposed to the deliberately simplified,
non-physical flow/viscosity automaton.

## Environment caveats (from audit)

- None specific to this repo — `npm ci` and `npm test` both ran clean, no
  network access needed beyond install, no browser/Playwright dependency.
- `npm audit` reports 2 moderate-severity vulnerabilities in devDependencies
  (not investigated; out of scope for behavior, doesn't affect test/lint).

## CI / conventions

- `ci.yml`: single `test` job — `npm ci`, lint, test, typecheck, build, on
  Node 24. Separate `gitleaks` job scans full history for secrets.
- Zero runtime dependencies (`package.json` has no `dependencies` key).
- No coverage floor is enforced.
