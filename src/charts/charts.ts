/**
 * Pure data-to-geometry helpers for the bench's live plots and energy HUD.
 *
 * Nothing here touches the DOM: a `TimeSeries` ring buffer collects (t, v)
 * samples, `seriesToPolyline` maps a slice of samples into an SVG `points`
 * string, and `energyFlows` turns the simulator's energy ledger into an
 * ordered, signed list a thin UI layer can lay out as a budget bar. Keeping
 * this layer free of rendering concerns makes it trivially testable and keeps
 * the SVG math (in particular the y-flip) in one honest place.
 */

/** A single plotted sample: simulated time `t` against value `v`. */
export interface Point {
  t: number
  v: number
}

/**
 * Fixed-capacity ring buffer of (t, v) samples for a scrolling plot.
 *
 * Once `capacity` samples are stored, each `push` overwrites the oldest, so the
 * buffer always holds the newest N in chronological order. We keep a plain array
 * plus a head index and count rather than shifting a JS array, which would be
 * O(n) per push; `points()` materialises an oldest..newest copy on demand.
 */
export class TimeSeries {
  private readonly ts: number[]
  private readonly vs: number[]
  /** Index of the slot the next push will write to. */
  private head = 0
  private count = 0
  private readonly cap: number

  /**
   * @param capacity Maximum retained samples; must be a positive integer. A
   *   non-positive or non-integer capacity is a programming error (a plot with
   *   room for no points is meaningless), so we reject it eagerly.
   */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`TimeSeries capacity must be a positive integer, got ${capacity}`)
    }
    this.cap = capacity
    this.ts = new Array<number>(capacity)
    this.vs = new Array<number>(capacity)
  }

  /** Append one sample, dropping the oldest if the buffer is full. */
  push(t: number, v: number): void {
    this.ts[this.head] = t
    this.vs[this.head] = v
    this.head = (this.head + 1) % this.cap
    if (this.count < this.cap) this.count++
  }

  /**
   * Snapshot of retained samples, oldest first. The oldest live sample sits
   * `count` slots behind `head` (modulo capacity); we walk forward from there.
   */
  points(): Point[] {
    const out: Point[] = new Array<Point>(this.count)
    const start = (this.head - this.count + this.cap) % this.cap
    for (let n = 0; n < this.count; n++) {
      const i = (start + n) % this.cap
      out[n] = { t: this.ts[i]!, v: this.vs[i]! }
    }
    return out
  }

  /** Number of samples currently retained (0..capacity). */
  get length(): number {
    return this.count
  }

  /** Forget all samples; capacity is unchanged. */
  clear(): void {
    this.head = 0
    this.count = 0
  }
}

/** Explicit value/time range for `seriesToPolyline`. */
export interface PolylineRange {
  vMin: number
  vMax: number
  tMin?: number
  tMax?: number
}

/** Target box for `seriesToPolyline`, in SVG user units. */
export interface Box {
  w: number
  h: number
}

/**
 * Map samples to an SVG `points` string `"x0,y0 x1,y1 ..."`.
 *
 * x spans [0, box.w] across the t-range (defaulting to the first..last sample
 * t), and y spans [0, box.h] across the v-range with the axis FLIPPED so a
 * larger value sits nearer the top (smaller y), matching SVG's y-down
 * convention for a conventional-looking plot.
 *
 * Degenerate spans are handled without dividing by zero: a zero-width t-range
 * (one distinct time, or an explicit tMin === tMax) pins every x to 0, and a
 * zero-height v-range pins every y to the vertical midpoint. Empty input yields
 * `''` and a single point yields one `"x,y"` pair.
 */
export function seriesToPolyline(
  pts: Point[],
  box: Box,
  range?: PolylineRange,
): string {
  if (pts.length === 0) return ''

  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const tMin = range?.tMin ?? first.t
  const tMax = range?.tMax ?? last.t
  const tSpan = tMax - tMin

  // A default range is required for the v-axis: callers that omit it get a flat
  // line at mid-height rather than a NaN, but the intended use always supplies
  // one so the y-scale is stable frame to frame.
  const vMin = range?.vMin ?? 0
  const vMax = range?.vMax ?? 0
  const vSpan = vMax - vMin

  const coords = new Array<string>(pts.length)
  for (let n = 0; n < pts.length; n++) {
    const p = pts[n]!
    // With a single point (or a zero-width t-range) there is no horizontal
    // extent to interpolate over, so anchor x at the left edge.
    const x = tSpan === 0 ? 0 : ((p.t - tMin) / tSpan) * box.w
    // Flip: fraction 1 (v at vMax) maps to y = 0 (top). A flat v-range pins to
    // the midpoint so the line does not collapse onto an edge.
    const frac = vSpan === 0 ? 0.5 : (p.v - vMin) / vSpan
    const y = (1 - frac) * box.h
    coords[n] = `${x},${y}`
  }
  return coords.join(' ')
}

/**
 * The simulator's cumulative energy ledger (joules per metre of depth). Field
 * names mirror `Sim`'s ledger so a caller can pass the sim's fields straight
 * through. Signs follow the sim's convention: `heaterJoules`/`pouredJoules` are
 * energy added, `ventedJoules` is energy carried off by vapour (a magnitude the
 * ledger subtracts), and `ambientJoules`/`wallJoules` are signed exchanges that
 * heat or cool depending on the temperature difference.
 */
export interface Ledger {
  heaterJoules: number
  ambientJoules: number
  pouredJoules: number
  wallJoules: number
  ventedJoules: number
}

/** One signed contribution to the energy budget, ready for a stacked bar. */
export interface EnergyFlow {
  label: string
  joules: number
  kind: 'in' | 'out'
}

/**
 * Break the ledger into an ordered list of signed contributions for a budget
 * bar. Order is fixed (heater, poured, ambient, wall, vented) so the bar reads
 * consistently frame to frame regardless of which channels are active.
 *
 * Classification is purely by the joules crossing the boundary, not by the
 * channel's name: heater and poured energy is always inbound, vented energy is
 * always outbound, and the two signed exchanges (ambient, wall) are labelled
 * 'in' when they add energy and 'out' when they remove it. Vented is reported
 * as a positive magnitude with kind 'out', since the ledger stores it as the
 * (subtracted) amount lost. Channels reading exactly zero are dropped, so the
 * result contains only the flows actually in play.
 */
export function energyFlows(l: Ledger): EnergyFlow[] {
  const out: EnergyFlow[] = []
  // Heater and poured energy only ever enters; a negative reading would be a
  // ledger bug, so we still classify by sign rather than assuming.
  pushSigned(out, 'Heater', l.heaterJoules)
  pushSigned(out, 'Poured', l.pouredJoules)
  pushSigned(out, 'Ambient', l.ambientJoules)
  pushSigned(out, 'Wall', l.wallJoules)
  // Vented is stored as a positive amount subtracted from the ledger, so it is
  // inherently an outflow; report its magnitude.
  if (l.ventedJoules !== 0) {
    out.push({ label: 'Vented', joules: Math.abs(l.ventedJoules), kind: 'out' })
  }
  return out
}

/**
 * Append a signed channel, skipping exact zeros and classifying by sign. The
 * reported `joules` is a positive magnitude so a bar layout can size segments
 * directly from it and read direction off `kind`.
 */
function pushSigned(out: EnergyFlow[], label: string, joules: number): void {
  if (joules === 0) return
  out.push({ label, joules: Math.abs(joules), kind: joules > 0 ? 'in' : 'out' })
}
