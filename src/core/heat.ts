/**
 * Explicit finite-volume heat conduction on the grid.
 *
 * Each interior face carries a heat q (joules per metre of depth):
 *
 *   q = k_face * dt * (T_j - T_i) * contact,   contact = min(mass_i, mass_j)
 *
 * where k_face is the plain conductivity for a same-material face and the
 * HARMONIC MEAN 2 k_i k_j / (k_i + k_j) across a mixed-material face (the
 * exact series-resistance value for two half-cells; a documented
 * simplification since it ignores any contact resistance). Because stored
 * cell energy is fill-weighted SPECIFIC enthalpy (J/kg), the same q updates
 * the two sides as dE_i = +q/(rho_i dx^2), dE_j = -q/(rho_j dx^2): joules
 * are conserved exactly even when the densities differ (see totalJoules).
 * Partially filled cells conduct proportionally less, empty faces not at
 * all, and boundaries are insulated by construction.
 */
import type { Material } from './materials.ts'
import { temperatureFromEnthalpy } from './enthalpy.ts'
import { MASS_EPS, cellMaterial, specificEnthalpy, type Grid } from './grid.ts'

const SAFETY = 0.9

/**
 * Largest stable timestep (seconds) for the explicit scheme:
 * SAFETY * dx^2 rho c_min / (4 k_worst) (the classic FTCS bound
 * dt <= dx^2/(4 alpha), taken with the smaller of the two specific heats to
 * be conservative). Pass ALL materials present on the grid (or in the sim
 * config): the bound is the MINIMUM over them.
 *
 * k_worst is the largest face conductivity a cell of that material can see:
 * its own k for same-material faces, or the harmonic mean with any OTHER
 * listed material for mixed faces. The harmonic mean 2 k_i k_j / (k_i + k_j)
 * can reach almost 2x the smaller k (insulator against a good conductor), so
 * using the plain per-material k there would let a cell with several mixed
 * faces break the discrete maximum principle (temperatures overshooting the
 * initial extremes). For a single material this reduces exactly to the
 * classic 0.1.x bound.
 */
export function stableDt(m: Material | readonly Material[], dx: number): number {
  const list: readonly Material[] = Array.isArray(m) ? m : [m as Material]
  if (list.length === 0) throw new Error('stableDt needs at least one material')
  let dt = Infinity
  for (const mat of list) {
    const cMin = Math.min(mat.cSolid, mat.cLiquid)
    let kWorst = mat.k
    for (const other of list) {
      if (other === mat) continue
      const kFace = (2 * mat.k * other.k) / (mat.k + other.k)
      if (kFace > kWorst) kWorst = kFace
    }
    dt = Math.min(dt, (SAFETY * dx * dx * mat.rho * cMin) / (4 * kWorst))
  }
  return dt
}

/**
 * One conduction step of length dt (seconds), in place. Cell materials are
 * read from the grid (Grid.matIndex / Grid.materials). An optional scratch
 * buffer (length >= cells) avoids reallocation in hot loops.
 */
export function diffuse(g: Grid, dx: number, dt: number, scratch?: Float64Array): void {
  const n = g.width * g.height
  const { mass, energy, matIndex, materials } = g
  const T = scratch ?? new Float64Array(n)
  for (let i = 0; i < n; i++) {
    T[i] =
      mass[i]! > MASS_EPS
        ? temperatureFromEnthalpy(cellMaterial(g, i), specificEnthalpy(g, i))
        : 0
  }
  // coeff[a*M+b] converts a face temperature difference into the enthalpy
  // change of the a-side of an (a, b) face: kFace(a,b) * dt / (rho_a dx^2).
  // The diagonal uses the EXACT 0.1.x expression and multiplication order,
  // (k dt) / (rho dx^2), so single-material stepping stays bitwise identical.
  const M = materials.length
  const coeff = new Float64Array(M * M)
  for (let a = 0; a < M; a++) {
    const ma = materials[a]!
    for (let b = 0; b < M; b++) {
      const kFace =
        a === b ? ma.k : (2 * ma.k * materials[b]!.k) / (ma.k + materials[b]!.k)
      coeff[a * M + b] = (kFace * dt) / (ma.rho * dx * dx)
    }
  }

  const exchange = (i: number, j: number, mi: number, mj: number): void => {
    const a = matIndex[i]!
    const b = matIndex[j]!
    const dT = T[j]! - T[i]!
    const contact = Math.min(mi, mj)
    // both sides scale the SAME face heat q = kFace dt dT contact by their
    // own 1/(rho dx^2), so joules are conserved across densities
    energy[i]! += coeff[a * M + b]! * dT * contact
    energy[j]! -= coeff[b * M + a]! * dT * contact
  }

  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const i = y * g.width + x
      const mi = mass[i]!
      if (mi <= MASS_EPS) continue
      // right neighbour
      if (x + 1 < g.width) {
        const mj = mass[i + 1]!
        if (mj > MASS_EPS) exchange(i, i + 1, mi, mj)
      }
      // down neighbour
      if (y + 1 < g.height) {
        const mj = mass[i + g.width]!
        if (mj > MASS_EPS) exchange(i, i + g.width, mi, mj)
      }
    }
  }
}
