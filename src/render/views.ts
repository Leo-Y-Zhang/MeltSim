/**
 * Alternative field visualisations of the grid, complementing renderer.ts
 * (which paints each cell in its material colour). These views expose the
 * scalar fields the physics actually solves - temperature, liquid fraction,
 * specific enthalpy - as false-colour images, plus marching-squares isotherm
 * contours for overlaying constant-temperature lines.
 *
 * All functions are pure: grid in, plain data out. The RGBA convention matches
 * renderToRGBA exactly - one pixel per cell, row-major, alpha 255, and empty
 * cells painted BG_COLOR - so a caller can swap views without touching the rest
 * of the pipeline.
 */
import { liquidFraction, temperatureFromEnthalpy, boilEnthalpy } from '../core/enthalpy.ts'
import { MASS_EPS, cellMaterial, specificEnthalpy, type Grid } from '../core/grid.ts'
import { BG_COLOR, renderToRGBA } from '../render/renderer.ts'

/** Which scalar field renderField paints. 'material' delegates to renderToRGBA. */
export type ViewMode = 'material' | 'temperature' | 'phase' | 'energy'

export interface FieldOptions {
  /** Lower bound of the temperature ramp, degC (temperature mode). */
  tMin?: number
  /** Upper bound of the temperature ramp, degC (temperature mode). */
  tMax?: number
  /** Optional output buffer to fill in place (length width*height*4). */
  out?: Uint8ClampedArray
}

/** Default temperature ramp span, chosen to bracket a typical melting scene. */
const DEFAULT_T_MIN = -20
const DEFAULT_T_MAX = 350

/**
 * A perceptual cool-to-warm ramp: blue -> cyan -> yellow -> red. Not a true
 * uniform colour space (that would need a lookup table we deliberately avoid to
 * stay dependency-free), but the four evenly spaced anchors read intuitively as
 * cold -> hot and keep hue monotically increasing, which is what the views and
 * tests rely on.
 */
const TEMP_RAMP: readonly (readonly [number, number, number])[] = [
  [26, 45, 168], // deep blue (cold)
  [40, 200, 220], // cyan
  [245, 220, 40], // yellow
  [200, 30, 30], // red (hot)
]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/**
 * Sample a piecewise-linear colour ramp at t in [0, 1]. t is clamped, then
 * mapped onto the (stops.length - 1) equal segments between anchor colours.
 */
function sampleRamp(
  stops: readonly (readonly [number, number, number])[],
  t: number,
): [number, number, number] {
  const n = stops.length
  const first = stops[0]!
  if (n === 1) return [first[0], first[1], first[2]]
  const clamped = clamp(t, 0, 1)
  const seg = clamped * (n - 1)
  // At exactly t=1 the index would land on the last stop with local=0, which
  // still returns that stop's colour; guard the index so it never overruns.
  const i = Math.min(n - 2, Math.floor(seg))
  const local = seg - i
  const a = stops[i]!
  const b = stops[i + 1]!
  return [
    lerp(a[0], b[0], local),
    lerp(a[1], b[1], local),
    lerp(a[2], b[2], local),
  ]
}

/**
 * A two-colour solid -> molten ramp for the phase view: a cool grey for fully
 * solid material warming to a molten orange as the liquid fraction rises.
 */
const PHASE_SOLID: readonly [number, number, number] = [110, 116, 128]
const PHASE_MOLTEN: readonly [number, number, number] = [255, 140, 30]

function writePixel(
  buf: Uint8ClampedArray,
  i: number,
  r: number,
  g: number,
  b: number,
): void {
  buf[i * 4] = Math.round(r)
  buf[i * 4 + 1] = Math.round(g)
  buf[i * 4 + 2] = Math.round(b)
  buf[i * 4 + 3] = 255
}

/**
 * The specific-enthalpy magnitude used by the 'energy' view. Enthalpy is
 * signed (0 at the solidus, negative for cold solid, up to the boiling
 * enthalpy for a fully molten cell), so we normalise |h| against a per-cell
 * reference span - the distance from a cold solid floor to the boiling
 * enthalpy - to get a 0..1 intensity that behaves the same for any material.
 * Materials that never boil fall back to their latent heat plus a decade of
 * liquid sensible heat as the reference, so the ramp still spans a sensible
 * range instead of collapsing against +Infinity.
 */
