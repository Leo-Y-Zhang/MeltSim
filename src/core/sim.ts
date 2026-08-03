/**
 * The simulation orchestrator: couples conduction (heat.ts), phase change
 * (enthalpy.ts) and gravity slumping (flow.ts) on one grid, adds a movable
 * surface heater and ambient convective exchange, and exposes stats.
 *
 * Time model: `step(simDt)` advances the *simulated* clock by simDt seconds,
 * internally sub-stepping conduction at the stable explicit timestep. The
 * caller decides how much simulated time passes per animation frame
 * (time acceleration), because real melting takes minutes to hours.
 *
 * Two-material scenes: the 'toast' preset builds a never-melting substrate
 * slab (cfg.substrate, defaulting to the toast preset material) under a
 * block of cfg.material. All physics (conduction, heater, ambient, stats)
 * read each cell's own material from the grid.
 */
import { MATERIALS, type Material } from './materials.ts'
import { enthalpyFromTemperature, liquidFraction, temperatureFromEnthalpy } from './enthalpy.ts'
import {
  MASS_EPS,
  cellMaterial,
  createGrid,
  materialIndex,
  specificEnthalpy,
  type Grid,
} from './grid.ts'
import { diffuse, stableDt } from './heat.ts'
import { flowStep } from './flow.ts'
import { vaporiseCell } from './boiling.ts'

/** Hard cap on material temperature (degC); heater input is clamped to it. */
export const T_MAX = 350

export type ScenePreset = 'block' | 'slab' | 'mound' | 'toast' | 'mould'

export interface HeaterConfig {
  /** Heated column span [x0, x1). */
  x0: number
  x1: number
  /** Which surface the heater faces. */
  side: 'top' | 'bottom'
  /** Heat flux, W/m^2. */
  power: number
  on: boolean
}

/**
 * A pour source: injects fresh material of a chosen temperature into the top
 * of each source column over time, enabling "pour hot X" scenarios. The
 * injected energy is added to the ledger as pouredJoules.
 */
export interface SourceConfig {
  /** Source column span [x0, x1). */
  x0: number
  x1: number
  /** Poured material (registered on the grid automatically). */
  material: Material
  /** Temperature of the poured material, degC. */
  T: number
  /** Fill fraction injected per source column per second. */
  massRate: number
  on: boolean
}

/**
 * A cold (or hot) mould: rigid wall cells clamped to a fixed temperature every
 * step (a Dirichlet reservoir). Poured melt solidifies against the walls. The
 * clamp is an external heat exchange, tracked separately as wallJoules so the
 * internal ledger still closes.
 */
export interface MouldConfig {
  /** Rigid wall material; defaults to MATERIALS['steel']. */
  material?: Material
  /** Fixed wall temperature, degC. */
  Twall: number
}

export interface SimConfig {
  width: number
  height: number
  material: Material
  /** Cell size, metres. */
  dx: number
  /** Ambient temperature, degC. */
  Tambient: number
  /** Initial material temperature, degC. */
  initialT: number
  /** Convective exchange coefficient with ambient, W/(m^2 K). */
  hAmbient: number
  heater: HeaterConfig
  /** Flow automaton rate knob in (0, 0.5]. */
  flowRate: number
  preset: ScenePreset
  /**
   * Substrate material for two-material presets ('toast'). Optional: the
   * toast preset falls back to MATERIALS['toast']. Ignored by single-
   * material presets.
   */
  substrate?: Material
  /** Optional pour source (adds mass and enthalpy over time). */
  source?: SourceConfig
  /** Mould walls for the 'mould' preset (Dirichlet reservoir). */
  mould?: MouldConfig
}

export interface SimStats {
  totalMass: number
  meltedFraction: number
  minT: number
  maxT: number
  simTime: number
}

/** Seconds of simulated time per flow-automaton step. */
const FLOW_PERIOD = 2
const MAX_FLOW_STEPS = 60

