import { describe, expect, it } from 'vitest'
import { MATERIALS, listMaterials } from '../src/core/materials.ts'
import {
  enthalpyFromTemperature,
  liquidFraction,
  temperatureFromEnthalpy,
} from '../src/core/enthalpy.ts'
import {
  MASS_EPS,
  cellMaterial,
  createGrid,
  fillRect,
  idx,
  materialIndex,
  materialMass,
  totalEnergy,
  totalJoules,
  totalMass,
} from '../src/core/grid.ts'
import { diffuse, stableDt } from '../src/core/heat.ts'
import { flowStep } from '../src/core/flow.ts'

const cheese = MATERIALS['cheese']!
const toast = MATERIALS['toast']!
const wax = MATERIALS['wax']!

const DX = 0.01

describe('toast substrate material', () => {
  it('exists, is flagged as a substrate, and is excluded from selectable materials', () => {
    expect(toast).toBeDefined()
    expect(toast.substrate).toBe(true)
    for (const id of ['ice', 'chocolate', 'cheese', 'wax']) {
      expect(MATERIALS[id]!.substrate).toBeUndefined()
    }
    expect(listMaterials()).toContain(toast)
  })

  it('has a melting band far above every demo material so it stays solid', () => {
    expect(toast.Tsolidus).toBeGreaterThan(350) // above T_MAX: cannot melt
    expect(toast.Tliquidus).toBeGreaterThan(350)
    for (const m of [MATERIALS['ice']!, MATERIALS['chocolate']!, cheese, wax]) {
      expect(toast.Tsolidus).toBeGreaterThan(m.Tliquidus + 100)
    }
    // bread-like: light, insulating
    expect(toast.rho).toBeLessThan(500)
    expect(toast.k).toBeLessThan(0.1)
  })
})

describe('grid material bookkeeping', () => {
  it('registers materials on demand and looks up cell materials', () => {
    const g = createGrid(2, 1)
    expect(materialIndex(g, cheese)).toBe(0)
    expect(materialIndex(g, toast)).toBe(1)
    expect(materialIndex(g, cheese)).toBe(0) // idempotent
    g.mass[0] = 1
    g.matIndex[0] = 1
    expect(cellMaterial(g, 0)).toBe(toast)
    expect(cellMaterial(g, 1)).toBe(cheese) // default index 0
  })

  it('fillRect stamps the material index of every filled cell', () => {
    const g = createGrid(4, 2)
    fillRect(g, toast, 0, 1, 4, 1, 20)
    fillRect(g, cheese, 1, 0, 2, 1, 20)
    expect(cellMaterial(g, idx(g, 0, 1))).toBe(toast)
    expect(cellMaterial(g, idx(g, 3, 1))).toBe(toast)
    expect(cellMaterial(g, idx(g, 1, 0))).toBe(cheese)
  })

  it('totalJoules weights each cell by its own density', () => {
    const g = createGrid(2, 1, [cheese, toast])
    g.mass[0] = 1
    g.energy[0] = 1000
    g.matIndex[0] = 0
    g.mass[1] = 1
    g.energy[1] = 500
    g.matIndex[1] = 1
    const expected = (1000 * cheese.rho + 500 * toast.rho) * DX * DX
    expect(totalJoules(g, DX)).toBeCloseTo(expected, 9)
  })

  it('totalJoules reduces to totalEnergy * rho * dx^2 on single-material grids', () => {
    const g = createGrid(5, 3)
    fillRect(g, wax, 0, 0, 5, 3, 70)
    expect(totalJoules(g, DX)).toBeCloseTo(totalEnergy(g) * wax.rho * DX * DX, 8)
  })

  it('materialMass sums fill per material', () => {
    const g = createGrid(3, 1, [cheese, toast])
    g.mass[0] = 1
    g.matIndex[0] = 0
    g.mass[1] = 0.25
    g.matIndex[1] = 1
    expect(materialMass(g, cheese)).toBeCloseTo(1, 12)
    expect(materialMass(g, toast)).toBeCloseTo(0.25, 12)
    expect(materialMass(g, wax)).toBe(0)
  })
})

