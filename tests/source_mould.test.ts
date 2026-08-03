import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { Sim, type SimConfig } from '../src/core/sim.ts'
import { enthalpyFromTemperature, liquidFraction, temperatureFromEnthalpy } from '../src/core/enthalpy.ts'
import { MASS_EPS, specificEnthalpy, totalJoules, totalMass } from '../src/core/grid.ts'

const wax = MATERIALS['wax']!
const steel = MATERIALS['steel']!

/** Ledger invariant: stored joules == initial + all inflows - vapour. */
function ledgerCloses(sim: Sim, j0: number): number {
  const jNow = totalJoules(sim.grid, sim.cfg.dx)
  const expected =
    j0 +
    sim.heaterJoules +
    sim.ambientJoules +
    sim.pouredJoules +
    sim.wallJoules -
    sim.ventedJoules
  return Math.abs(jNow - expected) / Math.abs(jNow)
}

describe('pour source', () => {
  function pourSim(overrides: Partial<SimConfig> = {}): Sim {
    return new Sim({
      width: 12,
      height: 16,
      material: wax,
      dx: 0.01,
      Tambient: 20,
      initialT: 20,
      hAmbient: 0,
      heater: { x0: 0, x1: 0, side: 'top', power: 0, on: false },
      flowRate: 0.4,
      preset: 'slab',
      source: { x0: 4, x1: 8, material: wax, T: 120, massRate: 0.02, on: true },
      ...overrides,
    })
  }

  it('registers the poured material on the grid', () => {
    expect(pourSim().grid.materials).toContain(wax)
  })

  it('adds mass and the exact poured enthalpy, tracked in pouredJoules', () => {
    const sim = pourSim()
    const m0 = totalMass(sim.grid)
    for (let i = 0; i < 50; i++) sim.step(3)
    const added = totalMass(sim.grid) - m0
    expect(added).toBeGreaterThan(1)
    const hPour = enthalpyFromTemperature(wax, 120)
    const expectedJ = hPour * added * wax.rho * sim.cfg.dx ** 2
    expect(Math.abs(sim.pouredJoules - expectedJ) / expectedJ).toBeLessThan(1e-9)
  })

  it('injects nothing while the source is off', () => {
    const sim = pourSim({ source: { x0: 4, x1: 8, material: wax, T: 120, massRate: 0.02, on: false } })
    const m0 = totalMass(sim.grid)
    for (let i = 0; i < 20; i++) sim.step(3)
    expect(totalMass(sim.grid)).toBeCloseTo(m0, 9)
    expect(sim.pouredJoules).toBe(0)
  })

  it('closes the energy ledger with an active source', () => {
    const sim = pourSim()
    const j0 = totalJoules(sim.grid, sim.cfg.dx)
    for (let i = 0; i < 60; i++) sim.step(3)
    expect(ledgerCloses(sim, j0)).toBeLessThan(1e-9)
  })
})

describe('cold mould (solidification)', () => {
  function mouldSim(overrides: Partial<SimConfig> = {}): Sim {
    return new Sim({
      width: 24,
      height: 20,
      material: wax,
      dx: 0.01,
      Tambient: -20,
      initialT: -20,
      hAmbient: 0,
      heater: { x0: 0, x1: 0, side: 'top', power: 0, on: false },
      flowRate: 0.3,
      preset: 'mould',
      mould: { Twall: -20 },
      source: { x0: 10, x1: 14, material: wax, T: 90, massRate: 0.06, on: true },
      ...overrides,
    })
  }

  const waxPhase = (sim: Sim): { mass: number; molten: number; minT: number } => {
    const waxIdx = sim.grid.materials.indexOf(wax)
    let mass = 0
    let molten = 0
    let minT = Infinity
    for (let i = 0; i < sim.grid.mass.length; i++) {
      if (sim.grid.mass[i]! > MASS_EPS && sim.grid.matIndex[i] === waxIdx) {
        const h = specificEnthalpy(sim.grid, i)
        mass += sim.grid.mass[i]!
        molten += sim.grid.mass[i]! * liquidFraction(wax, h)
        minT = Math.min(minT, temperatureFromEnthalpy(wax, h))
      }
    }
    return { mass, molten, minT }
  }

  it('builds a U-shaped steel mould with an empty cavity', () => {
    const sim = mouldSim({ source: undefined })
    const { width, height } = sim.cfg
    expect(sim.mouldMat).toBe(steel)
    // floor row is all steel and full
    for (let x = 0; x < width; x++) {
      const i = (height - 1) * width + x
      expect(sim.grid.mass[i]).toBe(1)
      expect(sim.grid.materials[sim.grid.matIndex[i]!]).toBe(steel)
    }
    // a central upper cell is empty cavity
    expect(sim.grid.mass[2 * width + Math.floor(width / 2)]).toBe(0)
    // a side-wall cell is steel
    expect(sim.grid.materials[sim.grid.matIndex[(height - 3) * width]!]).toBe(steel)
  })

  it('holds every mould wall cell at the fixed wall temperature', () => {
    const sim = mouldSim()
    const steelIdx = sim.grid.materials.indexOf(steel)
    for (let i = 0; i < 150; i++) sim.step(5)
    for (let k = 0; k < sim.grid.mass.length; k++) {
      if (sim.grid.matIndex[k] === steelIdx && sim.grid.mass[k]! > MASS_EPS) {
        expect(temperatureFromEnthalpy(steel, specificEnthalpy(sim.grid, k))).toBeCloseTo(-20, 6)
      }
    }
  })

  it('never lets the rigid mould walls move (steel mass pattern is invariant)', () => {
    const sim = mouldSim()
    const steelIdx = sim.grid.materials.indexOf(steel)
    const wallCells = (): string => {
      const cells: number[] = []
      for (let i = 0; i < sim.grid.mass.length; i++) {
        if (sim.grid.matIndex[i] === steelIdx && sim.grid.mass[i]! > MASS_EPS) cells.push(i)
      }
      return cells.join(',')
    }
    const before = wallCells()
    for (let i = 0; i < 200; i++) sim.step(5)
    expect(wallCells()).toBe(before)
  })

  it('freezes poured hot wax against the cold walls', () => {
    const sim = mouldSim()
    for (let i = 0; i < 120; i++) sim.step(2) // pour molten wax in
    const afterPour = waxPhase(sim)
    expect(afterPour.mass).toBeGreaterThan(2)
    sim.cfg.source!.on = false // stop pouring, let it set
    for (let i = 0; i < 500; i++) sim.step(5)
    const end = waxPhase(sim)
    // the molten fraction fell and some wax chilled below its solidus
    expect(end.molten / end.mass).toBeLessThan(afterPour.molten / afterPour.mass)
    expect(end.minT).toBeLessThan(wax.Tsolidus)
  })

  it('closes the ledger (poured in, wall exchange out)', () => {
    const sim = mouldSim()
    const j0 = totalJoules(sim.grid, sim.cfg.dx)
    for (let i = 0; i < 200; i++) sim.step(4)
    expect(ledgerCloses(sim, j0)).toBeLessThan(1e-9)
    // the cold walls removed net heat from the poured melt
    expect(sim.wallJoules).toBeLessThan(0)
  })
})
