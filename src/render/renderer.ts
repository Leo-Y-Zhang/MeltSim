/**
 * Pure rasteriser: grid state -> RGBA pixel buffer (one pixel per cell).
 * Shared by the browser canvas (via ImageData) and the headless PNG export,
 * so screenshots in the README are produced by exactly the code the demo
 * runs. Each cell is coloured by ITS OWN material (looked up through the
 * grid's per-cell material index), so multi-material scenes such as cheese
 * on toast render both palettes at once.
 */
import { liquidFraction, temperatureFromEnthalpy } from '../core/enthalpy.ts'
import { MASS_EPS, cellMaterial, specificEnthalpy, type Grid } from '../core/grid.ts'
import { T_MAX } from '../core/sim.ts'

export const BG_COLOR: readonly [number, number, number] = [18, 20, 26]
const GLOW_COLOR: readonly [number, number, number] = [255, 120, 30]
const GLOW_MAX = 0.45

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Render the grid into an RGBA buffer (allocated unless `out` is given). */
export function renderToRGBA(g: Grid, out?: Uint8ClampedArray): Uint8ClampedArray {
  const n = g.width * g.height
  const buf = out ?? new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const mass = g.mass[i]!
    let r = BG_COLOR[0]
    let gr = BG_COLOR[1]
    let b = BG_COLOR[2]
    if (mass > MASS_EPS) {
      const m = cellMaterial(g, i)
      const h = specificEnthalpy(g, i)
      const phi = liquidFraction(m, h)
      const T = temperatureFromEnthalpy(m, h)
      let cr = lerp(m.solidColor[0], m.meltColor[0], phi)
      let cg = lerp(m.solidColor[1], m.meltColor[1], phi)
      let cb = lerp(m.solidColor[2], m.meltColor[2], phi)
      if (T > m.Tliquidus) {
        const glow = Math.min(1, (T - m.Tliquidus) / (T_MAX - m.Tliquidus)) * GLOW_MAX
        cr = lerp(cr, GLOW_COLOR[0], glow)
        cg = lerp(cg, GLOW_COLOR[1], glow)
        cb = lerp(cb, GLOW_COLOR[2], glow)
      }
      const fill = Math.min(1, mass)
      r = lerp(BG_COLOR[0], cr, fill)
      gr = lerp(BG_COLOR[1], cg, fill)
      b = lerp(BG_COLOR[2], cb, fill)
    }
    buf[i * 4] = Math.round(r)
    buf[i * 4 + 1] = Math.round(gr)
    buf[i * 4 + 2] = Math.round(b)
    buf[i * 4 + 3] = 255
  }
  return buf
}