describe('stableDt over multiple materials', () => {
  it('is at most the minimum of the per-material bounds', () => {
    const single = [cheese, toast, wax].map((m) => stableDt(m, DX))
    expect(stableDt([cheese, toast, wax], DX)).toBeLessThanOrEqual(Math.min(...single))
  })

  it('tightens the bound for the worst harmonic-mean mixed face', () => {
    // toast against cheese: kFace = 2*0.35*0.08/0.43 ~ 0.130 > toast's own
    // 0.08, so the pair bound must be governed by toast at that face k,
    // NOT by the naive min of the two single-material bounds.
    const kFace = (2 * cheese.k * toast.k) / (cheese.k + toast.k)
    expect(kFace).toBeGreaterThan(toast.k)
    const cToast = Math.min(toast.cSolid, toast.cLiquid)
    const expected = (0.9 * DX * DX * toast.rho * cToast) / (4 * kFace)
    expect(stableDt([cheese, toast], DX)).toBeCloseTo(expected, 12)
    expect(stableDt([cheese, toast], DX)).toBeLessThan(
      Math.min(stableDt(cheese, DX), stableDt(toast, DX)),
    )
  })

  it('reduces exactly to the classic single-material bound (legacy call form)', () => {
    const cMin = Math.min(cheese.cSolid, cheese.cLiquid)
    const classic = (0.9 * DX * DX * cheese.rho * cMin) / (4 * cheese.k)
    expect(stableDt(cheese, DX)).toBe(classic)
    expect(stableDt([cheese], DX)).toBe(classic)
  })

  it('rejects an empty material list', () => {
    expect(() => stableDt([], DX)).toThrow()
  })
})

describe('discrete maximum principle on mixed grids at stableDt', () => {
  // Regression: with the naive min-of-single-bounds dt, a toast cell with
  // several cheese faces saw temperatures overshoot the initial extremes by
  // tens of degrees (194 C from a 20..150 C initial state).
  const tempRange = (g: ReturnType<typeof createGrid>): [number, number] => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < g.mass.length; i++) {
      if (g.mass[i]! <= MASS_EPS) continue
      const T = temperatureFromEnthalpy(cellMaterial(g, i), g.energy[i]! / g.mass[i]!)
      if (T < lo) lo = T
      if (T > hi) hi = T
    }
    return [lo, hi]
  }

  it('an isolated toast cell surrounded by hot cheese never overshoots', () => {
    const g = createGrid(5, 5, [cheese, toast])
    fillRect(g, cheese, 0, 0, 5, 5, 150)
    fillRect(g, toast, 2, 2, 1, 1, 20)
    const dt = stableDt([cheese, toast], DX)
    for (let s = 0; s < 4000; s++) {
      diffuse(g, DX, dt)
      const [lo, hi] = tempRange(g)
      expect(lo).toBeGreaterThanOrEqual(20 - 1e-6)
      expect(hi).toBeLessThanOrEqual(150 + 1e-6)
    }
  })

  it('a cheese/toast checkerboard stays within its initial bounds', () => {
    const N = 8
    const g = createGrid(N, N, [cheese, toast])
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const hot = (x + y) % 2 === 0
        fillRect(g, hot ? cheese : toast, x, y, 1, 1, hot ? 150 : 20)
      }
    }
    const dt = stableDt([cheese, toast], DX)
    for (let s = 0; s < 5000; s++) diffuse(g, DX, dt)
    const [lo, hi] = tempRange(g)
    expect(lo).toBeGreaterThanOrEqual(20 - 1e-6)
    expect(hi).toBeLessThanOrEqual(150 + 1e-6)
    for (const e of g.energy) expect(Number.isFinite(e)).toBe(true)
  })
})