export class Sim {
  readonly cfg: SimConfig
  readonly grid: Grid
  /** Resolved substrate for the toast preset (undefined otherwise). */
  readonly substrate: Material | undefined
  /** Resolved mould wall material for the 'mould' preset (undefined otherwise). */
  readonly mouldMat: Material | undefined
  simTime = 0
  /**
   * Energy ledger (joules per metre of depth, cumulative since the last reset).
   * The invariant `totalJoules(now) === totalJoules(reset)
   *   + heaterJoules + ambientJoules + pouredJoules + wallJoules - ventedJoules`
   * holds to float precision and is asserted by the tests.
   */
  heaterJoules = 0
  ambientJoules = 0
  ventedJoules = 0
  pouredJoules = 0
  wallJoules = 0
  private flowParity = 0
  private readonly scratch: Float64Array
  /** 1 for cells clamped to the mould wall temperature each step. */
  private readonly wallMask: Uint8Array

  constructor(cfg: SimConfig) {
    this.cfg = cfg
    this.substrate =
      cfg.preset === 'toast' ? (cfg.substrate ?? MATERIALS['toast']!) : undefined
    this.mouldMat =
      cfg.preset === 'mould' ? (cfg.mould?.material ?? MATERIALS['steel']!) : undefined
    const mats: Material[] = [cfg.material]
    if (this.substrate && !mats.includes(this.substrate)) mats.push(this.substrate)
    if (this.mouldMat && !mats.includes(this.mouldMat)) mats.push(this.mouldMat)
    if (cfg.source && !mats.includes(cfg.source.material)) mats.push(cfg.source.material)
    this.grid = createGrid(cfg.width, cfg.height, mats)
    this.scratch = new Float64Array(cfg.width * cfg.height)
    this.wallMask = new Uint8Array(cfg.width * cfg.height)
    this.reset()
  }

  /** Rebuild the scene preset at the initial temperature. */
  reset(): void {
    const { width, height, material, initialT, preset } = this.cfg
    this.grid.mass.fill(0)
    this.grid.energy.fill(0)
    this.grid.matIndex.fill(0)
    this.wallMask.fill(0)
    this.simTime = 0
    this.flowParity = 0
    this.heaterJoules = 0
    this.ambientJoules = 0
    this.ventedJoules = 0
    this.pouredJoules = 0
    this.wallJoules = 0
    const h0 = enthalpyFromTemperature(material, initialT)
    const put = (x: number, y: number, mi = 0, h = h0): void => {
      const i = y * width + x
      this.grid.mass[i] = 1
      this.grid.energy[i] = h
      this.grid.matIndex[i] = mi
    }
    if (preset === 'block') {
      const bw = Math.round(width / 2)
      const bh = Math.max(2, Math.round(height * 0.4))
      const x0 = Math.floor((width - bw) / 2)
      for (let y = height - bh; y < height; y++) {
        for (let x = x0; x < x0 + bw; x++) put(x, y)
      }
    } else if (preset === 'slab') {
      const rows = Math.max(2, Math.round(height * 0.18))
      for (let y = height - rows; y < height; y++) {
        for (let x = 0; x < width; x++) put(x, y)
      }
    } else if (preset === 'toast') {
      // Full-width substrate slab on the floor (~20% of the height), with a
      // centred block of the primary material resting on top of it.
      const sub = this.substrate!
      const si = materialIndex(this.grid, sub)
      const hSub = enthalpyFromTemperature(sub, initialT)
      const slabRows = Math.max(2, Math.round(height * 0.2))
      for (let y = height - slabRows; y < height; y++) {
        for (let x = 0; x < width; x++) put(x, y, si, hSub)
      }
      const bw = Math.round(width / 2)
      const bh = Math.max(2, Math.round(height * 0.35))
      const x0 = Math.floor((width - bw) / 2)
      for (let y = height - slabRows - bh; y < height - slabRows; y++) {
        for (let x = x0; x < x0 + bw; x++) put(x, y)
      }
    } else if (preset === 'mould') {
      // A U-shaped rigid mould (floor + two side walls) held at Twall, with an
      // empty cavity to pour into. Side walls rest on the floor so the flow
      // automaton never leaves them unsupported.
      const wallMat = this.mouldMat!
      const wi = materialIndex(this.grid, wallMat)
      const hWall = enthalpyFromTemperature(wallMat, this.cfg.mould?.Twall ?? initialT)
      const thickness = Math.max(1, Math.round(width * 0.08))
      const floorRows = Math.max(1, Math.round(height * 0.1))
      const putWall = (x: number, y: number): void => {
        const i = y * width + x
        this.grid.mass[i] = 1
        this.grid.energy[i] = hWall
        this.grid.matIndex[i] = wi
        this.wallMask[i] = 1
      }
      for (let y = height - floorRows; y < height; y++) {
        for (let x = 0; x < width; x++) putWall(x, y)
      }
      for (let y = 0; y < height - floorRows; y++) {
        for (let t = 0; t < thickness; t++) {
          putWall(t, y)
          putWall(width - 1 - t, y)
        }
      }
    } else {
      // mound: a centred triangle
      const rows = Math.max(3, Math.round(height * 0.55))
      const cx = (width - 1) / 2
      for (let r = 0; r < rows; r++) {
        const y = height - 1 - r
        const half = ((rows - r) / rows) * (width / 2 - 1)
        for (let x = Math.ceil(cx - half); x <= Math.floor(cx + half); x++) put(x, y)
      }
    }
  }

