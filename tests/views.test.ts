import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { enthalpyFromTemperature } from '../src/core/enthalpy.ts'
import { createGrid, fillRect, idx } from '../src/core/grid.ts'
import { BG_COLOR, renderToRGBA } from '../src/render/renderer.ts'
import { isotherms, renderField, type ViewMode } from '../src/render/views.ts'

const wax = MATERIALS['wax']!
const ALL_MODES: ViewMode[] = ['material', 'temperature', 'phase', 'energy']

function pixel(buf: Uint8ClampedArray, i: number): [number, number, number, number] {
  return [buf[i * 4]!, buf[i * 4 + 1]!, buf[i * 4 + 2]!, buf[i * 4 + 3]!]
}

/** A grid whose row temperature increases linearly from top to bottom. */
function verticalRampGrid(width: number, height: number, tTop: number, tBot: number): ReturnType<typeof createGrid> {
  const g = createGrid(width, height, [wax])
  for (let y = 0; y < height; y++) {
    const T = tTop + (tBot - tTop) * (y / (height - 1))
    fillRect(g, wax, 0, y, width, 1, T)
  }
  return g
}

describe('renderField sizing and alpha', () => {
  for (const mode of ALL_MODES) {
    it(`returns a w*h*4 opaque buffer for '${mode}'`, () => {
      const g = createGrid(5, 4, [wax])
      fillRect(g, wax, 0, 0, 5, 4, 20)
      const buf = renderField(g, mode)
      expect(buf.length).toBe(5 * 4 * 4)
      for (let i = 0; i < 5 * 4; i++) expect(pixel(buf, i)[3]).toBe(255)
    })
  }

  it('reuses a provided output buffer', () => {
    const g = createGrid(2, 2, [wax])
    fillRect(g, wax, 0, 0, 2, 2, 20)
    const out = new Uint8ClampedArray(2 * 2 * 4)
    const ret = renderField(g, 'temperature', { out })
    expect(ret).toBe(out)
    expect(pixel(out, 0)[3]).toBe(255)
  })
})

describe('renderField empty cells', () => {
  for (const mode of ALL_MODES) {
    it(`paints empty cells BG_COLOR in '${mode}'`, () => {
      const g = createGrid(3, 1, [wax])
      // Only the middle cell has material; the outer two are empty.
      fillRect(g, wax, 1, 0, 1, 1, 20)
      const buf = renderField(g, mode)
      expect(pixel(buf, 0).slice(0, 3)).toEqual([...BG_COLOR])
      expect(pixel(buf, 2).slice(0, 3)).toEqual([...BG_COLOR])
    })
  }
})

describe("renderField 'material' mode", () => {
  it('is byte-identical to renderToRGBA', () => {
    const g = createGrid(4, 3, [wax])
    fillRect(g, wax, 0, 1, 4, 2, 55)
    const viaField = renderField(g, 'material')
    const viaRenderer = renderToRGBA(g)
    expect(Array.from(viaField)).toEqual(Array.from(viaRenderer))
  })
})

describe("renderField 'temperature' mode", () => {
  it('makes a hot cell redder and less blue than a cold cell', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, -10) // cold
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, 300) // hot
    const buf = renderField(g, 'temperature')
    const cold = pixel(buf, 0)
    const hot = pixel(buf, 1)
    expect(hot[0]).toBeGreaterThan(cold[0]!) // redder
    expect(hot[2]).toBeLessThan(cold[2]!) // less blue
  })

  it('respects an explicit tMin/tMax window', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, 10)
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, 90)
    const buf = renderField(g, 'temperature', { tMin: 0, tMax: 100 })
    expect(pixel(buf, 1)[0]).toBeGreaterThan(pixel(buf, 0)[0]!)
    expect(pixel(buf, 1)[2]).toBeLessThan(pixel(buf, 0)[2]!)
  })

  it('clamps temperatures outside the ramp window to the endpoints', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, -50) // below tMin
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, -20) // at tMin default
    const buf = renderField(g, 'temperature')
    // Both clamp to the cold end of the ramp, so identical colours.
    expect(pixel(buf, 0).slice(0, 3)).toEqual(pixel(buf, 1).slice(0, 3))
  })
})

describe("renderField 'phase' mode", () => {
  it('makes a molten cell differ from a solid cell', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, wax.Tsolidus - 20) // fully solid
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, wax.Tliquidus + 20) // fully molten
    const buf = renderField(g, 'phase')
    const solid = pixel(buf, 0).slice(0, 3)
    const molten = pixel(buf, 1).slice(0, 3)
    expect(molten).not.toEqual(solid)
  })

  it('makes a molten cell warmer (redder) than a solid cell', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, wax.Tsolidus - 20)
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, wax.Tliquidus + 20)
    const buf = renderField(g, 'phase')
    expect(pixel(buf, 1)[0]).toBeGreaterThan(pixel(buf, 0)[0]!)
  })
})

