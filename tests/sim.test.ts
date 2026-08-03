import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { Sim, type SimConfig } from '../src/core/sim.ts'
import { liquidFraction } from '../src/core/enthalpy.ts'
import {
  MASS_EPS,
  cellMaterial,
  materialMass,
  specificEnthalpy,
  totalJoules,
  totalMass,
} from '../src/core/grid.ts'

const wax = MATERIALS['wax']!
const ice = MATERIALS['ice']!

function waxSim(overrides: Partial<SimConfig> = {}): Sim {
  return new Sim({
    width: 24,
    height: 16,
    material: wax,
    dx: 0.01,
    Tambient: 20,
    initialT: 20,
    hAmbient: 12,
    heater: { x0: 8, x1: 16, side: 'top', power: 25_000, on: false },
    flowRate: 0.25,
    preset: 'block',
    ...overrides,
  })
}

describe('Sim', () => {
  it('builds the block preset with material present and sane stats', () => {
    const sim = waxSim()
    const s = sim.stats()
    expect(s.totalMass).toBeGreaterThan(10)
    expect(s.meltedFraction).toBe(0)
    expect(s.minT).toBeCloseTo(20, 6)
    expect(s.maxT).toBeCloseTo(20, 6)
    expect(s.simTime).toBe(0)
  })

  it('is deterministic: identical configs stepped identically agree exactly', () => {
    const a = waxSim({ heater: { x0: 8, x1: 16, side: 'top', power: 25_000, on: true } })
    const b = waxSim({ heater: { x0: 8, x1: 16, side: 'top', power: 25_000, on: true } })
    for (let i = 0; i < 25; i++) {
      a.step(5)
      b.step(5)
    }
    expect(Array.from(a.grid.energy)).toEqual(Array.from(b.grid.energy))
    expect(Array.from(a.grid.mass)).toEqual(Array.from(b.grid.mass))
  })

  it('conserves mass through heating, melting and flowing', () => {
    const sim = waxSim({ heater: { x0: 8, x1: 16, side: 'top', power: 40_000, on: true } })
    const m0 = totalMass(sim.grid)
    for (let i = 0; i < 60; i++) sim.step(10)
    expect(totalMass(sim.grid)).toBeCloseTo(m0, 8)
  })

  it('melts wax under a strong heater and the melt slumps', () => {
    const sim = waxSim({ heater: { x0: 8, x1: 16, side: 'top', power: 40_000, on: true } })
    for (let i = 0; i < 120; i++) sim.step(10)
    const s = sim.stats()
    expect(s.meltedFraction).toBeGreaterThan(0.2)
    expect(s.maxT).toBeGreaterThan(wax.Tliquidus)
    expect(s.simTime).toBeCloseTo(1200, 6)
  })

  it('stays cold with the heater off and ambient at 20 C', () => {
    const sim = waxSim()
    for (let i = 0; i < 50; i++) sim.step(10)
    const s = sim.stats()
    expect(s.meltedFraction).toBe(0)
    expect(s.maxT).toBeLessThan(wax.Tsolidus)
  })

  it('cools hot material toward ambient when the heater is off', () => {
    const sim = waxSim({ initialT: 90, Tambient: 15 })
    const hot = sim.stats()
    expect(hot.meltedFraction).toBe(1)
    for (let i = 0; i < 200; i++) sim.step(30)
    const cooled = sim.stats()
    expect(cooled.maxT).toBeLessThan(hot.maxT)
    expect(cooled.meltedFraction).toBeLessThan(1)
  })

  it('slowly melts ice sitting in a warm room with no heater', () => {
    const sim = waxSim({
      material: ice,
      initialT: -10,
      Tambient: 25,
      width: 16,
      height: 12,
    })
    for (let i = 0; i < 300; i++) sim.step(30)
    const s = sim.stats()
    expect(s.minT).toBeGreaterThan(-10)
    expect(s.meltedFraction).toBeGreaterThan(0)
  })

  it('never produces NaN or runaway temperatures', () => {
    const sim = waxSim({ heater: { x0: 0, x1: 24, side: 'top', power: 60_000, on: true } })
    for (let i = 0; i < 150; i++) sim.step(20)
    const s = sim.stats()
    expect(Number.isFinite(s.minT)).toBe(true)
    expect(Number.isFinite(s.maxT)).toBe(true)
    expect(s.maxT).toBeLessThanOrEqual(400)
    for (const e of sim.grid.energy) expect(Number.isFinite(e)).toBe(true)
  })

  it('supports the slab preset resting on the floor', () => {
    const sim = waxSim({ preset: 'slab' })
    // bottom row should contain material, top row should not
    let bottomMass = 0
    let topMass = 0
    for (let x = 0; x < 24; x++) {
      bottomMass += sim.grid.mass[(16 - 1) * 24 + x]!
      topMass += sim.grid.mass[x]!
    }
    expect(bottomMass).toBeGreaterThan(10)
    expect(topMass).toBe(0)
  })
})

