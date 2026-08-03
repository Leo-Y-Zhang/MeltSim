# Changelog

## 1.0.0 — 2026-07-08

A bidirectional thermodynamics sandbox: the one-way melting demo now melts,
freezes and boils, with instruments to watch it happen. All new physics stays
pure and unit-tested; runtime dependencies stay at zero.

### Physics

- **Boiling / evaporation** (`src/core/boiling.ts`): a per-cell enthalpy cap
  vaporises mass at the latent heat of vaporisation once a cell passes its
  boiling point, so a liquid plateaus at boiling and loses mass instead of
  superheating. Water gains `Tboil = 100 °C`, `latentVapor = 2.256 MJ/kg`;
  materials without a boiling point never boil. The pure `vaporiseCell` is
  tested to conserve energy exactly.
- **Solidification**: a pour **source** (`SourceConfig` — inject material of a
  chosen temperature over time) and a cold **mould** (`MouldConfig` + `mould`
  preset — a U-shaped Dirichlet reservoir of rigid wall cells held at `Twall`).
  Pour hot solder/wax into a cold mould and watch it set from the walls inward.
- **Energy ledger**: the sim tracks every joule crossing its boundary —
  `heaterJoules`, `ambientJoules`, `pouredJoules`, `wallJoules`, `ventedJoules`
  — and the invariant `totalJoules(now) == totalJoules(reset) + heater +
  ambient + poured + wall − vented` is asserted to float precision.
- **Two-phase Stefan benchmark**: a freezing half-space (superheated liquid +
  cold wall) validated against the analytic two-Stefan-number solution; the
  simulated freeze front lands within 8% of analytic (observed 6.1% → 2.6% as
  the front outgrows the mushy band), alongside the existing one-phase melt
  benchmark.
- **New materials**: gallium (melts at ~30 °C), butter, tin-lead solder
  (castable), and a rigid steel mould-wall material. A pure `withOverrides`
  backs a live material editor.

### Interface & tooling

- **Field views** (`src/render/views.ts`): material / temperature / phase /
  energy false-colour renders plus marching-squares **isotherm** contours, all
  pure and golden-tested.
- **Instruments**: live temperature-vs-time and molten-%-vs-time charts
  (`src/charts`), an energy-budget HUD, a casting scene with pour/mould
  controls, a material-tuning panel, and scenario **save / load / copy-link**
  (`src/scenario`, tolerant URL + JSON round-trip).
- New headless demos: `solder-cast`, `water-boil`, `gallium-melt`, and a
  four-view comparison strip.
- **ESLint** (flat config, typescript-eslint) added to the CI gate.
- 219 vitest tests (was 102); still zero runtime dependencies.

## 0.2.0 — 2026-07-07

Two-material scenes and an animated README demo.

- Grid cells now carry a material index (`Uint8Array`) over a per-grid
  material list; cells stay strictly single-material.
- New `toast` substrate preset (bread-like: light, insulating, melting band
  at 200–210 °C so it stays solid in every shipped scene).
- Conduction across mixed-material faces uses the harmonic mean of the two
  conductivities; face heat updates each side by its own density, so the
  conserved quantity across materials is joules — exposed by the new
  `totalJoules(grid, dx)` helper and asserted (to float precision) by the
  conservation tests. Single-material behaviour is unchanged.
- `stableDt` accepts a material list and returns the minimum bound over all
  materials present (legacy single-material call form still works).
- Flow obeys a same-material-only rule: mass moves between like cells or into
  empty cells (which adopt the source material); other materials act as rigid
  walls and floors. No mixing or displacement, ever — tested.
- New `toast` scene preset (substrate slab + block on top) in the sim, the
  bench UI and the URL parameters; `SimConfig` gains an optional `substrate`
  field. The material selector picks the top material only.
- Renderer colours every cell by its own material.
- New dependency-free animated GIF89a encoder (`src/gif`): own LZW with
  growing code sizes and dictionary reset, uniform-quantized global palette
  (exact when <= 256 colours), NETSCAPE2.0 looping. Verified by an
  independent parser + LZW decoder in the tests.
- Headless exporter now also writes `docs/media/cheese-on-toast.png` and the
  looping `docs/media/cheese-on-toast.gif` embedded at the top of the README.
- 102 vitest tests (was 59); still zero runtime dependencies.

### Breaking (internal API)

- `diffuse`, `flowStep` and `renderToRGBA` read each cell's material from the
  grid instead of taking a single `Material` argument; `createGrid` and
  `fillRect` take the material palette / material. The browser bench and
  exporter are updated; external behaviour of existing scenes is unchanged.

## 0.1.0 — 2026-07-06

Initial release.

- Enthalpy-method phase-change core (solid / mushy / liquid) with four
  material presets (ice, chocolate, cheese, wax).
- Explicit finite-volume conduction with exact pairwise energy conservation
  and automatic stable sub-stepping.
- Mass- and energy-conserving slumping automaton: gravity for unsupported
  mass, viscosity-gated lateral creep with a percolation threshold.
- Interactive browser bench: heater aiming, scenes, material/power/ambient/
  time-warp controls, probe readout, PNG snapshot, URL-parameter demo states.
- Pure RGBA renderer shared by the browser and the headless exporter;
  dependency-free PNG encoder; three exported demo scenes.
- 59 vitest unit tests (including a one-phase Stefan-problem benchmark:
  simulated melt front within 5% of the analytic solution, observed ~2-3%);
  strict TypeScript; zero runtime dependencies.