describe("renderField 'energy' mode", () => {
  it('makes a high-enthalpy cell differ from a low-enthalpy cell', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, -10)
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, 200)
    const buf = renderField(g, 'energy')
    expect(pixel(buf, 1)[0]).toBeGreaterThan(pixel(buf, 0)[0]!) // hotter -> redder
    expect(pixel(buf, 1)[2]).toBeLessThan(pixel(buf, 0)[2]!)
  })
})

describe('renderField partial fill', () => {
  it('blends a half-full cell toward the background', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, 200)
    g.mass[1] = 0.4
    g.energy[1] = 0.4 * enthalpyFromTemperature(wax, 200)
    const buf = renderField(g, 'temperature')
    const full = pixel(buf, 0)
    const half = pixel(buf, 1)
    for (const c of [0, 1, 2] as const) {
      const between =
        half[c]! >= Math.min(full[c]!, BG_COLOR[c]!) &&
        half[c]! <= Math.max(full[c]!, BG_COLOR[c]!)
      expect(between).toBe(true)
    }
  })
})

describe('isotherms', () => {
  it('returns a non-empty set of interior segments for a level inside the ramp', () => {
    const g = verticalRampGrid(6, 6, 0, 100)
    const segs = isotherms(g, [50])
    expect(segs.length).toBeGreaterThan(0)
    for (const s of segs) {
      // Endpoints must lie within the cell-space interior [0, width-1]x[0, height-1].
      expect(s.x0).toBeGreaterThanOrEqual(0)
      expect(s.x0).toBeLessThanOrEqual(g.width - 1)
      expect(s.y0).toBeGreaterThanOrEqual(0)
      expect(s.y0).toBeLessThanOrEqual(g.height - 1)
      expect(s.x1).toBeGreaterThanOrEqual(0)
      expect(s.x1).toBeLessThanOrEqual(g.width - 1)
      expect(s.y1).toBeGreaterThanOrEqual(0)
      expect(s.y1).toBeLessThanOrEqual(g.height - 1)
    }
  })

  it('places the 50C isotherm near the middle row of a 0..100 ramp', () => {
    const g = verticalRampGrid(6, 6, 0, 100)
    const segs = isotherms(g, [50])
    expect(segs.length).toBeGreaterThan(0)
    // The 50C line should sit around y = 2.5 in a 6-row 0..100 ramp.
    for (const s of segs) {
      expect(s.y0).toBeGreaterThan(1.5)
      expect(s.y0).toBeLessThan(3.5)
      expect(s.y1).toBeGreaterThan(1.5)
      expect(s.y1).toBeLessThan(3.5)
    }
  })

  it('returns [] when the level is above the whole field', () => {
    const g = verticalRampGrid(6, 6, 0, 100)
    expect(isotherms(g, [500])).toEqual([])
  })

  it('returns [] when the level is below the whole field', () => {
    const g = verticalRampGrid(6, 6, 0, 100)
    expect(isotherms(g, [-100])).toEqual([])
  })

  it('returns [] when no levels are requested', () => {
    const g = verticalRampGrid(6, 6, 0, 100)
    expect(isotherms(g, [])).toEqual([])
  })

  it('skips blocks touching empty cells (no contour off the material edge)', () => {
    // A single 2x2 patch of material in a larger empty grid: only that one
    // block has four massed corners, so contouring is confined to it.
    const g = createGrid(4, 4, [wax])
    g.mass[idx(g, 1, 1)] = 1
    g.energy[idx(g, 1, 1)] = enthalpyFromTemperature(wax, 0)
    g.mass[idx(g, 2, 1)] = 1
    g.energy[idx(g, 2, 1)] = enthalpyFromTemperature(wax, 0)
    g.mass[idx(g, 1, 2)] = 1
    g.energy[idx(g, 1, 2)] = enthalpyFromTemperature(wax, 100)
    g.mass[idx(g, 2, 2)] = 1
    g.energy[idx(g, 2, 2)] = enthalpyFromTemperature(wax, 100)
    const segs = isotherms(g, [50])
    expect(segs.length).toBeGreaterThan(0)
    for (const s of segs) {
      // Contour must live inside the single massed block spanning x,y in [1,2].
      for (const v of [s.x0, s.x1, s.y0, s.y1]) {
        expect(v).toBeGreaterThanOrEqual(1)
        expect(v).toBeLessThanOrEqual(2)
      }
    }
  })

  it('emits multiple levels together', () => {
    const g = verticalRampGrid(8, 8, 0, 140)
    const one = isotherms(g, [70])
    const many = isotherms(g, [35, 70, 105])
    expect(many.length).toBeGreaterThan(one.length)
  })
})
