/**
 * Fixed-grid enthalpy method for phase change.
 *
 * We track specific enthalpy h (J/kg) instead of temperature so the latent
 * heat plateau falls out naturally. Reference point: h = 0 at the solidus.
 *
 *   solid  (T <= Ts):        h = cSolid * (T - Ts)          (h <= 0)
 *   mushy  (Ts < T < Tl):    h = phi * L,  T = Ts + phi * (Tl - Ts)
 *   liquid (T >= Tl):        h = L + cLiquid * (T - Tl)     (h >= L)
 *
 * Simplification (documented in the README): sensible heat inside the mushy
 * zone is folded into the latent plateau, i.e. enthalpy in the zone is purely
 * proportional to the liquid fraction phi.
 */
import type { Material } from './materials.ts'

/** Specific enthalpy (J/kg) for a given temperature (degrees C). */
export function enthalpyFromTemperature(m: Material, T: number): number {
  if (T <= m.Tsolidus) return m.cSolid * (T - m.Tsolidus)
  if (T >= m.Tliquidus) return m.latentHeat + m.cLiquid * (T - m.Tliquidus)
  const phi = (T - m.Tsolidus) / (m.Tliquidus - m.Tsolidus)
  return phi * m.latentHeat
}

/** Temperature (degrees C) for a given specific enthalpy (J/kg). */
export function temperatureFromEnthalpy(m: Material, h: number): number {
  if (h <= 0) return m.Tsolidus + h / m.cSolid
  if (h >= m.latentHeat) return m.Tliquidus + (h - m.latentHeat) / m.cLiquid
  const phi = h / m.latentHeat
  return m.Tsolidus + phi * (m.Tliquidus - m.Tsolidus)
}

/** Liquid (molten) mass fraction in [0, 1] for a given specific enthalpy. */
export function liquidFraction(m: Material, h: number): number {
  if (h <= 0) return 0
  if (h >= m.latentHeat) return 1
  return h / m.latentHeat
}

/**
 * Specific enthalpy (J/kg) at which the fully-liquid material reaches its
 * boiling point. At or above this enthalpy, further energy vaporises mass
 * rather than raising temperature (handled in the simulator, not here, so the
 * h<->T mapping above stays a pure monotone bijection). Materials without a
 * defined boiling point never boil in-sim, signalled by +Infinity.
 */
export function boilEnthalpy(m: Material): number {
  if (m.Tboil === undefined || m.latentVapor === undefined) return Infinity
  return m.latentHeat + m.cLiquid * (m.Tboil - m.Tliquidus)
}
