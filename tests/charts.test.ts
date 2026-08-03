import { describe, expect, it } from 'vitest'
import {
  TimeSeries,
  energyFlows,
  seriesToPolyline,
  type Ledger,
  type Point,
} from '../src/charts/charts.ts'

/** Parse an SVG points string back into numeric [x, y] pairs. */
function parse(points: string): [number, number][] {
  if (points === '') return []
  return points.split(' ').map((pair) => {
    const [x, y] = pair.split(',')
    return [Number(x), Number(y)] as [number, number]
  })
}

describe('TimeSeries', () => {
  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => new TimeSeries(0)).toThrow()
    expect(() => new TimeSeries(-3)).toThrow()
    expect(() => new TimeSeries(2.5)).toThrow()
  })

  it('reports length and yields points oldest..newest', () => {
    const ts = new TimeSeries(4)
    expect(ts.length).toBe(0)
    ts.push(0, 10)
    ts.push(1, 20)
    ts.push(2, 30)
    expect(ts.length).toBe(3)
    expect(ts.points()).toEqual([
      { t: 0, v: 10 },
      { t: 1, v: 20 },
      { t: 2, v: 30 },
    ])
  })

  it('keeps only the newest N samples once capacity is exceeded', () => {
    const ts = new TimeSeries(3)
    for (let t = 0; t < 6; t++) ts.push(t, t * t)
    expect(ts.length).toBe(3)
    // Oldest three (t=0,1,2) dropped; newest three retained in order.
    expect(ts.points()).toEqual([
      { t: 3, v: 9 },
      { t: 4, v: 16 },
      { t: 5, v: 25 },
    ])
  })

  it('preserves chronological order after wrapping many times', () => {
    const ts = new TimeSeries(2)
    for (let t = 0; t < 100; t++) ts.push(t, -t)
    expect(ts.points()).toEqual([
      { t: 98, v: -98 },
      { t: 99, v: -99 },
    ])
  })

  it('clear() empties the buffer but keeps capacity usable', () => {
    const ts = new TimeSeries(3)
    ts.push(0, 1)
    ts.push(1, 2)
    ts.clear()
    expect(ts.length).toBe(0)
    expect(ts.points()).toEqual([])
    ts.push(5, 9)
    expect(ts.points()).toEqual([{ t: 5, v: 9 }])
  })

  it('returns an independent snapshot each call', () => {
    const ts = new TimeSeries(2)
    ts.push(0, 1)
    const a = ts.points()
    ts.push(1, 2)
    // The earlier snapshot is not mutated by the later push.
    expect(a).toEqual([{ t: 0, v: 1 }])
  })
})

