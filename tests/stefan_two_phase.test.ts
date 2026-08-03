import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { enthalpyFromTemperature, liquidFraction } from '../src/core/enthalpy.ts'
import { createGrid, specificEnthalpy } from '../src/core/grid.ts'
import { diffuse, stableDt } from '../src/core/heat.ts'

/**
 * Validation against the TWO-PHASE Stefan problem (solidification).
 *
 * A semi-infinite liquid initially at T_inf > Tm; at t = 0 the wall x = 0 is
 * dropped to Tw < Tm. A solid layer grows from the wall while the liquid ahead
 * of the front is still superheated and slowly gives up that heat — BOTH
 * phases are thermally active, unlike the one-phase melt benchmark. The front
 * is X(t) = 2 lambda sqrt(alpha_s t), where lambda solves
 *
 *     St_s / (e^{l^2} erf(l))  -  St_l (c_s/c_l) nu / (e^{(l nu)^2} erfc(l nu))  =  l sqrt(pi),
 *
 * with nu = sqrt(alpha_s / alpha_l), St_s = c_s (Tm - Tw)/L,
 * St_l = c_l (T_inf - Tm)/L. The c_s/c_l factor comes from normalising the
 * interface flux balance by the solid heat capacity (the liquid term carries
 * c_l but the equation is divided through by L/c_s). Setting T_inf = Tm
 * (St_l = 0) recovers the one-phase equation l e^{l^2} erf(l) = St_s/sqrt(pi).
 *
 * Discrete analogue: a 1D column of water cells initially liquid at T_inf, the
 * wall cell pinned to Tw every step (Dirichlet), conduction at the stable
 * explicit dt. The scheme freezes across a 1 degC mushy band, so exact
 * agreement is impossible; the test pins how close it lands. Observed on 1 mm
 * cells: front error 6.1% at t=400 s, 4.0% at 800 s, 2.6% at 1500 s (lambda =
 * 0.239) - the transient shrinks as the front outgrows the mushy band, exactly
 * as in the one-phase melt benchmark.
 */

// Abramowitz & Stegun 7.1.26 (|error| <= 1.5e-7); erfc = 1 - erf. Both are
// only evaluated at small arguments here (l, l*nu < ~0.4), so this is ample.
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
const erfc = (x: number): number => 1 - erf(x)

function solveTwoPhaseLambda(stS: number, stL: number, nu: number, cRatio: number): number {
  const f = (l: number): number =>
    stS / (Math.exp(l * l) * erf(l)) -
    (stL * cRatio * nu) / (Math.exp((l * nu) ** 2) * erfc(l * nu)) -
    l * Math.sqrt(Math.PI)
  let lo = 1e-6
  let hi = 1
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    // f is +inf as l->0 and negative at l=1, decreasing through the root
    if (f(mid) > 0) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Freeze-front position (m): where phi rises through 0.5 from the cold wall. */
function freezeFront(
  g: ReturnType<typeof createGrid>,
  mat: (typeof MATERIALS)[string],
  dx: number,
): number {
  let prev = liquidFraction(mat!, specificEnthalpy(g, 0))
  for (let i = 1; i < g.width; i++) {
    const phi = liquidFraction(mat!, specificEnthalpy(g, i))
    if (prev < 0.5 && phi >= 0.5) {
      const frac = (0.5 - prev) / (phi - prev)
      return (i - 1 + 0.5 + frac) * dx
    }
    prev = phi
  }
  return 0
}

describe('two-phase Stefan benchmark (freeze front vs analytic solution)', () => {
  const ice = MATERIALS['ice']!
  const dx = 0.001 // 1 mm cells
  const N = 280
  const Tw = -30 // cold wall
  const Tinf = 20 // superheated liquid
  const Tm = (ice.Tsolidus + ice.Tliquidus) / 2 // 0 degC mid-mush

  const alphaS = ice.k / (ice.rho * ice.cSolid)
  const alphaL = ice.k / (ice.rho * ice.cLiquid)
  const nu = Math.sqrt(alphaS / alphaL)
  const stS = (ice.cSolid * (Tm - Tw)) / ice.latentHeat
  const stL = (ice.cLiquid * (Tinf - Tm)) / ice.latentHeat
  const lambda = solveTwoPhaseLambda(stS, stL, nu, ice.cSolid / ice.cLiquid)
  const analytic = (t: number): number => 2 * lambda * Math.sqrt(alphaS * t)

  const g = createGrid(N, 1, [ice])
  const hInf = enthalpyFromTemperature(ice, Tinf)
  for (let i = 0; i < N; i++) {
    g.mass[i] = 1
    g.energy[i] = hInf
  }
  const hWall = enthalpyFromTemperature(ice, Tw)
  const dt = stableDt(ice, dx)
  const scratch = new Float64Array(N)
  const sampleAt = [400, 800, 1500]
  const samples: Array<{ t: number; sim: number; exact: number }> = []
  let t = 0
  for (const tTarget of sampleAt) {
    while (t < tTarget) {
      g.energy[0] = hWall // Dirichlet cold wall
      diffuse(g, dx, dt, scratch)
      t += dt
    }
    samples.push({ t, sim: freezeFront(g, ice, dx), exact: analytic(t) })
  }

  it('solves the two-phase transcendental equation plausibly', () => {
    expect(stS).toBeGreaterThan(0)
    expect(stL).toBeGreaterThan(0)
    expect(nu).toBeCloseTo(Math.sqrt(ice.cLiquid / ice.cSolid), 9)
    expect(lambda).toBeGreaterThan(0.15)
    expect(lambda).toBeLessThan(0.25)
    expect(erfc(0)).toBeCloseTo(1, 6)
    expect(erf(1)).toBeCloseTo(0.8427, 3)
  })

  it('tracks the analytic freeze front within 8% after the early transient', () => {
    for (const s of samples) {
      expect(s.sim).toBeGreaterThan(0)
      const relErr = Math.abs(s.sim - s.exact) / s.exact
      expect(relErr).toBeLessThan(0.08)
    }
  })

  it('grows as sqrt(t): front at ~3.75x the time is ~1.9x as deep', () => {
    const ratio = samples[2]!.sim / samples[0]!.sim
    expect(ratio).toBeGreaterThan(1.8)
    expect(ratio).toBeLessThan(2.1)
  })

  it('keeps the far field liquid and superheated (semi-infinite holds)', () => {
    expect(liquidFraction(ice, specificEnthalpy(g, N - 1))).toBe(1)
  })
})