describe('conduction across mixed-material faces', () => {
  it('uses the harmonic-mean conductivity and per-density enthalpy updates', () => {
    const g = createGrid(2, 1, [cheese, toast])
    const Thot = 100
    const Tcold = 20
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(cheese, Thot)
    g.matIndex[0] = 0
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(toast, Tcold)
    g.matIndex[1] = 1
    const e0 = g.energy[0]!
    const e1 = g.energy[1]!
    const dt = stableDt([cheese, toast], DX)
    diffuse(g, DX, dt)
    const kf = (2 * cheese.k * toast.k) / (cheese.k + toast.k)
    const q = kf * dt * (Tcold - Thot) // joules through the face, from cheese's view
    expect(g.energy[0]! - e0).toBeCloseTo(q / (cheese.rho * DX * DX), 8)
    expect(g.energy[1]! - e1).toBeCloseTo(-q / (toast.rho * DX * DX), 8)
  })

  it('conserves joules (not raw fill-weighted enthalpy) on a mixed insulated grid', () => {
    const g = createGrid(10, 6, [cheese, toast])
    fillRect(g, toast, 0, 4, 10, 2, 20)
    fillRect(g, cheese, 2, 1, 6, 3, 180)
    const j0 = totalJoules(g, DX)
    const e0 = totalEnergy(g)
    const dt = stableDt([cheese, toast], DX)
    for (let i = 0; i < 500; i++) diffuse(g, DX, dt)
    const j1 = totalJoules(g, DX)
    expect(Math.abs(j1 - j0) / Math.abs(j0)).toBeLessThan(1e-10)
    // the raw specific-enthalpy sum genuinely drifts across densities,
    // which is exactly why the conserved quantity is joules
    expect(Math.abs(totalEnergy(g) - e0)).toBeGreaterThan(1)
  })

  it('warms the toast under hot cheese (heat crosses the material boundary)', () => {
    const g = createGrid(1, 2, [cheese, toast])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(cheese, 120)
    g.matIndex[0] = 0
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(toast, 20)
    g.matIndex[1] = 1
    const dt = stableDt([cheese, toast], DX)
    for (let i = 0; i < 400; i++) diffuse(g, DX, dt)
    expect(g.energy[1]!).toBeGreaterThan(enthalpyFromTemperature(toast, 20))
  })

  it('keeps single-material behaviour identical in kind: uniform grids stay unchanged', () => {
    const g = createGrid(4, 4, [cheese, toast])
    fillRect(g, toast, 0, 2, 4, 2, 35)
    fillRect(g, cheese, 0, 0, 4, 2, 35)
    // NOT unchanged (different materials at the same T stay at the same T:
    // dT = 0 across every face), so energies must be exactly static
    const snapshot = Array.from(g.energy)
    for (let i = 0; i < 50; i++) diffuse(g, DX, stableDt([cheese, toast], DX))
    expect(Array.from(g.energy)).toEqual(snapshot)
  })
})