  /** Advance the simulated clock by simDt seconds. */
  step(simDt: number): void {
    const { dx } = this.cfg
    this.applySource(simDt)
    // Stability: the shared explicit step must satisfy the bound for EVERY
    // material on the grid, so take the minimum over all of them.
    const dtStable = stableDt(this.grid.materials, dx)
    const nSub = Math.max(1, Math.ceil(simDt / dtStable))
    const dtSub = simDt / nSub
    for (let s = 0; s < nSub; s++) {
      this.applyHeater(dtSub)
      this.applyAmbient(dtSub)
      diffuse(this.grid, dx, dtSub, this.scratch)
      this.applyBoiling(dx)
      this.applyMouldWalls(dx)
    }
    const nFlow = Math.min(MAX_FLOW_STEPS, Math.max(1, Math.ceil(simDt / FLOW_PERIOD)))
    for (let s = 0; s < nFlow; s++) {
      flowStep(this.grid, this.cfg.flowRate, this.flowParity++)
    }
    this.simTime += simDt
  }

  /** Inject heater flux into the first material cell of each heated column. */
  private applyHeater(dt: number): void {
    const { heater, dx, width, height } = this.cfg
    if (!heater.on) return
    const fromTop = heater.side === 'top'
    for (let x = Math.max(0, heater.x0); x < Math.min(width, heater.x1); x++) {
      for (let s = 0; s < height; s++) {
        const y = fromTop ? s : height - 1 - s
        const i = y * width + x
        const m = this.grid.mass[i]!
        if (m <= MASS_EPS) continue
        const mat = cellMaterial(this.grid, i)
        const hMax = enthalpyFromTemperature(mat, T_MAX)
        const dE = (heater.power * dt) / (mat.rho * dx)
        const cap = hMax * m - this.grid.energy[i]!
        if (cap > 0) {
          const added = Math.min(dE * m, cap)
          this.grid.energy[i]! += added
          this.heaterJoules += added * mat.rho * dx * dx
        }
        break
      }
    }
  }

