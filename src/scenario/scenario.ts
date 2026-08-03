/**
 * Scenario serialisation: a pure, DOM-free descriptor of a full bench setup plus
 * lossless (de)serialisation to a URL query string and to JSON, and assembly
 * into a SimConfig.
 *
 * This is the reusable core behind the "shareable demo state" URLs that
 * src/ui/main.ts wires onto the page; keeping it here (rather than inline in the
 * DOM layer) makes the round-trip testable and lets tools build the same
 * configs headlessly.
 *
 * Design notes:
 *  - Percent fields (spanPct, centerPct) are 0..100 so they read cleanly in a
 *    URL; scenarioToSimConfig converts them to grid columns. speedExp is the
 *    base-10 exponent of the time-acceleration factor (10^speedExp), matching
 *    the UI's logarithmic speed slider.
 *  - Parsing is deliberately TOLERANT for query strings (an untrusted, hand-
 *    editable surface): out-of-range numbers are clamped, unknown/garbage keys
 *    are ignored, and an unknown or substrate materialId falls back to the base
 *    scenario rather than throwing. JSON parsing is STRICTER (it is a save
 *    format, not a hand-typed surface): structurally invalid input throws,
 *    though out-of-range numbers are still clamped for forward compatibility.
 */
import { MATERIALS, selectableMaterials, type Material } from '../core/materials.ts'
import type { ScenePreset, SimConfig } from '../core/sim.ts'

export interface Scenario {
  /** Id of the meltable subject material; must be a non-substrate MATERIALS key. */
  materialId: string
  preset: ScenePreset
  /** Which surface the heater faces, or 'off' to disable heating. */
  heaterSide: 'top' | 'bottom' | 'off'
  /** Heater power, kW. */
  powerKw: number
  /** Ambient temperature, degrees C. */
  ambient: number
  /** Heater span as a percentage of grid width, 0..100. */
  spanPct: number
  /** Heater centre as a percentage of grid width, 0..100. */
  centerPct: number
  /** Time-acceleration exponent: the sim runs 10^speedExp x wall-clock. */
  speedExp: number
  /** Seconds of simulated time to pre-advance before handing over. */
  warp?: number
  /** Start the sim running immediately. */
  autorun?: boolean
  /** Optional pour source (mould/casting scenes). Coordinates are percentages. */
  source?: {
    materialId: string
    /** Pour temperature, degrees C. */
    T: number
    /** Fill fraction injected per source column per second. */
    massRate: number
    /** Left edge of the source span, percent of width. */
    x0Pct: number
    /** Right edge of the source span, percent of width. */
    x1Pct: number
  }
  /** Optional cold/hot mould walls (Dirichlet reservoir). */
  mould?: {
    /** Fixed wall temperature, degrees C. */
    Twall: number
  }
}

/**
 * Inclusive clamp ranges. Power mirrors the UI slider (2..60 kW); the wider
 * temperature and rate bounds guard against absurd hand-edited values while
 * still admitting every scene the app ships. Kept as plain fields (no enums)
 * so the module stays erasable.
 */
const RANGE = {
  powerKw: [2, 60],
  ambient: [-100, 300],
  spanPct: [0, 100],
  centerPct: [0, 100],
  speedExp: [0, 6],
  warp: [0, 86_400],
  T: [-100, 350],
  massRate: [0, 1],
  Twall: [-100, 350],
} as const

const PRESETS: readonly ScenePreset[] = ['block', 'slab', 'mound', 'toast', 'mould']
const SIDES: readonly Scenario['heaterSide'][] = ['top', 'bottom', 'off']

export const DEFAULT_SCENARIO: Scenario = {
  materialId: 'cheese',
  preset: 'block',
  heaterSide: 'bottom',
  powerKw: 25,
  ambient: 22,
  spanPct: 40,
  centerPct: 50,
  speedExp: 2.1,
}

/** Clamp x into [lo, hi]; NaN/non-finite collapses to the fallback. */
function clamp(x: number, [lo, hi]: readonly [number, number], fallback: number): number {
  if (!Number.isFinite(x)) return fallback
  return Math.min(hi, Math.max(lo, x))
}

