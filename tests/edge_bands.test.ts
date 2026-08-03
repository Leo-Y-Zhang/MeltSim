import { describe, expect, it } from 'vitest'
import { DEFAULT_SCENARIO, scenarioToSimConfig, type Scenario } from '../src/scenario/scenario.ts'
import { Sim } from '../src/core/sim.ts'

const DIMS = { width: 120, height: 72, dx: 0.01 }

/**
 * Regression for the confirmed spanToCols edge bug: centerPct=100, spanPct=0
 * used to produce an off-grid band [width, width+1) that silently heated (or
 * poured into) zero columns. The band must stay in-grid with >= 1 column.
 */
describe('scenarioToSimConfig keeps bands on-grid at extreme centre/span', () => {
  const cases: Array<[number, number]> = [
    [100, 0],
    [0, 0],
    [100, 100],
    [50, 0],
    [100, 5],
  ]

  it('heater band is always in-grid with at least one column', () => {
    for (const [centerPct, spanPct] of cases) {
      const cfg = scenarioToSimConfig({ ...DEFAULT_SCENARIO, centerPct, spanPct }, DIMS)
      expect(cfg.heater.x0).toBeGreaterThanOrEqual(0)
      expect(cfg.heater.x0).toBeLessThan(DIMS.width)
      expect(cfg.heater.x1).toBeGreaterThan(cfg.heater.x0)
      expect(cfg.heater.x1).toBeLessThanOrEqual(DIMS.width)
    }
  })

  it('pour-source band is always in-grid with at least one column', () => {
    const s: Scenario = {
      ...DEFAULT_SCENARIO,
      preset: 'mould',
      source: { materialId: 'solder', T: 230, massRate: 0.06, x0Pct: 100, x1Pct: 100 },
      mould: { Twall: 20 },
    }
    const cfg = scenarioToSimConfig(s, DIMS)
    expect(cfg.source).toBeDefined()
    expect(cfg.source!.x0).toBeGreaterThanOrEqual(0)
    expect(cfg.source!.x0).toBeLessThan(DIMS.width)
    expect(cfg.source!.x1).toBeGreaterThan(cfg.source!.x0)
    expect(cfg.source!.x1).toBeLessThanOrEqual(DIMS.width)
  })

  it('builds a runnable Sim from the extreme heater band', () => {
    const cfg = scenarioToSimConfig(
      { ...DEFAULT_SCENARIO, centerPct: 100, spanPct: 0, heaterSide: 'top', powerKw: 40 },
      DIMS,
    )
    expect(() => new Sim(cfg)).not.toThrow()
  })
})
