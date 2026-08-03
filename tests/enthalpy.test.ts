import { describe, expect, it } from 'vitest'
import { MATERIALS, listMaterials } from '../src/core/materials.ts'
import {
  enthalpyFromTemperature,
  liquidFraction,
  temperatureFromEnthalpy,
} from '../src/core/enthalpy.ts'

const ALL = listMaterials()

describe('materials', () => {
  it('provides at least ice, chocolate, cheese and wax', () => {
    expect(Object.keys(MATERIALS)).toEqual(
      expect.arrayContaining(['ice', 'chocolate', 'cheese', 'wax']),
    )
  })

  it('has physically sane properties', () => {
    for (const m of ALL) {
      expect(m.Tliquidus).toBeGreaterThan(m.Tsolidus)
      expect(m.latentHeat).toBeGreaterThan(0)
      expect(m.cSolid).toBeGreaterThan(0)
      expect(m.cLiquid).toBeGreaterThan(0)
      expect(m.k).toBeGreaterThan(0)
      expect(m.rho).toBeGreaterThan(0)
    }
  })
})

describe('enthalpy <-> temperature mapping', () => {
  it('is zero at the solidus temperature', () => {
    for (const m of ALL) {
      expect(enthalpyFromTemperature(m, m.Tsolidus)).toBeCloseTo(0, 9)
    }
  })

  it('round-trips temperatures in the solid range', () => {
    for (const m of ALL) {
      const T = m.Tsolidus - 25
      const h = enthalpyFromTemperature(m, T)
      expect(h).toBeLessThan(0)
      expect(temperatureFromEnthalpy(m, h)).toBeCloseTo(T, 6)
    }
  })

  it('round-trips temperatures in the liquid range', () => {
    for (const m of ALL) {
      const T = m.Tliquidus + 40
      const h = enthalpyFromTemperature(m, T)
      expect(h).toBeGreaterThan(m.latentHeat)
      expect(temperatureFromEnthalpy(m, h)).toBeCloseTo(T, 6)
    }
  })

  it('absorbs exactly the latent heat across the mushy zone', () => {
    for (const m of ALL) {
      const hAtLiquidus = enthalpyFromTemperature(m, m.Tliquidus)
      const hAtSolidus = enthalpyFromTemperature(m, m.Tsolidus)
      expect(hAtLiquidus - hAtSolidus).toBeCloseTo(m.latentHeat, 6)
    }
  })

  it('is strictly increasing in temperature', () => {
    for (const m of ALL) {
      let prev = -Infinity
      for (let T = m.Tsolidus - 60; T <= m.Tliquidus + 60; T += 1.7) {
        const h = enthalpyFromTemperature(m, T)
        expect(h).toBeGreaterThan(prev)
        prev = h
      }
    }
  })
})

describe('liquidFraction', () => {
  it('is 0 for solid, 1 for liquid, 0.5 mid-plateau', () => {
    for (const m of ALL) {
      expect(liquidFraction(m, enthalpyFromTemperature(m, m.Tsolidus - 10))).toBe(0)
      expect(liquidFraction(m, enthalpyFromTemperature(m, m.Tliquidus + 10))).toBe(1)
      expect(liquidFraction(m, 0.5 * m.latentHeat)).toBeCloseTo(0.5, 9)
    }
  })

  it('maps mid-plateau enthalpy to a temperature inside the mushy zone', () => {
    for (const m of ALL) {
      const T = temperatureFromEnthalpy(m, 0.5 * m.latentHeat)
      expect(T).toBeGreaterThan(m.Tsolidus)
      expect(T).toBeLessThan(m.Tliquidus)
    }
  })

  it('never leaves [0, 1]', () => {
    for (const m of ALL) {
      for (const T of [-200, m.Tsolidus, (m.Tsolidus + m.Tliquidus) / 2, m.Tliquidus, 500]) {
        const phi = liquidFraction(m, enthalpyFromTemperature(m, T))
        expect(phi).toBeGreaterThanOrEqual(0)
        expect(phi).toBeLessThanOrEqual(1)
      }
    }
  })
})
