import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { enthalpyFromTemperature, temperatureFromEnthalpy } from '../src/core/enthalpy.ts'
import { createGrid, fillRect, idx, specificEnthalpy, totalJoules } from '../src/core/grid.ts'
import { diffuse, stableDt } from '../src/core/heat.ts'
import { Sim, type SimConfig } from '../src/core/sim.ts'

/**
 * Energy budget checked against the boundary fluxes computed INDEPENDENTLY of
 * the simulator's own ledger (which sums whatever each step added, so it
 * closes by construction). Here the expected energy change is derived from the
 * physical inputs alone: flux x face length x time for the heater, Newton's
 * law of cooling for the ambient exchange, and a textbook calorimetry balance
 * for latent heat. These catch unit slips (W vs kW, per-area vs per-cell) and
 * any latent heat lost or double counted as a cell crosses the melting band.
 */

const DX = 0.01

function config(overrides: Partial<SimConfig>): SimConfig {
  return {
    width: 24,
    height: 16,
    material: MATERIALS['wax']!,
    dx: DX,
    Tambient: 20,
    initialT: 20,
    hAmbient: 0,
    heater: { x0: 0, x1: 0, side: 'bottom', power: 0, on: false },
    flowRate: 0.25,
    preset: 'slab',
    ...overrides,
  }
}

describe('energy budget vs independently integrated boundary fluxes', () => {
  it('heater: stored energy rises by flux x heated length x time, through melting', () => {
    // Full-width bottom heater under a wax slab, no ambient loss. The slab
    // bottom row melts (latent plateau crossed mid-run) but stays far below
    // the T_MAX clamp, so every watt must land in the grid.
    const power = 5000 // W/m^2
    const sim = new Sim(
      config({ heater: { x0: 0, x1: 24, side: 'bottom', power, on: true } }),
    )
    const e0 = totalJoules(sim.grid, DX)
    const t = 1200
    for (let s = 0; s < t / 15; s++) sim.step(15)
    const expected = power * (24 * DX) * t // J per metre of depth
    const gained = totalJoules(sim.grid, DX) - e0
    expect(gained / expected).toBeCloseTo(1, 12)
    expect(sim.heaterJoules / expected).toBeCloseTo(1, 12)
    expect(sim.stats().meltedFraction).toBeGreaterThan(0) // crossed the plateau
    expect(sim.stats().maxT).toBeLessThan(200)
  })

  it('ambient: a high-conductivity block cools by Newton\'s law (lumped body)', () => {
    // Gallium block (k = 33 W/mK, cell Biot number ~ 4e-3) warming from 0 degC
    // toward a 20 degC room: lumped capacitance holds, so
    //   T(t) = Ta + (T0 - Ta) exp(-h P t / (rho c A))
    // with P the exposed perimeter (every face of the block, the floor
    // included, exchanges with ambient) and A its cross-section. It stays
    // below gallium's 29.5 degC solidus, so c is the solid value throughout.
    const ga = MATERIALS['gallium']!
    const hAmb = 12
    const sim = new Sim(
      config({ material: ga, preset: 'block', Tambient: 20, initialT: 0, hAmbient: hAmb }),
    )
    let cells = 0
    let perimeterFaces = 0
    const { width, height } = sim.cfg
    const full = (x: number, y: number): boolean =>
      x >= 0 && x < width && y >= 0 && y < height && sim.grid.mass[idx(sim.grid, x, y)]! > 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!full(x, y)) continue
        cells++
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (!full(x + ox, y + oy)) perimeterFaces++
        }
      }
    }
    expect(cells).toBe(72) // 12 x 6 block
    const A = cells * DX * DX
    const P = perimeterFaces * DX
    const e0 = totalJoules(sim.grid, DX)
    const t = 3600
    for (let s = 0; s < t / 10; s++) sim.step(10)
    const rate = (hAmb * P) / (ga.rho * ga.cSolid * A)
    const Tlumped = 20 + (0 - 20) * Math.exp(-rate * t)
    const gainedLumped = ga.rho * ga.cSolid * A * (Tlumped - 0)
    const gained = totalJoules(sim.grid, DX) - e0
    expect(Math.abs(gained - gainedLumped) / gainedLumped).toBeLessThan(0.01)
    expect(Math.abs(sim.ambientJoules - gainedLumped) / gainedLumped).toBeLessThan(0.01)
    // the block is (nearly) isothermal, as the lumped model assumes
    const st = sim.stats()
    expect(st.maxT - st.minT).toBeLessThan(0.2)
    expect(Math.abs(st.maxT - Tlumped)).toBeLessThan(0.2)
  })

  it('latent heat: hot water on ice settles at the calorimetry temperature', () => {
    // One cell of water at 95 degC against one of ice at -10 degC, insulated.
    // The ice must absorb its full latent heat as it crosses the melting band
    // (partly within single conduction steps); neither losing nor double
    // counting it lands both cells at the textbook balance
    //   c_s (0 - -10) + L + c_l (Tf - 0) = c_l (95 - Tf)
    //   => Tf = (95 c_l - 10 c_s - L) / (2 c_l) = 5.10 degC,
    // up to the model's +-0.5 degC mushy band around 0 degC.
    const ice = MATERIALS['ice']!
    const g = createGrid(2, 1, [ice])
    fillRect(g, ice, 0, 0, 1, 1, 95)
    fillRect(g, ice, 1, 0, 1, 1, -10)
    const e0 = totalJoules(g, DX)
    const dt = stableDt(ice, DX)
    for (let s = 0; s < 4000; s++) diffuse(g, DX, dt)
    const Ta = temperatureFromEnthalpy(ice, specificEnthalpy(g, 0))
    const Tb = temperatureFromEnthalpy(ice, specificEnthalpy(g, 1))
    expect(Math.abs(Ta - Tb)).toBeLessThan(1e-6)
    expect(totalJoules(g, DX)).toBeCloseTo(e0, 6)
    const Tf = (95 * ice.cLiquid - 10 * ice.cSolid - ice.latentHeat) / (2 * ice.cLiquid)
    expect(Tf).toBeCloseTo(5.1, 2)
    const band = ice.Tliquidus - ice.Tsolidus
    expect(Math.abs(Ta - Tf)).toBeLessThan(band)
    // and exactly the model's own equilibrium: the mean of the two enthalpies
    const hMean =
      (enthalpyFromTemperature(ice, 95) + enthalpyFromTemperature(ice, -10)) / 2
    expect(Ta).toBeCloseTo(temperatureFromEnthalpy(ice, hMean), 6)
  })
})