/** The set of ids the UI offers as the meltable subject (excludes substrates). */
const SELECTABLE_IDS: ReadonlySet<string> = new Set(selectableMaterials().map((m) => m.id))

/** True for a MATERIALS key that exists and may be chosen as the subject. */
function isSelectableId(id: string): boolean {
  return SELECTABLE_IDS.has(id)
}

/** Resolve a material id to a Material, falling back when unknown/substrate. */
function resolveMaterial(id: string, fallback: string): Material {
  const chosen = isSelectableId(id) ? id : fallback
  // fallback is a caller-controlled, validated id (DEFAULT_SCENARIO's), so this
  // lookup is provably present.
  return MATERIALS[chosen]!
}

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

/**
 * Serialise a scenario to a URL query string (no leading '?'). Optional fields
 * are emitted only when set, and autorun is a bare flag key when true, so a
 * minimal scenario yields a short, human-readable URL.
 */
export function scenarioToQuery(s: Scenario): string {
  const p = new URLSearchParams()
  p.set('material', s.materialId)
  p.set('scene', s.preset)
  p.set('side', s.heaterSide)
  p.set('power', String(s.powerKw))
  p.set('ambient', String(s.ambient))
  p.set('span', String(s.spanPct))
  p.set('center', String(s.centerPct))
  p.set('speed', String(s.speedExp))
  if (s.warp !== undefined) p.set('warp', String(s.warp))
  if (s.autorun) p.set('autorun', '1')
  if (s.source) {
    p.set('srcMaterial', s.source.materialId)
    p.set('srcT', String(s.source.T))
    p.set('srcRate', String(s.source.massRate))
    p.set('srcX0', String(s.source.x0Pct))
    p.set('srcX1', String(s.source.x1Pct))
  }
  if (s.mould) p.set('twall', String(s.mould.Twall))
  return p.toString()
}

/**
 * Parse a query string into a scenario, tolerantly. Every field falls back to
 * `base` (default DEFAULT_SCENARIO) when absent or invalid; numbers are clamped
 * to their range; an unknown or substrate material id falls back rather than
 * throwing. Unknown query keys are ignored. Accepts a leading '?'.
 */
export function scenarioFromQuery(q: string, base: Scenario = DEFAULT_SCENARIO): Scenario {
  const p = new URLSearchParams(q.startsWith('?') ? q.slice(1) : q)
  const num = (key: string, range: readonly [number, number], fb: number): number =>
    p.has(key) ? clamp(Number(p.get(key)), range, fb) : fb

  const mat = p.get('material')
  const materialId = mat !== null && isSelectableId(mat) ? mat : base.materialId

  const scene = p.get('scene')
  const preset =
    scene !== null && (PRESETS as readonly string[]).includes(scene)
      ? (scene as ScenePreset)
      : base.preset

  const side = p.get('side')
  const heaterSide =
    side !== null && (SIDES as readonly string[]).includes(side)
      ? (side as Scenario['heaterSide'])
      : base.heaterSide

  const s: Scenario = {
    materialId,
    preset,
    heaterSide,
    powerKw: num('power', RANGE.powerKw, base.powerKw),
    ambient: num('ambient', RANGE.ambient, base.ambient),
    spanPct: num('span', RANGE.spanPct, base.spanPct),
    centerPct: num('center', RANGE.centerPct, base.centerPct),
    speedExp: num('speed', RANGE.speedExp, base.speedExp),
  }

  if (p.has('warp')) s.warp = clamp(Number(p.get('warp')), RANGE.warp, base.warp ?? 0)
  else if (base.warp !== undefined) s.warp = base.warp

  if (p.has('autorun')) s.autorun = true
  else if (base.autorun) s.autorun = true

  // A source needs at least its material key to be meaningful; the rest of its
  // fields fall back to the base source (if any) or to neutral defaults.
  if (p.has('srcMaterial') || base.source) {
    const bs = base.source
    const srcId = p.get('srcMaterial')
    const srcMaterialId =
      srcId !== null && isSelectableId(srcId) ? srcId : (bs?.materialId ?? base.materialId)
    s.source = {
      materialId: srcMaterialId,
      T: p.has('srcT') ? clamp(Number(p.get('srcT')), RANGE.T, bs?.T ?? 100) : (bs?.T ?? 100),
      massRate: p.has('srcRate')
        ? clamp(Number(p.get('srcRate')), RANGE.massRate, bs?.massRate ?? 0.02)
        : (bs?.massRate ?? 0.02),
      x0Pct: p.has('srcX0')
        ? clamp(Number(p.get('srcX0')), RANGE.spanPct, bs?.x0Pct ?? 40)
        : (bs?.x0Pct ?? 40),
      x1Pct: p.has('srcX1')
        ? clamp(Number(p.get('srcX1')), RANGE.spanPct, bs?.x1Pct ?? 60)
        : (bs?.x1Pct ?? 60),
    }
  }

  if (p.has('twall')) s.mould = { Twall: clamp(Number(p.get('twall')), RANGE.Twall, base.mould?.Twall ?? 20) }
  else if (base.mould) s.mould = { Twall: base.mould.Twall }

  return s
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** Serialise a scenario to canonical JSON (pretty-printed, stable key order). */
export function scenarioToJSON(s: Scenario): string {
  const out: Scenario = {
    materialId: s.materialId,
    preset: s.preset,
    heaterSide: s.heaterSide,
    powerKw: s.powerKw,
    ambient: s.ambient,
    spanPct: s.spanPct,
    centerPct: s.centerPct,
    speedExp: s.speedExp,
  }
  if (s.warp !== undefined) out.warp = s.warp
  if (s.autorun !== undefined) out.autorun = s.autorun
  if (s.source) out.source = { ...s.source }
  if (s.mould) out.mould = { ...s.mould }
  return JSON.stringify(out, null, 2)
}

/** Assert that `v` is a finite number, else throw with a field-named message. */
function reqNum(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`scenario.${field} must be a finite number`)
  }
  return v
}

