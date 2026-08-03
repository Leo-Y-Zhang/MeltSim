/**
 * Temperature-dependent viscosity and a dimensionless flow mobility.
 *
 * Viscosity follows a simple exponential (Arrhenius-like) decay above the
 * liquidus, clamped to muMin. Below the liquidus the material barely flows,
 * so we simply report mu0 there; whether it flows at all is decided by the
 * liquid-fraction percolation threshold in `mobility`.
 */
import type { Material } from './materials.ts'
import { liquidFraction, temperatureFromEnthalpy } from './enthalpy.ts'

/** Liquid fraction below which the mush is jammed and cannot flow. */
export const PHI_FLOW = 0.3

/** Dynamic viscosity (Pa s) at temperature T (degrees C). */
export function viscosity(m: Material, T: number): number {
  if (T <= m.Tliquidus) return m.mu0
  return Math.max(m.muMin, m.mu0 * Math.exp(-m.muDecay * (T - m.Tliquidus)))
}

/**
 * Dimensionless mobility in [0, 1]: how readily a cell's mass flows this
 * step. 0 while the liquid fraction is under the percolation threshold,
 * then grows with liquid fraction and with temperature (falling viscosity).
 * The log compression keeps materials whose viscosities span six orders of
 * magnitude (water vs cheese) on one usable scale.
 */
export function mobility(m: Material, h: number): number {
  const phi = liquidFraction(m, h)
  if (phi < PHI_FLOW) return 0
  const phiFactor = ((phi - PHI_FLOW) / (1 - PHI_FLOW)) ** 2
  const mu = viscosity(m, temperatureFromEnthalpy(m, h))
  const muFactor = 1 / (1 + Math.log(1 + mu))
  return phiFactor * muFactor
}