describe('Sim toast preset (two-material scene)', () => {
  const cheese = MATERIALS['cheese']!
  const toast = MATERIALS['toast']!

  function toastSim(overrides: Partial<SimConfig> = {}): Sim {
    return new Sim({
      width: 24,
      height: 20,
      material: cheese,
      dx: 0.01,
      Tambient: 22,
      initialT: 22,
      hAmbient: 8,
      heater: { x0: 6, x1: 18, side: 'top', power: 30_000, on: true },
      flowRate: 0.25,
      preset: 'toast',
      ...overrides,
    })
  }

  it('defaults the substrate to the toast material', () => {
    const sim = toastSim()
    expect(sim.substrate).toBe(toast)
    expect(sim.grid.materials).toContain(toast)
    expect(sim.grid.materials).toContain(cheese)
  })

  it('honours an explicit substrate override', () => {
    const sim = toastSim({ substrate: wax })
    expect(sim.substrate).toBe(wax)
    expect(sim.grid.materials).toContain(wax)
  })

  it('builds a full-width substrate slab (~20% height) with a block resting on it', () => {
    const sim = toastSim()
    const { width, height } = sim.cfg
    const slabRows = Math.max(2, Math.round(height * 0.2))
    // slab: full width, all toast, all full
    for (let y = height - slabRows; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        expect(sim.grid.mass[i]).toBe(1)
        expect(cellMaterial(sim.grid, i)).toBe(toast)
      }
    }
    // block: cheese in the centre column immediately above the slab
    const iBlock = (height - slabRows - 1) * width + Math.floor(width / 2)
    expect(sim.grid.mass[iBlock]).toBe(1)
    expect(cellMaterial(sim.grid, iBlock)).toBe(cheese)
    // nothing above the block region leaks in from the sides
    expect(sim.grid.mass[0]).toBe(0)
  })

  it('conserves joules and per-material mass with heater off and no ambient exchange', () => {
    const sim = toastSim({
      hAmbient: 0,
      heater: { x0: 0, x1: 0, side: 'top', power: 0, on: false },
      initialT: cheese.Tliquidus + 30, // molten cheese so the flow pass works too
    })
    const j0 = totalJoules(sim.grid, sim.cfg.dx)
    const mCheese0 = materialMass(sim.grid, cheese)
    const mToast0 = materialMass(sim.grid, toast)
    for (let i = 0; i < 40; i++) sim.step(10)
    expect(Math.abs(totalJoules(sim.grid, sim.cfg.dx) - j0) / Math.abs(j0)).toBeLessThan(1e-9)
    expect(materialMass(sim.grid, cheese)).toBeCloseTo(mCheese0, 8)
    expect(materialMass(sim.grid, toast)).toBeCloseTo(mToast0, 8)
  })

  it('melts and slumps the cheese over the toast while the toast never melts or moves', () => {
    const sim = toastSim()
    const { width, height } = sim.cfg
    const slabRows = Math.max(2, Math.round(height * 0.2))
    const slabTop = height - slabRows
    const toastIdx = sim.grid.materials.indexOf(toast)
    const cheeseColumns = (): number => {
      const cols = new Set<number>()
      for (let i = 0; i < width * height; i++) {
        if (sim.grid.mass[i]! > MASS_EPS && sim.grid.matIndex[i] !== toastIdx) {
          cols.add(i % width)
        }
      }
      return cols.size
    }
    const colsBefore = cheeseColumns()
    for (let i = 0; i < 240; i++) sim.step(30) // 2 simulated hours
    const s = sim.stats()
    expect(s.meltedFraction).toBeGreaterThan(0.05)
    expect(s.maxT).toBeGreaterThan(cheese.Tliquidus)
    // toast: still exactly the original slab, all solid
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const isToast = sim.grid.mass[i]! > MASS_EPS && sim.grid.matIndex[i] === toastIdx
        expect(isToast).toBe(y >= slabTop)
        if (isToast) {
          expect(sim.grid.mass[i]).toBe(1)
          expect(liquidFraction(toast, specificEnthalpy(sim.grid, i))).toBe(0)
        }
      }
    }
    // the molten cheese spread across more columns of the toast surface
    expect(cheeseColumns()).toBeGreaterThan(colsBefore)
  })

  it('keeps total mass constant through the full heated scenario', () => {
    const sim = toastSim()
    const m0 = totalMass(sim.grid)
    for (let i = 0; i < 100; i++) sim.step(20)
    expect(totalMass(sim.grid)).toBeCloseTo(m0, 8)
  })
})
