import { describe, expect, it } from 'vitest'
import { MATERIALS, listMaterials } from '../src/core/materials.ts'
import { enthalpyFromTemperature } from '../src/core/enthalpy.ts'
import { mobility, viscosity } from '../src/core/viscosity.ts'

const ALL = listMaterials()

describe('viscosity(T)', () => {
  it('equals mu0 at the liquidus and decreases with temperature', () => {
    for (const m of ALL) {
      expect(viscosity(m, m.Tliquidus)).toBeCloseTo(m.mu0, 9)
      expect(viscosity(m, m.Tliquidus + 20)).toBeLessThan(m.mu0)
      expect(viscosity(m, m.Tliquidus + 40)).toBeLessThan(viscosity(m, m.Tliquidus + 20))
    }
  })

  it('never drops below muMin', () => {
    for (const m of ALL) {
      expect(viscosity(m, m.Tliquidus + 10_000)).toBeGreaterThanOrEqual(m.muMin)
    }
  })
})

describe('mobility(h)', () => {
  const cheese = MATERIALS['cheese']!

  it('is 0 for solid material', () => {
    const hSolid = enthalpyFromTemperature(cheese, cheese.Tsolidus - 5)
    expect(mobility(cheese, hSolid)).toBe(0)
  })

  it('is 0 below the percolation threshold of liquid fraction', () => {
    // phi = 0.2 is below the default threshold of 0.3
    expect(mobility(cheese, 0.2 * cheese.latentHeat)).toBe(0)
  })

  it('is positive once molten enough and increases with enthalpy', () => {
    const low = mobility(cheese, 0.5 * cheese.latentHeat)
    const high = mobility(cheese, enthalpyFromTemperature(cheese, cheese.Tliquidus + 30))
    expect(low).toBeGreaterThan(0)
    expect(high).toBeGreaterThan(low)
  })

  it('stays within [0, 1] for all materials over a wide enthalpy range', () => {
    for (const m of ALL) {
      for (let T = m.Tsolidus - 50; T < m.Tliquidus + 200; T += 3.1) {
        const mob = mobility(m, enthalpyFromTemperature(m, T))
        expect(mob).toBeGreaterThanOrEqual(0)
        expect(mob).toBeLessThanOrEqual(1)
      }
    }
  })

  it('runnier materials are more mobile at equal superheat', () => {
    const wax = MATERIALS['wax']!
    const mobWax = mobility(wax, enthalpyFromTemperature(wax, wax.Tliquidus + 10))
    const mobCheese = mobility(cheese, enthalpyFromTemperature(cheese, cheese.Tliquidus + 10))
    expect(mobWax).toBeGreaterThan(mobCheese)
  })
})