describe('flow with multiple materials', () => {
  const HOT_CHEESE = enthalpyFromTemperature(cheese, cheese.Tliquidus + 40)

  it('never lets material fall into a cell of a different material', () => {
    const g = createGrid(1, 2, [cheese, toast])
    g.mass[0] = 1
    g.energy[0] = HOT_CHEESE
    g.matIndex[0] = 0
    g.mass[1] = 0.5 // partially filled toast below: headroom, but a wall
    g.energy[1] = 0.5 * enthalpyFromTemperature(toast, 20)
    g.matIndex[1] = 1
    for (let s = 0; s < 100; s++) flowStep(g, 0.3, s)
    expect(g.mass[0]).toBe(1)
    expect(g.mass[1]).toBe(0.5)
    expect(g.matIndex[0]).toBe(0)
    expect(g.matIndex[1]).toBe(1)
  })

  it('never creeps sideways into a cell of a different material', () => {
    const g = createGrid(3, 1, [toast, cheese])
    g.mass[0] = 0.4 // partial toast wall
    g.energy[0] = 0.4 * enthalpyFromTemperature(toast, 20)
    g.matIndex[0] = 0
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(cheese, cheese.Tliquidus + 40)
    g.matIndex[1] = 1
    for (let s = 0; s < 100; s++) flowStep(g, 0.3, s)
    expect(g.mass[0]).toBe(0.4)
    expect(g.matIndex[0]).toBe(0)
    // cheese spread only into the empty right-hand cell
    expect(g.mass[2]!).toBeGreaterThan(0.05)
    expect(g.matIndex[2]).toBe(1)
  })

  it('lets falling material claim empty cells (index adoption)', () => {
    const g = createGrid(1, 4, [toast, cheese])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(cheese, 20)
    g.matIndex[0] = 1 // cheese on top; empty cells default to index 0 (toast)
    for (let s = 0; s < 10; s++) flowStep(g, 0.3, s)
    expect(g.mass[3]!).toBeCloseTo(1, 9)
    expect(g.matIndex[3]).toBe(1) // adopted cheese, not the default index
    expect(cellMaterial(g, 3)).toBe(cheese)
  })

  it('conserves joules, total mass and per-material mass through mixed flow', () => {
    const g = createGrid(9, 8, [cheese, toast])
    fillRect(g, toast, 0, 6, 9, 2, 20)
    fillRect(g, cheese, 3, 2, 3, 3, cheese.Tliquidus + 50)
    const m0 = totalMass(g)
    const mCheese0 = materialMass(g, cheese)
    const mToast0 = materialMass(g, toast)
    const j0 = totalJoules(g, DX)
    for (let s = 0; s < 300; s++) flowStep(g, 0.3, s)
    expect(totalMass(g)).toBeCloseTo(m0, 9)
    expect(materialMass(g, cheese)).toBeCloseTo(mCheese0, 9)
    expect(materialMass(g, toast)).toBeCloseTo(mToast0, 9)
    expect(Math.abs(totalJoules(g, DX) - j0) / Math.abs(j0)).toBeLessThan(1e-9)
  })

  it('slumps molten cheese OVER the toast without displacing a single toast cell', () => {
    const width = 11
    const height = 8
    const g = createGrid(width, height, [cheese, toast])
    fillRect(g, toast, 0, 6, width, 2, 20) // slab on the floor
    fillRect(g, cheese, 4, 3, 3, 3, cheese.Tliquidus + 50) // molten block on top
    const toastCells = new Set<number>()
    for (let i = 0; i < width * height; i++) {
      if (g.mass[i]! > MASS_EPS && g.matIndex[i] === 1) toastCells.add(i)
    }
    const columnsWithCheese = (): number => {
      const cols = new Set<number>()
      for (let i = 0; i < width * height; i++) {
        if (g.mass[i]! > MASS_EPS && g.matIndex[i] === 0) cols.add(i % width)
      }
      return cols.size
    }
    const before = columnsWithCheese()
    for (let s = 0; s < 400; s++) flowStep(g, 0.3, s)
    // every toast cell still exactly full, exactly toast, exactly in place
    for (const i of toastCells) {
      expect(g.mass[i]).toBe(1)
      expect(g.matIndex[i]).toBe(1)
    }
    // no toast appeared anywhere else, no cheese below the toast surface
    for (let i = 0; i < width * height; i++) {
      if (g.mass[i]! > MASS_EPS) {
        if (g.matIndex[i] === 1) expect(toastCells.has(i)).toBe(true)
        if (i >= 6 * width) expect(g.matIndex[i]).toBe(1)
      }
    }
    // and the cheese really did spread out over the slab
    expect(columnsWithCheese()).toBeGreaterThan(before)
    // solid phi=0 toast never gained mobility
    for (const i of toastCells) {
      expect(liquidFraction(toast, g.energy[i]!)).toBe(0)
    }
  })
})
