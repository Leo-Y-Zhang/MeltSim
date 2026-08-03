import { describe, expect, it } from 'vitest'
import { MATERIALS, type Material } from '../src/core/materials.ts'
import { enthalpyFromTemperature, temperatureFromEnthalpy } from '../src/core/enthalpy.ts'
import {
  MASS_EPS,
  createGrid,
  fillRect,
  idx,
  totalEnergy,
  totalMass,
  type Grid,
} from '../src/core/grid.ts'
import { diffuse, stableDt } from '../src/core/heat.ts'

const ice = MATERIALS['ice']!
const wax = MATERIALS['wax']!

describe('stableDt', () => {
  it('matches the explicit FTCS bound dx^2 rho c / (4 k) with a safety factor', () => {
    const dx = 0.01
    const bound = (dx * dx * ice.rho * Math.min(ice.cSolid, ice.cLiquid)) / (4 * ice.k)
    const dt = stableDt(ice, dx)
    expect(dt).toBeGreaterThan(0)
    expect(dt).toBeLessThan(bound)
    expect(dt).toBeGreaterThan(0.5 * bound)
  })
})

describe('diffuse', () => {
  it('conserves total energy on an insulated grid', () => {
    const g = createGrid(16, 12)
    fillRect(g, wax, 2, 3, 10, 6, 20)
    // deterministic non-uniform hot spot
    for (let x = 4; x < 8; x++) {
      g.energy[idx(g, x, 5)] = enthalpyFromTemperature(wax, 150 + 7 * x)
    }
    const before = totalEnergy(g)
    const dt = stableDt(wax, 0.01)
    for (let i = 0; i < 200; i++) diffuse(g, 0.01, dt)
    expect(totalEnergy(g)).toBeCloseTo(before, 6)
  })

  it('does not change mass', () => {
    const g = createGrid(8, 8)
    fillRect(g, wax, 1, 1, 6, 6, 30)
    g.energy[idx(g, 3, 3)] = enthalpyFromTemperature(wax, 200)
    const before = totalMass(g)
    for (let i = 0; i < 50; i++) diffuse(g, 0.01, stableDt(wax, 0.01))
    expect(totalMass(g)).toBe(before)
  })

  it('moves heat from hot to cold until they converge', () => {
    const g = createGrid(4, 1)
    fillRect(g, ice, 0, 0, 4, 1, -20)
    g.energy[idx(g, 0, 0)] = enthalpyFromTemperature(ice, -1)
    const hot0 = temperatureFromEnthalpy(ice, g.energy[idx(g, 0, 0)]!)
    const cold0 = temperatureFromEnthalpy(ice, g.energy[idx(g, 3, 0)]!)
    const dt = stableDt(ice, 0.01)
    for (let i = 0; i < 3000; i++) diffuse(g, 0.01, dt)
    const hot1 = temperatureFromEnthalpy(ice, g.energy[idx(g, 0, 0)]!)
    const cold1 = temperatureFromEnthalpy(ice, g.energy[idx(g, 3, 0)]!)
    expect(hot1).toBeLessThan(hot0)
    expect(cold1).toBeGreaterThan(cold0)
    expect(Math.abs(hot1 - cold1)).toBeLessThan(0.5)
  })

  it('never conducts into empty cells', () => {
    const g = createGrid(3, 1)
    fillRect(g, wax, 0, 0, 1, 1, 300)
    // cells (1,0) and (2,0) stay empty
    for (let i = 0; i < 100; i++) diffuse(g, 0.01, stableDt(wax, 0.01))
    expect(g.energy[idx(g, 1, 0)]).toBe(0)
    expect(g.mass[idx(g, 1, 0)]).toBe(0)
  })

  it('leaves a uniform-temperature grid exactly unchanged', () => {
    const g = createGrid(6, 6)
    fillRect(g, wax, 0, 0, 6, 6, 55)
    const snapshot = Array.from(g.energy)
    for (let i = 0; i < 20; i++) diffuse(g, 0.01, stableDt(wax, 0.01))
    expect(Array.from(g.energy)).toEqual(snapshot)
  })

  it('remains finite and stable at the recommended timestep', () => {
    const g = createGrid(10, 10)
    fillRect(g, ice, 0, 0, 10, 10, -30)
    g.energy[idx(g, 5, 5)] = enthalpyFromTemperature(ice, 90)
    const dt = stableDt(ice, 0.01)
    for (let i = 0; i < 500; i++) diffuse(g, 0.01, dt)
    for (let i = 0; i < g.energy.length; i++) {
      expect(Number.isFinite(g.energy[i]!)).toBe(true)
      const T = temperatureFromEnthalpy(ice, g.energy[i]!)
      expect(T).toBeGreaterThanOrEqual(-31)
      expect(T).toBeLessThanOrEqual(91)
    }
  })

  it('is BITWISE identical to the 0.1.x single-material arithmetic', () => {
    // Verbatim re-implementation of the 0.1.x diffuse (commit 8c536a8):
    // same expressions, same multiplication order, same loop order.
    function oldDiffuse(g: Grid, mat: Material, dx: number, dt: number): void {
      const n = g.width * g.height
      const T = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        T[i] = g.mass[i]! > MASS_EPS
          ? temperatureFromEnthalpy(mat, g.energy[i]! / g.mass[i]!)
          : 0
      }
      const coeff = (mat.k * dt) / (mat.rho * dx * dx)
      for (let y = 0; y < g.height; y++) {
        for (let x = 0; x < g.width; x++) {
          const i = y * g.width + x
          const mi = g.mass[i]!
          if (mi <= MASS_EPS) continue
          if (x + 1 < g.width) {
            const mj = g.mass[i + 1]!
            if (mj > MASS_EPS) {
              const q = coeff * (T[i + 1]! - T[i]!) * Math.min(mi, mj)
              g.energy[i]! += q
              g.energy[i + 1]! -= q
            }
          }
          if (y + 1 < g.height) {
            const mj = g.mass[i + g.width]!
            if (mj > MASS_EPS) {
              const q = coeff * (T[i + g.width]! - T[i]!) * Math.min(mi, mj)
              g.energy[i]! += q
              g.energy[i + g.width]! -= q
            }
          }
        }
      }
    }
    const mk = (): Grid => {
      const g = createGrid(16, 12, [wax])
      fillRect(g, wax, 2, 3, 10, 6, 20)
      for (let x = 4; x < 8; x++) {
        g.energy[idx(g, x, 5)] = enthalpyFromTemperature(wax, 150 + 7 * x)
      }
      g.mass[idx(g, 9, 5)] = 0.37
      g.energy[idx(g, 9, 5)]! *= 0.37
      return g
    }
    const a = mk()
    const b = mk()
    const dt = stableDt(wax, 0.01)
    for (let s = 0; s < 400; s++) {
      oldDiffuse(a, wax, 0.01, dt)
      diffuse(b, 0.01, dt)
    }
    for (let i = 0; i < a.energy.length; i++) {
      expect(Object.is(a.energy[i], b.energy[i])).toBe(true)
    }
  })
})
