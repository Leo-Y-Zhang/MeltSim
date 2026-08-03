import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { Sim } from '../src/core/sim.ts'
import {
  DEFAULT_SCENARIO,
  scenarioFromJSON,
  scenarioFromQuery,
  scenarioToJSON,
  scenarioToQuery,
  scenarioToSimConfig,
  type Scenario,
} from '../src/scenario/scenario.ts'

const DIMS = { width: 120, height: 72, dx: 0.01 }

/** A minimal, in-range scenario (no optional fields). */
const minimal: Scenario = {
  materialId: 'wax',
  preset: 'slab',
  heaterSide: 'top',
  powerKw: 25,
  ambient: 20,
  spanPct: 40,
  centerPct: 50,
  speedExp: 2,
}

/** A scenario exercising warp + autorun. */
const withWarp: Scenario = {
  ...minimal,
  materialId: 'chocolate',
  preset: 'mound',
  heaterSide: 'bottom',
  powerKw: 12,
  ambient: 30,
  spanPct: 15,
  centerPct: 33,
  speedExp: 3,
  warp: 7200,
  autorun: true,
}

/** A casting scenario with both a pour source and cold mould walls. */
const casting: Scenario = {
  materialId: 'solder',
  preset: 'mould',
  heaterSide: 'off',
  powerKw: 2,
  ambient: -20,
  spanPct: 0,
  centerPct: 50,
  speedExp: 4,
  source: { materialId: 'solder', T: 220, massRate: 0.06, x0Pct: 40, x1Pct: 60 },
  mould: { Twall: -20 },
}

describe('scenario query round-trip', () => {
  for (const [name, s] of [
    ['default', DEFAULT_SCENARIO],
    ['minimal', minimal],
    ['warp+autorun', withWarp],
    ['casting (source+mould)', casting],
  ] as const) {
    it(`fromQuery(toQuery(s)) deep-equals ${name}`, () => {
      expect(scenarioFromQuery(scenarioToQuery(s))).toEqual(s)
    })
  }

  it('produces a bare autorun-free query for a scenario without autorun', () => {
    const q = scenarioToQuery(minimal)
    expect(q).not.toContain('autorun')
    expect(q).not.toContain('warp')
    expect(q).not.toContain('twall')
  })

  it('tolerates a leading question mark', () => {
    expect(scenarioFromQuery('?' + scenarioToQuery(withWarp))).toEqual(withWarp)
  })
})

describe('scenario JSON round-trip', () => {
  for (const [name, s] of [
    ['minimal', minimal],
    ['warp+autorun', withWarp],
    ['casting (source+mould)', casting],
  ] as const) {
    it(`fromJSON(toJSON(s)) deep-equals ${name}`, () => {
      expect(scenarioFromJSON(scenarioToJSON(s))).toEqual(s)
    })
  }

  it('emits stable, pretty-printed JSON', () => {
    const j = scenarioToJSON(minimal)
    expect(j).toContain('\n')
    expect(() => JSON.parse(j)).not.toThrow()
  })
})

describe('tolerant query parsing', () => {
  it('returns the base scenario for a garbage query', () => {
    expect(scenarioFromQuery('%%%&=&foo')).toEqual(DEFAULT_SCENARIO)
    expect(scenarioFromQuery('')).toEqual(DEFAULT_SCENARIO)
  })

  it('ignores unknown keys', () => {
    const s = scenarioFromQuery('material=wax&frobnicate=99&scene=block')
    expect(s.materialId).toBe('wax')
    expect(s.preset).toBe('block')
    expect(s).not.toHaveProperty('frobnicate')
  })

  it('falls back on an unknown material id', () => {
    expect(scenarioFromQuery('material=unobtanium').materialId).toBe(DEFAULT_SCENARIO.materialId)
  })

  it('rejects a substrate material id, falling back to the base', () => {
    expect(scenarioFromQuery('material=toast').materialId).toBe(DEFAULT_SCENARIO.materialId)
    expect(scenarioFromQuery('material=steel').materialId).toBe(DEFAULT_SCENARIO.materialId)
  })

  it('clamps out-of-range power and ambient', () => {
    const hi = scenarioFromQuery('power=9999&ambient=100000')
    expect(hi.powerKw).toBe(60)
    expect(hi.ambient).toBe(300)
    const lo = scenarioFromQuery('power=-5&ambient=-9999')
    expect(lo.powerKw).toBe(2)
    expect(lo.ambient).toBe(-100)
  })

  it('falls back on a non-numeric power', () => {
    expect(scenarioFromQuery('power=abc').powerKw).toBe(DEFAULT_SCENARIO.powerKw)
  })

  it('ignores an invalid scene or side', () => {
    const s = scenarioFromQuery('scene=lava&side=sideways')
    expect(s.preset).toBe(DEFAULT_SCENARIO.preset)
    expect(s.heaterSide).toBe(DEFAULT_SCENARIO.heaterSide)
  })

  it('honours a custom base scenario for absent fields', () => {
    const base: Scenario = { ...minimal, materialId: 'butter', powerKw: 40 }
    const s = scenarioFromQuery('ambient=5', base)
    expect(s.materialId).toBe('butter')
    expect(s.powerKw).toBe(40)
    expect(s.ambient).toBe(5)
  })
})