describe('seriesToPolyline', () => {
  const box = { w: 100, h: 50 }
  const range = { vMin: 0, vMax: 10 }

  it('returns an empty string for no points', () => {
    expect(seriesToPolyline([], box, range)).toBe('')
  })

  it('returns a single coordinate for one point', () => {
    const out = seriesToPolyline([{ t: 3, v: 5 }], box, range)
    const pts = parse(out)
    expect(pts.length).toBe(1)
    // Single point: x anchored at the left edge, y flipped for v=5 of [0,10].
    expect(pts[0]![0]).toBe(0)
    expect(pts[0]![1]).toBeCloseTo(25)
  })

  it('maps the first point to x=0 and the last to x=box.w by default', () => {
    const pts: Point[] = [
      { t: 2, v: 0 },
      { t: 4, v: 5 },
      { t: 10, v: 10 },
    ]
    const parsed = parse(seriesToPolyline(pts, box, range))
    expect(parsed[0]![0]).toBeCloseTo(0)
    expect(parsed[parsed.length - 1]![0]).toBeCloseTo(box.w)
  })

  it('interpolates x linearly across the default t-range', () => {
    const pts: Point[] = [
      { t: 0, v: 0 },
      { t: 5, v: 0 },
      { t: 10, v: 0 },
    ]
    const parsed = parse(seriesToPolyline(pts, box, range))
    expect(parsed[1]![0]).toBeCloseTo(50)
  })

  it('flips y: a larger value yields a smaller y within [0, box.h]', () => {
    const pts: Point[] = [
      { t: 0, v: 2 },
      { t: 1, v: 8 },
    ]
    const parsed = parse(seriesToPolyline(pts, box, range))
    const [, yLow] = parsed[0]!
    const [, yHigh] = parsed[1]!
    expect(yHigh).toBeLessThan(yLow)
    for (const [, y] of parsed) {
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(box.h)
    }
  })

  it('maps v=vMax to y=0 (top) and v=vMin to y=box.h (bottom)', () => {
    const pts: Point[] = [
      { t: 0, v: 0 },
      { t: 1, v: 10 },
    ]
    const parsed = parse(seriesToPolyline(pts, box, range))
    expect(parsed[0]![1]).toBeCloseTo(box.h)
    expect(parsed[1]![1]).toBeCloseTo(0)
  })

  it('honours an explicit t-range', () => {
    const pts: Point[] = [
      { t: 5, v: 0 },
      { t: 6, v: 0 },
    ]
    // Widen the window to [0, 10]: t=5 -> x=50, t=6 -> x=60.
    const parsed = parse(
      seriesToPolyline(pts, box, { vMin: 0, vMax: 10, tMin: 0, tMax: 10 }),
    )
    expect(parsed[0]![0]).toBeCloseTo(50)
    expect(parsed[1]![0]).toBeCloseTo(60)
  })

  it('pins x to 0 when the t-range has zero width', () => {
    const pts: Point[] = [
      { t: 7, v: 1 },
      { t: 7, v: 9 },
    ]
    const parsed = parse(seriesToPolyline(pts, box, range))
    expect(parsed[0]![0]).toBe(0)
    expect(parsed[1]![0]).toBe(0)
  })

  it('pins y to the midpoint when the v-range has zero height', () => {
    const pts: Point[] = [
      { t: 0, v: 4 },
      { t: 1, v: 4 },
    ]
    const parsed = parse(seriesToPolyline(pts, box, { vMin: 4, vMax: 4 }))
    for (const [, y] of parsed) expect(y).toBeCloseTo(box.h / 2)
  })
})

describe('energyFlows', () => {
  const zero: Ledger = {
    heaterJoules: 0,
    ambientJoules: 0,
    pouredJoules: 0,
    wallJoules: 0,
    ventedJoules: 0,
  }

  it('drops every channel when the ledger is empty', () => {
    expect(energyFlows(zero)).toEqual([])
  })

  it('labels and classifies inbound channels', () => {
    const flows = energyFlows({ ...zero, heaterJoules: 500, pouredJoules: 200 })
    expect(flows).toEqual([
      { label: 'Heater', joules: 500, kind: 'in' },
      { label: 'Poured', joules: 200, kind: 'in' },
    ])
  })

  it('classifies signed exchanges by sign', () => {
    const cooling = energyFlows({ ...zero, ambientJoules: -300, wallJoules: -80 })
    expect(cooling).toEqual([
      { label: 'Ambient', joules: 300, kind: 'out' },
      { label: 'Wall', joules: 80, kind: 'out' },
    ])
    const warming = energyFlows({ ...zero, ambientJoules: 40, wallJoules: 15 })
    expect(warming).toEqual([
      { label: 'Ambient', joules: 40, kind: 'in' },
      { label: 'Wall', joules: 15, kind: 'in' },
    ])
  })

  it('reports vented as an outbound positive magnitude', () => {
    const flows = energyFlows({ ...zero, ventedJoules: 250 })
    expect(flows).toEqual([{ label: 'Vented', joules: 250, kind: 'out' }])
  })

  it('emits channels in a fixed order and includes every non-zero channel', () => {
    const flows = energyFlows({
      heaterJoules: 1000,
      pouredJoules: 300,
      ambientJoules: -150,
      wallJoules: 60,
      ventedJoules: 40,
    })
    expect(flows.map((f) => f.label)).toEqual([
      'Heater',
      'Poured',
      'Ambient',
      'Wall',
      'Vented',
    ])
    expect(flows).toEqual([
      { label: 'Heater', joules: 1000, kind: 'in' },
      { label: 'Poured', joules: 300, kind: 'in' },
      { label: 'Ambient', joules: 150, kind: 'out' },
      { label: 'Wall', joules: 60, kind: 'in' },
      { label: 'Vented', joules: 40, kind: 'out' },
    ])
  })

  it('skips only the zero channels, keeping the rest in order', () => {
    const flows = energyFlows({ ...zero, heaterJoules: 100, ventedJoules: 10 })
    expect(flows.map((f) => f.label)).toEqual(['Heater', 'Vented'])
  })
})