function energyIntensity(g: Grid, i: number): number {
  const m = cellMaterial(g, i)
  const h = specificEnthalpy(g, i)
  // Reference cold floor: enthalpy of solid material 100 K below the solidus.
  const hCold = m.cSolid * -100
  const hBoil = boilEnthalpy(m)
  const hHot = Number.isFinite(hBoil) ? hBoil : m.latentHeat + m.cLiquid * 300
  const span = hHot - hCold
  if (span <= 0) return 0
  return clamp((h - hCold) / span, 0, 1)
}

/**
 * Paint the grid into an RGBA buffer using the chosen scalar field. 'material'
 * defers to renderToRGBA for a byte-identical result; the other modes false-
 * colour a field and paint empty cells BG_COLOR. Returns the (optionally
 * provided) buffer.
 */
export function renderField(
  g: Grid,
  mode: ViewMode,
  opts?: FieldOptions,
): Uint8ClampedArray {
  // 'material' is the material-colour view; defer to the canonical rasteriser
  // so this mode is byte-identical to renderToRGBA (and reuses `out` too).
  if (mode === 'material') return renderToRGBA(g, opts?.out)
  const n = g.width * g.height
  const buf = opts?.out ?? new Uint8ClampedArray(n * 4)
  const tMin = opts?.tMin ?? DEFAULT_T_MIN
  const tMax = opts?.tMax ?? DEFAULT_T_MAX
  const tSpan = tMax - tMin
  for (let i = 0; i < n; i++) {
    const mass = g.mass[i]!
    if (mass <= MASS_EPS) {
      writePixel(buf, i, BG_COLOR[0], BG_COLOR[1], BG_COLOR[2])
      continue
    }
    let color: [number, number, number]
    if (mode === 'temperature') {
      const m = cellMaterial(g, i)
      const T = temperatureFromEnthalpy(m, specificEnthalpy(g, i))
      const t = tSpan > 0 ? (T - tMin) / tSpan : 0
      color = sampleRamp(TEMP_RAMP, t)
    } else if (mode === 'phase') {
      const m = cellMaterial(g, i)
      const phi = liquidFraction(m, specificEnthalpy(g, i))
      color = [
        lerp(PHASE_SOLID[0], PHASE_MOLTEN[0], phi),
        lerp(PHASE_SOLID[1], PHASE_MOLTEN[1], phi),
        lerp(PHASE_SOLID[2], PHASE_MOLTEN[2], phi),
      ]
    } else {
      // energy: reuse the temperature ramp keyed on enthalpy intensity so the
      // three field views share one legible cold->hot colour language.
      color = sampleRamp(TEMP_RAMP, energyIntensity(g, i))
    }
    // Fade toward the background for partly filled cells, mirroring the fill
    // blend renderToRGBA applies, so thin melt films do not read as solid.
    const fill = Math.min(1, mass)
    writePixel(
      buf,
      i,
      lerp(BG_COLOR[0], color[0], fill),
      lerp(BG_COLOR[1], color[1], fill),
      lerp(BG_COLOR[2], color[2], fill),
    )
  }
  return buf
}