describe('JSON validation', () => {
  it('throws on structurally invalid JSON text', () => {
    expect(() => scenarioFromJSON('{not json')).toThrow()
  })

  it('throws when the root is not an object', () => {
    expect(() => scenarioFromJSON('[1,2,3]')).toThrow()
    expect(() => scenarioFromJSON('42')).toThrow()
  })

  it('throws on an unknown material id', () => {
    const bad = JSON.stringify({ ...minimal, materialId: 'unobtanium' })
    expect(() => scenarioFromJSON(bad)).toThrow(/material/)
  })

  it('throws on a non-numeric required field', () => {
    const bad = JSON.stringify({ ...minimal, powerKw: 'lots' })
    expect(() => scenarioFromJSON(bad)).toThrow(/powerKw/)
  })

  it('clamps out-of-range numbers rather than throwing', () => {
    const wide = JSON.stringify({ ...minimal, powerKw: 500, ambient: -500 })
    const s = scenarioFromJSON(wide)
    expect(s.powerKw).toBe(60)
    expect(s.ambient).toBe(-100)
  })
})

describe('scenarioToSimConfig', () => {
  it('resolves the material and basic geometry', () => {
    const cfg = scenarioToSimConfig(minimal, DIMS)
    expect(cfg.material).toBe(MATERIALS['wax'])
    expect(cfg.width).toBe(120)
    expect(cfg.height).toBe(72)
    expect(cfg.dx).toBe(0.01)
    expect(cfg.preset).toBe('slab')
    expect(cfg.Tambient).toBe(20)
  })

  it('builds heater columns from centre and span, at least one wide', () => {
    const cfg = scenarioToSimConfig(minimal, DIMS)
    // 40% span centred at 50% over 120 columns -> [36, 84)
    expect(cfg.heater.x0).toBe(36)
    expect(cfg.heater.x1).toBe(84)
    expect(cfg.heater.x1).toBeGreaterThan(cfg.heater.x0)
    expect(cfg.heater.side).toBe('top')
    expect(cfg.heater.on).toBe(true)
  })

  it('guarantees a non-empty heater band even at zero span', () => {
    const cfg = scenarioToSimConfig({ ...minimal, spanPct: 0 }, DIMS)
    expect(cfg.heater.x1).toBe(cfg.heater.x0 + 1)
  })

  it("disables the heater and parks side='top' when off", () => {
    const cfg = scenarioToSimConfig({ ...minimal, heaterSide: 'off' }, DIMS)
    expect(cfg.heater.on).toBe(false)
    expect(cfg.heater.side).toBe('top')
  })

  it('threads through the pour source and mould walls', () => {
    const cfg = scenarioToSimConfig(casting, DIMS)
    expect(cfg.source).toBeDefined()
    expect(cfg.source?.material).toBe(MATERIALS['solder'])
    expect(cfg.source?.T).toBe(220)
    expect(cfg.source?.massRate).toBe(0.06)
    expect(cfg.source?.on).toBe(true)
    // span 40..60% over 120 columns -> [48, 72)
    expect(cfg.source?.x0).toBe(48)
    expect(cfg.source?.x1).toBe(72)
    expect(cfg.mould?.Twall).toBe(-20)
  })

  it('omits source and mould when the scenario has none', () => {
    const cfg = scenarioToSimConfig(minimal, DIMS)
    expect(cfg.source).toBeUndefined()
    expect(cfg.mould).toBeUndefined()
  })

  it('constructs a Sim without throwing for a plain scenario', () => {
    expect(() => new Sim(scenarioToSimConfig(minimal, DIMS))).not.toThrow()
  })

  it('constructs a Sim without throwing for a casting scenario', () => {
    const sim = new Sim(scenarioToSimConfig(casting, DIMS))
    expect(sim.grid.materials).toContain(MATERIALS['solder'])
    expect(sim.mouldMat).toBe(MATERIALS['steel'])
    expect(() => sim.step(2)).not.toThrow()
  })
})
