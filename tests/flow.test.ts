import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { enthalpyFromTemperature } from '../src/core/enthalpy.ts'
import { createGrid, fillRect, idx, totalEnergy, totalMass } from '../src/core/grid.ts'
import { flowStep } from '../src/core/flow.ts'

const wax = MATERIALS['wax']!
const cheese = MATERIALS['cheese']!

const HOT_WAX = wax.Tliquidus + 30
const COLD_WAX = wax.Tsolidus - 20

function runFlow(g: ReturnType<typeof createGrid>, steps: number): void {
  for (let s = 0; s < steps; s++) flowStep(g, 0.3, s)
}

describe('flowStep', () => {
  it('conserves mass and energy exactly', () => {
    const g = createGrid(9, 7)
    fillRect(g, wax, 3, 0, 3, 2, HOT_WAX)
    const m0 = totalMass(g)
    const e0 = totalEnergy(g)
    runFlow(g, 200)
    expect(totalMass(g)).toBeCloseTo(m0, 10)
    expect(totalEnergy(g)).toBeCloseTo(e0, 6)
  })

  it('leaves supported solid material perfectly still', () => {
    const g = createGrid(6, 6)
    // solid block resting on the floor
    fillRect(g, wax, 2, 4, 2, 2, COLD_WAX)
    const massBefore = Array.from(g.mass)
    const energyBefore = Array.from(g.energy)
    runFlow(g, 100)
    expect(Array.from(g.mass)).toEqual(massBefore)
    expect(Array.from(g.energy)).toEqual(energyBefore)
  })

  it('drops unsupported material under gravity even when solid', () => {
    const g = createGrid(3, 5, [wax])
    g.mass[idx(g, 1, 0)] = 1
    g.energy[idx(g, 1, 0)] = enthalpyFromTemperature(wax, COLD_WAX)
    runFlow(g, 10)
    expect(g.mass[idx(g, 1, 0)]!).toBeLessThan(1e-9)
    expect(g.mass[idx(g, 1, 4)]!).toBeCloseTo(1, 9)
    // energy travelled with the mass
    const h = g.energy[idx(g, 1, 4)]! / g.mass[idx(g, 1, 4)]!
    expect(h).toBeCloseTo(enthalpyFromTemperature(wax, COLD_WAX), 6)
  })

  it('does not spread jammed mush (liquid fraction below threshold) sideways', () => {
    const g = createGrid(3, 1, [wax])
    g.mass[idx(g, 1, 0)] = 1
    g.energy[idx(g, 1, 0)] = 0.2 * wax.latentHeat // phi = 0.2 < 0.3
    runFlow(g, 50)
    expect(g.mass[idx(g, 0, 0)]).toBe(0)
    expect(g.mass[idx(g, 2, 0)]).toBe(0)
    expect(g.mass[idx(g, 1, 0)]).toBe(1)
  })

  it('lets a molten column fall to the floor', () => {
    const g = createGrid(3, 8, [wax])
    g.mass[idx(g, 1, 0)] = 1
    g.energy[idx(g, 1, 0)] = enthalpyFromTemperature(wax, HOT_WAX)
    runFlow(g, 400)
    const bottom = g.mass[idx(g, 1, 7)]! + g.mass[idx(g, 0, 7)]! + g.mass[idx(g, 2, 7)]!
    expect(bottom).toBeGreaterThan(0.5)
    expect(g.mass[idx(g, 1, 0)]!).toBeLessThan(0.05)
  })

  it('cannot fall into a full cell', () => {
    const g = createGrid(1, 2, [wax])
    g.mass[0] = 1
    g.energy[0] = enthalpyFromTemperature(wax, HOT_WAX)
    g.mass[1] = 1
    g.energy[1] = enthalpyFromTemperature(wax, COLD_WAX)
    const before = Array.from(g.mass)
    runFlow(g, 50)
    expect(Array.from(g.mass)).toEqual(before)
  })

  it('spreads a puddle sideways on the floor, both ways', () => {
    const g = createGrid(5, 2)
    fillRect(g, wax, 0, 1, 5, 1, COLD_WAX)
    g.mass[idx(g, 2, 0)] = 1
    g.energy[idx(g, 2, 0)] = enthalpyFromTemperature(wax, HOT_WAX)
    runFlow(g, 60)
    const left = g.mass[idx(g, 1, 0)]!
    const right = g.mass[idx(g, 3, 0)]!
    expect(left).toBeGreaterThan(0.05)
    expect(right).toBeGreaterThan(0.05)
    expect(Math.abs(left - right)).toBeLessThan(0.15)
    expect(g.mass[idx(g, 2, 0)]!).toBeLessThan(1)
  })

  it('runnier material spreads faster than stiffer material at equal superheat', () => {
    const mkPuddle = (mat: typeof wax, T: number) => {
      const g = createGrid(5, 1, [mat])
      g.mass[idx(g, 2, 0)] = 1
      g.energy[idx(g, 2, 0)] = enthalpyFromTemperature(mat, T)
      return g
    }
    const gWax = mkPuddle(wax, wax.Tliquidus + 10)
    const gCheese = mkPuddle(cheese, cheese.Tliquidus + 10)
    for (let s = 0; s < 10; s++) {
      flowStep(gWax, 0.3, s)
      flowStep(gCheese, 0.3, s)
    }
    // mass remaining at the origin: stiff cheese keeps more
    expect(gCheese.mass[idx(gCheese, 2, 0)]!).toBeGreaterThan(gWax.mass[idx(gWax, 2, 0)]!)
  })
})
