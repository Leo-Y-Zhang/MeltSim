/**
 * Simulation grid: struct-of-arrays over a row-major 2D lattice.
 *
 * Per cell we track:
 *  - mass: fill fraction in [0, 1] (1 = cell full of material, 0 = empty).
 *  - energy: fill-weighted specific enthalpy E = mass * h in J/kg, so that
 *    the cell's true thermal energy is E * rho * dx^2 (per unit depth).
 *    Storing E instead of h makes symmetric pairwise exchanges conserve
 *    energy exactly for a single material; ACROSS materials with different
 *    densities the conserved quantity is joules, exposed by totalJoules().
 *  - matIndex: which entry of `materials` occupies the cell. Cells are
 *    strictly single-material: mass never mixes across materials, and the
 *    index of an empty cell is meaningless until material moves into it.
 */
import type { Material } from './materials.ts'
import { enthalpyFromTemperature } from './enthalpy.ts'

/** Cells with less mass than this are treated as empty. */
export const MASS_EPS = 1e-9

export interface Grid {
  readonly width: number
  readonly height: number
  /** Materials present on this grid; matIndex values index into it. */
  readonly materials: Material[]
  /** Per-cell index into `materials` (meaningful only where mass > MASS_EPS). */
  readonly matIndex: Uint8Array
  readonly mass: Float64Array
  readonly energy: Float64Array
}

/** Create an empty width x height grid over the given material palette. */
export function createGrid(width: number, height: number, materials: Material[] = []): Grid {
  return {
    width,
    height,
    materials,
    matIndex: new Uint8Array(width * height),
    mass: new Float64Array(width * height),
    energy: new Float64Array(width * height),
  }
}

/** Row-major index of cell (x, y); y = 0 is the top row. */
export function idx(g: Grid, x: number, y: number): number {
  return y * g.width + x
}

/** Index of material m in g.materials, registering it if absent (max 256). */
export function materialIndex(g: Grid, m: Material): number {
  const existing = g.materials.indexOf(m)
  if (existing >= 0) return existing
  if (g.materials.length >= 256) throw new Error('a grid supports at most 256 materials')
  g.materials.push(m)
  return g.materials.length - 1
}

/** The material occupying cell i. Throws if the cell's index is unregistered. */
export function cellMaterial(g: Grid, i: number): Material {
  const m = g.materials[g.matIndex[i]!]
  if (!m) throw new Error(`cell ${i} references unregistered material ${g.matIndex[i]}`)
  return m
}

/** Fill a rectangle with full cells of material m at uniform temperature T. */
export function fillRect(
  g: Grid,
  m: Material,
  x0: number,
  y0: number,
  w: number,
  h: number,
  T: number,
): void {
  const mi = materialIndex(g, m)
  const hSpec = enthalpyFromTemperature(m, T)
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = idx(g, x, y)
      g.mass[i] = 1
      g.energy[i] = hSpec
      g.matIndex[i] = mi
    }
  }
}

/** Specific enthalpy h (J/kg) of cell i, or 0 for empty cells. */
export function specificEnthalpy(g: Grid, i: number): number {
  const m = g.mass[i]!
  return m > MASS_EPS ? g.energy[i]! / m : 0
}

/**
 * Sum of fill-weighted specific enthalpy over the grid (units J/kg).
 * This is the conserved quantity for SINGLE-material grids; for grids
 * mixing materials of different density, use totalJoules instead.
 */
export function totalEnergy(g: Grid): number {
  let sum = 0
  for (let i = 0; i < g.energy.length; i++) sum += g.energy[i]!
  return sum
}

/**
 * Total thermal energy in joules (per metre of depth):
 * sum over cells of energy * rho * dx^2. This is the physically conserved
 * quantity on insulated multi-material grids, because a face flux of q
 * joules changes the fill-weighted enthalpies by +q/(rho_i dx^2) and
 * -q/(rho_j dx^2) on the two sides.
 */
export function totalJoules(g: Grid, dx: number): number {
  let sum = 0
  for (let i = 0; i < g.energy.length; i++) {
    const e = g.energy[i]!
    if (e !== 0) sum += e * cellMaterial(g, i).rho
  }
  return sum * dx * dx
}

/** Sum of mass (fill fractions) over the grid. */
export function totalMass(g: Grid): number {
  let sum = 0
  for (let i = 0; i < g.mass.length; i++) sum += g.mass[i]!
  return sum
}

/** Sum of mass (fill fractions) over cells occupied by material m. */
export function materialMass(g: Grid, m: Material): number {
  const mi = g.materials.indexOf(m)
  if (mi < 0) return 0
  let sum = 0
  for (let i = 0; i < g.mass.length; i++) {
    if (g.matIndex[i] === mi) sum += g.mass[i]!
  }
  return sum
}
