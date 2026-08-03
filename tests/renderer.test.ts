import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { enthalpyFromTemperature } from '../src/core/enthalpy.ts'
import { createGrid, idx } from '../src/core/grid.ts'
import { BG_COLOR, renderToRGBA } from '../src/render/renderer.ts'

const wax = MATERIALS['wax']!

function pixel(buf: Uint8ClampedArray, i: number): [number, number, number, number] {
  return [buf[i * 4]!, buf[i * 4 + 1]!, buf[i * 4 + 2]!, buf[i * 4 + 3]!]
}

describe('renderToRGBA', () => {
  it('produces a w*h*4 buffer with opaque alpha', () => {
    const g = createGrid(5, 4)
    const buf = renderToRGBA(g)
    expect(buf.length).toBe(5 * 4 * 4)
    for (let i = 0; i < 20; i++) expect(pixel(buf, i)[3]).toBe(255)
  })

  it('renders empty cells as the background colour', () => {
    const g = createGrid(2, 2)
    const buf = renderToRGBA(g)
    expect(pixel(buf, 0).slice(0, 3)).toEqual([...BG_COLOR])
  })

  it('renders cold solid cells with the solid colour', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, wax.Tsolidus - 30)
    const buf = renderToRGBA(g)
    expect(pixel(buf, 0).slice(0, 3)).toEqual([...wax.solidColor])
  })

  it('renders molten cells closer to the melt colour than solid cells are', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, wax.Tsolidus - 30)
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, wax.Tliquidus)
    const buf = renderToRGBA(g)
    const dist = (p: number[], c: readonly number[]) =>
      Math.hypot(p[0]! - c[0]!, p[1]! - c[1]!, p[2]! - c[2]!)
    const solidPix = pixel(buf, 0).slice(0, 3) as number[]
    const moltenPix = pixel(buf, 1).slice(0, 3) as number[]
    expect(dist(moltenPix, wax.meltColor)).toBeLessThan(dist(solidPix, wax.meltColor))
  })

  it('adds a warm glow to strongly superheated cells', () => {
    const g = createGrid(2, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, wax.Tliquidus)
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, 300)
    const buf = renderToRGBA(g)
    // superheated pixel should be at least as red and less blue than at liquidus
    expect(pixel(buf, 1)[0]).toBeGreaterThanOrEqual(pixel(buf, 0)[0]!)
    expect(pixel(buf, 1)[2]).toBeLessThan(pixel(buf, 0)[2]!)
  })

  it('blends partially filled cells toward the background', () => {
    const g = createGrid(3, 1, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, 20)
    g.mass[1] = 0.5
    g.energy[1] = 0.5 * enthalpyFromTemperature(wax, 20)
    const full = pixel(renderToRGBA(g), 0)
    const half = pixel(renderToRGBA(g), 1)
    const bg = BG_COLOR
    for (const c of [0, 1, 2] as const) {
      const between =
        (half[c]! >= Math.min(full[c]!, bg[c]!) && half[c]! <= Math.max(full[c]!, bg[c]!))
      expect(between).toBe(true)
    }
  })

  it('reuses a provided output buffer', () => {
    const g = createGrid(2, 2, [wax])
    g.mass[idx(g, 0, 0)] = 1
    g.energy[idx(g, 0, 0)] = enthalpyFromTemperature(wax, 20)
    const out = new Uint8ClampedArray(2 * 2 * 4)
    const ret = renderToRGBA(g, out)
    expect(ret).toBe(out)
    expect(pixel(out, 0).slice(0, 3)).toEqual([...wax.solidColor])
  })
})
