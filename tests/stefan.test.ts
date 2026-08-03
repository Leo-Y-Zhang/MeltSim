import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { enthalpyFromTemperature, liquidFraction } from '../src/core/enthalpy.ts'
import { createGrid, specificEnthalpy } from '../src/core/grid.ts'
import { diffuse, stableDt } from '../src/core/heat.ts'

/**
 * Validation against the one-phase Stefan problem.
 *
 * Setup: a semi-infinite solid initially at its melting temperature Tm; at
 * t = 0 the wall x = 0 is held at T0 > Tm. The analytic melt-front position
 * is s(t) = 2 lambda sqrt(alpha_l t), where lambda solves
 *
 *     lambda e^(lambda^2) erf(lambda) = Ste / sqrt(pi),
 *     Ste = c_l (T0 - Tm) / L.
 *
 * Discrete analogue: a 1D column of ice cells at the solidus (phi = 0), the
 * first cell pinned to T0 every step (Dirichlet wall), conduction stepped at
 * the stable explicit dt. The model melts across a 1 degC mushy band around
 * Tm = 0, so exact agreement is impossible by construction; the test pins
 * down HOW close the scheme lands (front position within 5% of analytic
 * after the early transient, and sqrt(t) growth scaling).
 */

// Abramowitz & Stegun 7.1.26, |error| <= 1.5e-7 — plenty for a 5% bound.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

function solveLambda(stefan: number): number {
  const target = stefan / Math.sqrt(Math.PI)
  const f = (l: number): number => l * Math.exp(l * l) * erf(l) - target
  let lo = 1e-6
  let hi = 3
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) > 0) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

/** Melt-front position (m): where phi crosses 0.5, linearly interpolated. */
function frontPosition(
  g: ReturnType<typeof createGrid>,
  mat: (typeof MATERIALS)[string],
  dx: number,
): number {
  let prevPhi = liquidFraction(mat!, specificEnthalpy(g, 0))
  for (let i = 1; i < g.width; i++) {
    const phi = liquidFraction(mat!, specificEnthalpy(g, i))
    if (prevPhi >= 0.5 && phi < 0.5) {
      const frac = (prevPhi - 0.5) / (prevPhi - phi)
      return (i - 1 + 0.5 + frac) * dx
    }
    prevPhi = phi
  }
  return 0
}

describe('Stefan problem benchmark (1D melt front vs analytic solution)', () => {
  const ice = MATERIALS['ice']!
  const dx = 0.001 // 1 mm cells
  const N = 240
  const T0 = 60
  const Tm = (ice.Tsolidus + ice.Tliquidus) / 2 // 0 degC mid-mush

  const alphaL = ice.k / (ice.rho * ice.cLiquid)
  const stefan = (ice.cLiquid * (T0 - Tm)) / ice.latentHeat
  const lambda = solveLambda(stefan)
  const analytic = (t: number): number => 2 * lambda * Math.sqrt(alphaL * t)

  // run once, sample at several times
  const g = createGrid(N, 1, [ice])
  for (let i = 0; i < N; i++) {
    g.mass[i] = 1
    g.energy[i] = enthalpyFromTemperature(ice, ice.Tsolidus)
  }
  const hWall = enthalpyFromTemperature(ice, T0)
  const dt = stableDt(ice, dx)
  const samples: Array<{ t: number; sim: number; exact: number }> = []
  const sampleAt = [500, 1000, 2000]
  let t = 0
  const scratch = new Float64Array(N)
  for (const tTarget of sampleAt) {
    while (t < tTarget) {
      g.energy[0] = hWall // Dirichlet wall
      diffuse(g, dx, dt, scratch)
      t += dt
    }
    samples.push({ t, sim: frontPosition(g, ice, dx), exact: analytic(t) })
  }

  it('solves the transcendental equation plausibly (sanity on the test itself)', () => {
    expect(stefan).toBeCloseTo(0.752, 2)
    expect(lambda).toBeGreaterThan(0.5)
    expect(lambda).toBeLessThan(0.6)
    // erf sanity against known values
    expect(erf(1)).toBeCloseTo(0.8427, 3)
    expect(erf(0.5)).toBeCloseTo(0.5205, 3)
  })

  it('tracks the analytic front position within 5% after the early transient', () => {
    for (const s of samples) {
      const relErr = Math.abs(s.sim - s.exact) / s.exact
      expect(s.sim).toBeGreaterThan(0)
      expect(relErr).toBeLessThan(0.05)
    }
  })

  it('grows with sqrt(t): front at 4x the time is ~2x as deep', () => {
    const s500 = samples[0]!.sim
    const s2000 = samples[2]!.sim
    expect(s2000 / s500).toBeGreaterThan(1.85)
    expect(s2000 / s500).toBeLessThan(2.15)
  })

  it('keeps the far field solid (semi-infinite assumption holds)', () => {
    const phiLast = liquidFraction(ice, specificEnthalpy(g, N - 1))
    expect(phiLast).toBe(0)
  })
})
