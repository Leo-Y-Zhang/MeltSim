import { describe, expect, it } from 'vitest'
import {
  MATERIALS,
  listMaterials,
  selectableMaterials,
  withOverrides,
} from '../src/core/materials.ts'
import { enthalpyFromTemperature, boilEnthalpy } from '../src/core/enthalpy.ts'

const T_MAX = 350 // heater cap (see sim.ts)

describe('extended material set', () => {
  it('adds gallium, butter and solder', () => {
    expect(Object.keys(MATERIALS)).toEqual(
      expect.arrayContaining(['gallium', 'butter', 'solder']),
    )
  })

  it('keeps every new castable material meltable below the heater cap', () => {
    for (const id of ['gallium', 'butter', 'solder']) {
      const m = MATERIALS[id]!
      expect(m.Tliquidus).toBeLessThan(T_MAX)
      expect(m.substrate).toBeUndefined()
    }
  })

  it('gallium melts near body temperature', () => {
    const g = MATERIALS['gallium']!
    expect(g.Tliquidus).toBeGreaterThan(25)
    expect(g.Tliquidus).toBeLessThan(40)
  })

  it('every material remains physically sane (incl. optional boiling fields)', () => {
    for (const m of listMaterials()) {
      expect(m.Tliquidus).toBeGreaterThan(m.Tsolidus)
      expect(m.latentHeat).toBeGreaterThan(0)
      expect(m.k).toBeGreaterThan(0)
      expect(m.rho).toBeGreaterThan(0)
      if (m.Tboil !== undefined) {
        expect(m.latentVapor).toBeGreaterThan(0)
        expect(m.Tboil).toBeGreaterThan(m.Tliquidus)
        expect(boilEnthalpy(m)).toBeGreaterThan(m.latentHeat)
      }
    }
  })
})

describe('selectableMaterials', () => {
  it('excludes substrate materials (toast, steel)', () => {
    const ids = selectableMaterials().map((m) => m.id)
    expect(ids).toContain('ice')
    expect(ids).not.toContain('toast')
    expect(ids).not.toContain('steel')
  })
})

describe('withOverrides (material editor backing)', () => {
  it('overrides only the given fields and leaves the base untouched', () => {
    const base = MATERIALS['chocolate']!
    const tuned = withOverrides(base, { k: 1.5, latentHeat: 50_000 })
    expect(tuned.k).toBe(1.5)
    expect(tuned.latentHeat).toBe(50_000)
    expect(tuned.Tsolidus).toBe(base.Tsolidus) // untouched
    expect(base.k).not.toBe(1.5) // base is immutable
  })

  it('changes the enthalpy curve when latent heat is tuned', () => {
    const base = MATERIALS['wax']!
    const tuned = withOverrides(base, { latentHeat: base.latentHeat * 2 })
    const hBase = enthalpyFromTemperature(base, base.Tliquidus)
    const hTuned = enthalpyFromTemperature(tuned, tuned.Tliquidus)
    expect(hTuned).toBeCloseTo(hBase + base.latentHeat, 6)
  })
})