/** A line segment in cell-space coordinates (cell centres sit on integer grid points). */
export interface IsoSegment {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The temperature at cell (x, y), or undefined if the cell is empty. Kept as a
 * small helper so the marching-squares pass can require all four corners of a
 * block to carry mass before contouring it.
 */
function cellTemperature(g: Grid, x: number, y: number): number | undefined {
  const i = y * g.width + x
  if (g.mass[i]! <= MASS_EPS) return undefined
  const m = cellMaterial(g, i)
  return temperatureFromEnthalpy(m, specificEnthalpy(g, i))
}

/**
 * The point where `level` crosses the edge between two cell centres at values
 * va and vb, returned as the interpolation fraction in [0, 1] from a to b.
 * Assumes the level lies between va and vb (the caller checks the sign change).
 */
function crossFraction(va: number, vb: number, level: number): number {
  const d = vb - va
  if (d === 0) return 0.5
  return clamp((level - va) / d, 0, 1)
}

/**
 * Marching squares on the cell-centre temperature field. For every 2x2 block of
 * cells whose four corners all carry mass, and for every requested level, we
 * emit the line segment(s) where the bilinear field crosses that level. Corner
 * coordinates are the cell centres (integer cell-space points), so a segment's
 * endpoints are interpolated along the block's edges.
 *
 * The classic 16-case table is generated on the fly: we test each of the four
 * edges for a sign change relative to the level, collect the crossing points,
 * and pair them. Saddle blocks (two diagonal corners above the level) produce
 * two segments; we resolve them with the standard "average of the four
 * corners" rule so the contour stays consistent. Blocks touching an empty cell
 * are skipped entirely - contouring a field that is undefined at a corner would
 * invent an edge where there is no material.
 */
export function isotherms(g: Grid, levels: number[]): IsoSegment[] {
  const segments: IsoSegment[] = []
  if (levels.length === 0) return segments
  for (let y = 0; y < g.height - 1; y++) {
    for (let x = 0; x < g.width - 1; x++) {
      // Corners in (x, y) cell-space: TL, TR, BR, BL going clockwise.
      const tl = cellTemperature(g, x, y)
      const tr = cellTemperature(g, x + 1, y)
      const br = cellTemperature(g, x + 1, y + 1)
      const bl = cellTemperature(g, x, y + 1)
      if (tl === undefined || tr === undefined || br === undefined || bl === undefined) {
        continue
      }
      for (const level of levels) {
        contourBlock(x, y, tl, tr, br, bl, level, segments)
      }
    }
  }
  return segments
}

/**
 * Emit the isoline segment(s) for a single fully-massed 2x2 block. The four
 * edges are, in order: top (TL-TR), right (TR-BR), bottom (BR-BL), left
 * (BL-TL). We record a crossing on any edge whose endpoints straddle `level`,
 * then connect the crossings. Two crossings -> one segment; four crossings
 * (a saddle) -> two segments paired by the block-centre average.
 */
function contourBlock(
  x: number,
  y: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
  level: number,
  out: IsoSegment[],
): void {
  // Points are stored as [px, py] in cell-space. Collect edge crossings in a
  // fixed edge order so saddle pairing below is deterministic.
  const pts: [number, number][] = []
  const edges: number[] = []
  // Top edge TL-TR at y.
  if (straddles(tl, tr, level)) {
    pts.push([x + crossFraction(tl, tr, level), y])
    edges.push(0)
  }
  // Right edge TR-BR at x+1.
  if (straddles(tr, br, level)) {
    pts.push([x + 1, y + crossFraction(tr, br, level)])
    edges.push(1)
  }
  // Bottom edge BR-BL at y+1.
  if (straddles(br, bl, level)) {
    pts.push([x + 1 - crossFraction(br, bl, level), y + 1])
    edges.push(2)
  }
  // Left edge BL-TL at x.
  if (straddles(bl, tl, level)) {
    pts.push([x, y + 1 - crossFraction(bl, tl, level)])
    edges.push(3)
  }
  if (pts.length === 2) {
    const a = pts[0]!
    const b = pts[1]!
    out.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] })
    return
  }
  if (pts.length === 4) {
    // Saddle: use the block-centre average to decide which crossings pair up.
    const centre = (tl + tr + br + bl) / 4
    // Edges came in order [top(0), right(1), bottom(2), left(3)]. Depending on
    // whether the centre is above or below the level, connect top-left with
    // bottom-right or top-right with bottom-left.
    const p0 = pts[0]!
    const p1 = pts[1]!
    const p2 = pts[2]!
    const p3 = pts[3]!
    if (centre >= level) {
      out.push({ x0: p0[0], y0: p0[1], x1: p1[0], y1: p1[1] })
      out.push({ x0: p2[0], y0: p2[1], x1: p3[0], y1: p3[1] })
    } else {
      out.push({ x0: p0[0], y0: p0[1], x1: p3[0], y1: p3[1] })
      out.push({ x0: p1[0], y0: p1[1], x1: p2[0], y1: p2[1] })
    }
  }
  // pts.length of 0 (or the degenerate odd counts that exact-equality corners
  // can never reach here) contributes nothing.
}

/** True when `level` lies strictly between a and b, or exactly on one end. */
function straddles(a: number, b: number, level: number): boolean {
  const lo = a < b ? a : b
  const hi = a < b ? b : a
  // Exclude the case where both corners equal the level (no crossing, and
  // including it would emit a zero-length or duplicated segment on flat cells).
  if (lo === hi) return false
  return level >= lo && level <= hi
}
