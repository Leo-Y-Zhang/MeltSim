/**
 * Gravity-driven slumping of molten material.
 *
 * This is deliberately NOT a Navier-Stokes solver. It is a mass-conserving
 * cellular automaton: gravity drops any unsupported mass into headroom below
 * (solid or molten - solids fall as rubble); cells blocked from falling
 * relax sideways toward neighbours with less fill, at a rate set by their
 * `mobility` (liquid fraction + viscosity), so only melt creeps outward.
 * Every transfer moves the matching share of enthalpy with the mass, so
 * both mass and energy are conserved exactly. The sweep direction
 * alternates with step parity to avoid a left/right bias.
 *
 * MULTI-MATERIAL RULE: mass only ever moves between cells of the SAME
 * material or into EMPTY cells, which adopt the source's material index.
 * A cell holding a different material acts as a rigid wall (and as a floor
 * for the lateral pass). Cells therefore stay strictly single-material;
 * there is no mixing, wetting or displacement between materials - a
 * documented simplification. Melt consequently flows OVER a substrate such
 * as toast rather than into it.
 */
import { MASS_EPS, cellMaterial, type Grid } from './grid.ts'
import { mobility } from './viscosity.ts'

const FULL_EPS = 1e-6

/**
 * One flow step. `rate` in (0, 0.5] is the fraction of the allowed transfer
 * performed per step (a model knob, not a physical constant); `parity`
 * alternates the horizontal sweep direction (pass the step counter).
 * Cell materials are read from the grid (Grid.matIndex / Grid.materials).
 */
export function flowStep(g: Grid, rate: number, parity: number): void {
  const { width, height, mass, energy, matIndex } = g

  // Falling pass, lowest movable rows first so gaps cascade upward.
  // Gravity applies to ALL material, solid or molten: unsupported cells drop
  // freely (solids fall as rubble; only sideways creep is viscosity-gated).
  for (let y = height - 2; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const mi = mass[i]!
      if (mi <= MASS_EPS) continue
      const j = i + width
      const mj = mass[j]!
      if (mj > MASS_EPS && matIndex[j] !== matIndex[i]) continue // different material: wall
      const headroom = 1 - mj
      if (headroom <= FULL_EPS) continue
      if (mj <= MASS_EPS) matIndex[j] = matIndex[i]! // empty cell adopts the material
      const hi = energy[i]! / mi
      const dm = Math.min(mi, headroom)
      mass[i]! -= dm
      mass[j]! += dm
      const de = hi * dm
      energy[i]! -= de
      energy[j]! += de
    }
  }

  // Lateral spreading pass for cells that cannot fall.
  const leftToRight = parity % 2 === 0
  for (let y = 0; y < height; y++) {
    for (let step = 0; step < width; step++) {
      const x = leftToRight ? step : width - 1 - step
      const i = y * width + x
      const mi = mass[i]!
      if (mi <= MASS_EPS) continue
      const below = i + width
      const blockedBelow =
        y === height - 1 ||
        (mass[below]! > MASS_EPS && matIndex[below] !== matIndex[i]) || // substrate = floor
        1 - mass[below]! <= FULL_EPS
      if (!blockedBelow) continue
      const hi = energy[i]! / mi
      const mob = mobility(cellMaterial(g, i), hi)
      if (mob <= 0) continue
      for (const dxn of leftToRight ? [-1, 1] : [1, -1]) {
        const nx = x + dxn
        if (nx < 0 || nx >= width) continue
        const j = i + dxn
        const mjNow = mass[j]!
        if (mjNow > MASS_EPS && matIndex[j] !== matIndex[i]) continue // wall
        const miNow = mass[i]!
        if (mjNow >= miNow) continue
        if (mjNow <= MASS_EPS) matIndex[j] = matIndex[i]!
        const dm = ((miNow - mjNow) / 2) * mob * rate
        mass[i]! -= dm
        mass[j]! += dm
        const de = hi * dm
        energy[i]! -= de
        energy[j]! += de
      }
    }
  }
}