  /** Convective exchange with ambient on every exposed cell face. */
  private applyAmbient(dt: number): void {
    const { dx, Tambient, hAmbient, width, height } = this.cfg
    if (hAmbient <= 0) return
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        const m = this.grid.mass[i]!
        if (m <= MASS_EPS) continue
        let faces = 0
        if (x === 0 || this.grid.mass[i - 1]! <= MASS_EPS) faces++
        if (x === width - 1 || this.grid.mass[i + 1]! <= MASS_EPS) faces++
        if (y === 0 || this.grid.mass[i - width]! <= MASS_EPS) faces++
        if (y === height - 1 || this.grid.mass[i + width]! <= MASS_EPS) faces++
        if (faces === 0) continue
        const mat = cellMaterial(this.grid, i)
        const coeff = (hAmbient * dt) / (mat.rho * dx)
        const T = temperatureFromEnthalpy(mat, specificEnthalpy(this.grid, i))
        const added = coeff * (Tambient - T) * faces * m
        this.grid.energy[i]! += added
        this.ambientJoules += added * mat.rho * dx * dx
      }
    }
  }

  /**
   * Boiling cap: after conduction, any cell whose material has a boiling point
   * and whose enthalpy exceeds it sheds mass as vapour (see boiling.ts). Runs
   * every sub-step so a transiently superheated cell cannot conduct heat it
   * would physically have spent on vaporisation.
   */
  private applyBoiling(dx: number): void {
    const g = this.grid
    for (let i = 0; i < g.mass.length; i++) {
      const m = g.mass[i]!
      if (m <= MASS_EPS) continue
      const mat = cellMaterial(g, i)
      if (mat.Tboil === undefined) continue
      const r = vaporiseCell(mat, m, g.energy[i]!)
      if (r.ventedSpecific === 0) continue
      g.mass[i] = r.mass
      g.energy[i] = r.energy
      this.ventedJoules += r.ventedSpecific * mat.rho * dx * dx
    }
  }

  /**
   * Pour source: inject fresh material into the highest available cell of each
   * source column, carrying the enthalpy of its pour temperature. A foreign
   * material occupying a column from the top blocks the nozzle for that column.
   */
  private applySource(simDt: number): void {
    const src = this.cfg.source
    if (!src || !src.on || src.massRate <= 0) return
    const { dx, width, height } = this.cfg
    const g = this.grid
    const mi = materialIndex(g, src.material)
    const hPour = enthalpyFromTemperature(src.material, src.T)
    const dm0 = src.massRate * simDt
    for (let x = Math.max(0, src.x0); x < Math.min(width, src.x1); x++) {
      for (let y = 0; y < height; y++) {
        const i = y * width + x
        const m = g.mass[i]!
        if (m > MASS_EPS && g.matIndex[i] !== mi) break // column blocked below the nozzle
        const headroom = 1 - m
        if (headroom <= MASS_EPS) continue
        const dm = Math.min(dm0, headroom)
        if (m <= MASS_EPS) g.matIndex[i] = mi
        g.mass[i] = m + dm
        g.energy[i]! += hPour * dm
        this.pouredJoules += hPour * dm * src.material.rho * dx * dx
        break
      }
    }
  }

  /**
   * Clamp mould wall cells to the fixed wall temperature (Dirichlet reservoir),
   * accumulating the exchanged energy in wallJoules. Wall cells always hold a
   * full unit of the rigid wall material, so stored energy equals its specific
   * enthalpy.
   */
  private applyMouldWalls(dx: number): void {
    const wallMat = this.mouldMat
    const Twall = this.cfg.mould?.Twall
    if (!wallMat || Twall === undefined) return
    const g = this.grid
    const eWall = enthalpyFromTemperature(wallMat, Twall)
    const rdx = wallMat.rho * dx * dx
    for (let i = 0; i < this.wallMask.length; i++) {
      if (this.wallMask[i] === 0) continue
      this.wallJoules += (eWall - g.energy[i]!) * rdx
      g.energy[i] = eWall
    }
  }

  stats(): SimStats {
    let totalMass = 0
    let melted = 0
    let minT = Infinity
    let maxT = -Infinity
    for (let i = 0; i < this.grid.mass.length; i++) {
      const m = this.grid.mass[i]!
      if (m <= MASS_EPS) continue
      const mat = cellMaterial(this.grid, i)
      const h = specificEnthalpy(this.grid, i)
      const T = temperatureFromEnthalpy(mat, h)
      totalMass += m
      melted += m * liquidFraction(mat, h)
      if (T < minT) minT = T
      if (T > maxT) maxT = T
    }
    if (totalMass === 0) {
      minT = this.cfg.Tambient
      maxT = this.cfg.Tambient
    }
    return {
      totalMass,
      meltedFraction: totalMass > 0 ? melted / totalMass : 0,
      minT,
      maxT,
      simTime: this.simTime,
    }
  }
}