/**
 * Parse and validate a scenario from JSON. Throws on structurally invalid input
 * (not an object, wrong field types, unknown enum values), which distinguishes a
 * corrupt save from a merely stale one. Out-of-range numbers are clamped so a
 * file written by a future build with wider sliders still loads.
 */
export function scenarioFromJSON(j: string): Scenario {
  const raw: unknown = JSON.parse(j)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('scenario JSON must be an object')
  }
  const o = raw as Record<string, unknown>

  if (typeof o['materialId'] !== 'string' || !isSelectableId(o['materialId'])) {
    throw new Error('scenario.materialId must be a known non-substrate material')
  }
  if (typeof o['preset'] !== 'string' || !(PRESETS as readonly string[]).includes(o['preset'])) {
    throw new Error('scenario.preset is not a known scene preset')
  }
  if (typeof o['heaterSide'] !== 'string' || !(SIDES as readonly string[]).includes(o['heaterSide'])) {
    throw new Error('scenario.heaterSide must be top, bottom or off')
  }

  const s: Scenario = {
    materialId: o['materialId'],
    preset: o['preset'] as ScenePreset,
    heaterSide: o['heaterSide'] as Scenario['heaterSide'],
    powerKw: clamp(reqNum(o['powerKw'], 'powerKw'), RANGE.powerKw, DEFAULT_SCENARIO.powerKw),
    ambient: clamp(reqNum(o['ambient'], 'ambient'), RANGE.ambient, DEFAULT_SCENARIO.ambient),
    spanPct: clamp(reqNum(o['spanPct'], 'spanPct'), RANGE.spanPct, DEFAULT_SCENARIO.spanPct),
    centerPct: clamp(reqNum(o['centerPct'], 'centerPct'), RANGE.centerPct, DEFAULT_SCENARIO.centerPct),
    speedExp: clamp(reqNum(o['speedExp'], 'speedExp'), RANGE.speedExp, DEFAULT_SCENARIO.speedExp),
  }

  if (o['warp'] !== undefined) s.warp = clamp(reqNum(o['warp'], 'warp'), RANGE.warp, 0)
  if (o['autorun'] !== undefined) {
    if (typeof o['autorun'] !== 'boolean') throw new Error('scenario.autorun must be a boolean')
    s.autorun = o['autorun']
  }

  if (o['source'] !== undefined) {
    const src = o['source']
    if (typeof src !== 'object' || src === null || Array.isArray(src)) {
      throw new Error('scenario.source must be an object')
    }
    const so = src as Record<string, unknown>
    if (typeof so['materialId'] !== 'string' || !isSelectableId(so['materialId'])) {
      throw new Error('scenario.source.materialId must be a known non-substrate material')
    }
    s.source = {
      materialId: so['materialId'],
      T: clamp(reqNum(so['T'], 'source.T'), RANGE.T, 100),
      massRate: clamp(reqNum(so['massRate'], 'source.massRate'), RANGE.massRate, 0.02),
      x0Pct: clamp(reqNum(so['x0Pct'], 'source.x0Pct'), RANGE.spanPct, 40),
      x1Pct: clamp(reqNum(so['x1Pct'], 'source.x1Pct'), RANGE.spanPct, 60),
    }
  }

  if (o['mould'] !== undefined) {
    const mo = o['mould']
    if (typeof mo !== 'object' || mo === null || Array.isArray(mo)) {
      throw new Error('scenario.mould must be an object')
    }
    s.mould = {
      Twall: clamp(reqNum((mo as Record<string, unknown>)['Twall'], 'mould.Twall'), RANGE.Twall, 20),
    }
  }

  return s
}

