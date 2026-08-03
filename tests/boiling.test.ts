import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { boilEnthalpy, enthalpyFromTemperature, temperatureFromEnthalpy } from '../src/core/enthalpy.ts'
import { vaporiseCell } from '../src/core/boiling.ts'
import { Sim, type SimConfig } from '../src/core/sim.ts'
import { totalJoules, totalMass } from '../src/core/grid.ts'

const ice = MATERIALS['ice']! // water/ice: boils at 100 C
const wax = MATERIALS['wax']! // no boiling point defined

describe('boilEnthalpy', () => {
  it('is +Infinity for materials with no boiling point', () => {
    expect(boilEnthalpy(wax)).toBe(Infinity)
    expect(boilEnthalpy(MATERIALS['cheese']!)).toBe(Infinity)
  })

  it('is latentHeat + cLiquid*(Tboil - Tliquidus) for water', () => {
    const expected = ice.latentHeat + ice.cLiquid * (ice.Tboil! - ice.Tliquidus)
    expect(boilEnthalpy(ice)).toBeCloseTo(expected, 6)
    // sanity: enthalpy at exactly 100 C equals the boil threshold
    expect(enthalpyFromTemperature(ice, 100)).toBeCloseTo(boilEnthalpy(ice), 6)
  })
})

describe('vaporiseCell (pure per-cell boiling cap)', () => {
  it('leaves sub-boiling cells untouched', () => {
    const mass = 1
    const energy = enthalpyFromTemperature(ice, 90) * mass
    const r = vaporiseCell(ice, mass, energy)
    expect(r.mass).toBe(mass)
    expect(r.energy).toBe(energy)
    expect(r.ventedSpecific).toBe(0)
  })

  it('leaves non-boiling materials untouched even when superheated', () => {
    const mass = 1
    const energy = enthalpyFromTemperature(wax, 300) * mass
    const r = vaporiseCell(wax, mass, energy)
    expect(r).toEqual({ mass, energy, ventedSpecific: 0 })
  })

  it('caps a superheated cell at the boiling point and removes the right mass', () => {
    const mass = 1
    const hBoil = boilEnthalpy(ice)
    // give the cell one latent-vapor worth of surplus => exactly half a fill unit boils off
    const h = hBoil + 0.5 * ice.latentVapor!
    const r = vaporiseCell(ice, mass, h * mass)
    expect(r.mass).toBeCloseTo(0.5, 9)
    // remaining mass sits exactly at the boiling point
    expect(temperatureFromEnthalpy(ice, r.energy / r.mass)).toBeCloseTo(ice.Tboil!, 6)
    // energy is conserved: what left + what stayed == what we started with
    expect(r.energy + r.ventedSpecific).toBeCloseTo(h * mass, 6)
  })

  it('fully evaporates a cell given more than enough energy', () => {
    const mass = 1
    const hBoil = boilEnthalpy(ice)
    const h = hBoil + 5 * ice.latentVapor! // way more than one fill-unit needs
    const r = vaporiseCell(ice, mass, h * mass)
    expect(r.mass).toBe(0)
    expect(r.energy).toBe(0)
    // all of the cell's energy vented
    expect(r.ventedSpecific).toBeCloseTo(h * mass, 6)
  })
})

function waterSim(overrides: Partial<SimConfig> = {}): Sim {
  return new Sim({
    width: 16,
    height: 12,
    material: ice,
    dx: 0.01,
    Tambient: 20,
    initialT: 96, // liquid water just below boiling
    hAmbient: 0,
    heater: { x0: 4, x1: 12, side: 'top', power: 80_000, on: true },
    flowRate: 0.25,
    preset: 'block',
    ...overrides,
  })
}

describe('Sim boiling', () => {
  it('starts with a zero vapor ledger', () => {
    expect(waterSim().ventedJoules).toBe(0)
  })

  it('boils water away under a strong heater (loses mass)', () => {
    const sim = waterSim()
    const m0 = totalMass(sim.grid)
    for (let i = 0; i < 200; i++) sim.step(5)
    expect(totalMass(sim.grid)).toBeLessThan(m0)
    expect(sim.ventedJoules).toBeGreaterThan(0)
  })

  it('never lets water superheat far past its boiling point', () => {
    const sim = waterSim()
    for (let i = 0; i < 300; i++) {
      sim.step(5)
      expect(sim.stats().maxT).toBeLessThan(ice.Tboil! + 2)
    }
  })

  it('closes the energy ledger to float precision (in - out == stored delta)', () => {
    const sim = waterSim()
    const j0 = totalJoules(sim.grid, sim.cfg.dx)
    for (let i = 0; i < 150; i++) sim.step(5)
    const jNow = totalJoules(sim.grid, sim.cfg.dx)
    const expected = j0 + sim.heaterJoules + sim.ambientJoules - sim.ventedJoules
    expect(Math.abs(jNow - expected) / Math.abs(jNow)).toBeLessThan(1e-9)
  })

  it('does not boil materials that lack a boiling point', () => {
    const sim = waterSim({ material: wax, initialT: 20 })
    for (let i = 0; i < 100; i++) sim.step(5)
    expect(sim.ventedJoules).toBe(0)
    expect(totalMass(sim.grid)).toBeCloseTo(totalMass(new Sim(sim.cfg).grid), 6)
  })
})
