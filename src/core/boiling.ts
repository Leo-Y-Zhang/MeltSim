/**
 * Boiling / evaporation as a per-cell enthalpy cap.
 *
 * The enthalpy method has no upper bound on liquid enthalpy, so on its own a
 * cell under a strong heater would climb past any temperature. Real liquids
 * instead plateau at their boiling point: further energy converts liquid to
 * vapour at the latent heat of vaporisation, and the vapour leaves. We model
 * exactly that as a clamp applied after conduction — mass is removed and the
 * energy it carries is tracked so the whole-system ledger still closes.
 *
 * Kept as a pure function (grid state in, grid state out) so the conservation
 * arithmetic is unit-tested independently of the simulator wiring.
 */
import { boilEnthalpy } from './enthalpy.ts'
import { MASS_EPS } from './grid.ts'
import type { Material } from './materials.ts'

export interface VaporUpdate {
  /** Fill fraction remaining after vaporisation. */
  mass: number
  /** Fill-weighted specific enthalpy (mass*h) remaining, the grid's stored form. */
  energy: number
  /** Fill-weighted specific enthalpy carried away by vapour (>= 0). */
  ventedSpecific: number
}

/**
 * Apply the boiling cap to one cell. `mass` is the fill fraction and `energy`
 * is `mass * h` (the fill-weighted specific enthalpy the grid stores).
 *
 * Any specific enthalpy above the material's boil threshold vaporises mass at
 * `latentVapor`; the remaining mass is left exactly at the boiling point. By
 * construction `energy_before === energy_after + ventedSpecific`, so summing
 * `ventedSpecific * rho * dx^2` over the grid tracks the joules that left.
 * Non-boiling materials and sub-boiling cells are returned unchanged.
 */
export function vaporiseCell(m: Material, mass: number, energy: number): VaporUpdate {
  if (mass <= MASS_EPS) return { mass, energy, ventedSpecific: 0 }
  const hBoil = boilEnthalpy(m)
  if (!Number.isFinite(hBoil)) return { mass, energy, ventedSpecific: 0 }
  const h = energy / mass
  if (h <= hBoil) return { mass, energy, ventedSpecific: 0 }
  const surplus = h - hBoil
  const dm = Math.min(mass, (mass * surplus) / (m.latentVapor as number))
  const massAfter = mass - dm
  if (massAfter <= MASS_EPS) {
    // whole cell boils off: all of its energy leaves with the vapour
    return { mass: 0, energy: 0, ventedSpecific: energy }
  }
  const energyAfter = massAfter * hBoil
  return { mass: massAfter, energy: energyAfter, ventedSpecific: energy - energyAfter }
}