// ---------------------------------------------------------------------------
// SimConfig assembly
// ---------------------------------------------------------------------------

/**
 * Convert a centre/span pair (both percent of width) into a half-open heater
 * column range [x0, x1) clamped to the grid, guaranteeing at least one column.
 * Mirrors the geometry the UI draws so the shared URL reproduces the same band.
 */
function spanToCols(centerPct: number, spanPct: number, width: number): { x0: number; x1: number } {
  const half = (spanPct / 100) * width / 2
  const c = (centerPct / 100) * width
  // Clamp x0 to width-1 BEFORE widening, so a zero span at the far edge
  // (centerPct=100, spanPct=0) still yields one in-grid column [width-1, width)
  // rather than an off-grid [width, width+1) that silently does nothing.
  const x0 = Math.min(width - 1, Math.round(Math.max(0, c - half)))
  const x1 = Math.min(width, Math.max(Math.round(Math.min(width, c + half)), x0 + 1))
  return { x0, x1 }
}

/**
 * Build a runnable SimConfig from a scenario and the target grid dimensions.
 * Resolves materialId -> Material via MATERIALS (falling back to the default
 * subject if somehow unresolved), places the heater columns from centre/span,
 * and threads through the pour source and mould walls when present. Ambient and
 * fixed physical knobs (convective coefficient, flow rate) match the UI so a
 * URL reproduces the on-screen bench.
 */
export function scenarioToSimConfig(
  s: Scenario,
  dims: { width: number; height: number; dx: number },
): SimConfig {
  const material = resolveMaterial(s.materialId, DEFAULT_SCENARIO.materialId)
  const { x0, x1 } = spanToCols(s.centerPct, s.spanPct, dims.width)
  const on = s.heaterSide !== 'off'

  const cfg: SimConfig = {
    width: dims.width,
    height: dims.height,
    material,
    dx: dims.dx,
    Tambient: s.ambient,
    // Start the subject cold (below its solidus) but never above ambient, as the
    // UI does; this keeps melting scenes starting solid.
    initialT: Math.min(s.ambient, material.Tsolidus - 5),
    hAmbient: 12,
    heater: {
      x0,
      x1,
      // 'off' has no side of its own; park it on 'top' and leave it disabled.
      side: s.heaterSide === 'off' ? 'top' : s.heaterSide,
      power: s.powerKw * 1000,
      on,
    },
    flowRate: 0.25,
    preset: s.preset,
  }

  if (s.source) {
    const cols = spanToCols(
      (s.source.x0Pct + s.source.x1Pct) / 2,
      Math.abs(s.source.x1Pct - s.source.x0Pct),
      dims.width,
    )
    cfg.source = {
      x0: cols.x0,
      x1: cols.x1,
      material: resolveMaterial(s.source.materialId, s.materialId),
      T: s.source.T,
      massRate: s.source.massRate,
      on: true,
    }
  }

  if (s.mould) cfg.mould = { Twall: s.mould.Twall }

  return cfg
}
