/**
 * Material presets with approximate, literature-informed thermal properties.
 *
 * Values are rounded engineering approximations good enough for a qualitative
 * educational model; they are NOT reference data. Melting is modelled with a
 * mushy zone [Tsolidus, Tliquidus]: pure substances (ice) get a narrow
 * artificial band so the fixed-grid enthalpy method stays well-defined, and
 * cheese (which softens rather than truly melting) gets an *effective* latent
 * heat. See README "Physics" for the full list of simplifications.
 */
export interface Material {
  readonly id: string
  readonly label: string
  /** Density, kg/m^3 (assumed constant across phases). */
  readonly rho: number
  /** Specific heat capacity of the solid phase, J/(kg K). */
  readonly cSolid: number
  /** Specific heat capacity of the liquid phase, J/(kg K). */
  readonly cLiquid: number
  /** Thermal conductivity, W/(m K) (single value for both phases). */
  readonly k: number
  /** Specific latent heat of fusion, J/kg. */
  readonly latentHeat: number
  /** Temperature where melting begins, degrees C. */
  readonly Tsolidus: number
  /** Temperature where the material is fully liquid, degrees C. */
  readonly Tliquidus: number
  /** Dynamic viscosity at the liquidus, Pa s. */
  readonly mu0: number
  /** Exponential viscosity decay per K above the liquidus, 1/K. */
  readonly muDecay: number
  /** Lower clamp on viscosity, Pa s. */
  readonly muMin: number
  /**
   * Boiling point, degrees C. Omit for materials that do not boil within the
   * simulated temperature range; those never lose mass to vaporisation.
   */
  readonly Tboil?: number
  /** Specific latent heat of vaporisation, J/kg. Required whenever Tboil is set. */
  readonly latentVapor?: number
  /** Display colour of the solid phase, RGB 0-255. */
  readonly solidColor: readonly [number, number, number]
  /** Display colour of the fully molten phase, RGB 0-255. */
  readonly meltColor: readonly [number, number, number]
  /**
   * True for substrate materials (e.g. toast): they participate fully in
   * conduction and gravity but are not offered by the UI material selector,
   * which picks only the material placed ON TOP of a substrate.
   */
  readonly substrate?: boolean
}

export const MATERIALS: Record<string, Material> = {
  ice: {
    id: 'ice',
    label: 'Ice',
    rho: 920,
    cSolid: 2100,
    cLiquid: 4186,
    k: 2.2,
    latentHeat: 334_000,
    Tsolidus: -0.5,
    Tliquidus: 0.5,
    mu0: 0.0018,
    muDecay: 0.025,
    muMin: 0.0003,
    Tboil: 100,
    latentVapor: 2_256_000,
    solidColor: [186, 222, 251],
    meltColor: [41, 121, 255],
  },
  chocolate: {
    id: 'chocolate',
    label: 'Chocolate',
    rho: 1250,
    cSolid: 1600,
    cLiquid: 1900,
    k: 0.23,
    latentHeat: 90_000,
    Tsolidus: 27,
    Tliquidus: 34,
    mu0: 25,
    muDecay: 0.08,
    muMin: 1.5,
    solidColor: [82, 50, 28],
    meltColor: [141, 85, 36],
  },
  cheese: {
    id: 'cheese',
    label: 'Cheese',
    rho: 1080,
    cSolid: 2600,
    cLiquid: 3300,
    k: 0.35,
    latentHeat: 30_000,
    Tsolidus: 45,
    Tliquidus: 65,
    mu0: 600,
    muDecay: 0.05,
    muMin: 40,
    solidColor: [255, 202, 87],
    meltColor: [255, 159, 26],
  },
  wax: {
    id: 'wax',
    label: 'Wax',
    rho: 900,
    cSolid: 2100,
    cLiquid: 2400,
    k: 0.24,
    latentHeat: 200_000,
    Tsolidus: 46,
    Tliquidus: 58,
    mu0: 0.06,
    muDecay: 0.03,
    muMin: 0.005,
    solidColor: [240, 234, 214],
    meltColor: [255, 214, 153],
  },
  gallium: {
    id: 'gallium',
    label: 'Gallium',
    // A metal that melts near body temperature (~30 degC) - it will melt in
    // your hand. Near-pure, so a narrow mushy band; high conductivity and a
    // water-like molten viscosity.
    rho: 5910,
    cSolid: 370,
    cLiquid: 400,
    k: 33,
    latentHeat: 80_160,
    Tsolidus: 29.5,
    Tliquidus: 30,
    mu0: 0.0018,
    muDecay: 0.02,
    muMin: 0.0005,
    solidColor: [178, 184, 196],
    meltColor: [150, 162, 188],
  },
  butter: {
    id: 'butter',
    label: 'Butter',
    // A blend of triglycerides that softens then melts over a range; the
    // latent heat is an effective value (as with cheese).
    rho: 911,
    cSolid: 2000,
    cLiquid: 2100,
    k: 0.2,
    latentHeat: 84_000,
    Tsolidus: 30,
    Tliquidus: 35,
    mu0: 20,
    muDecay: 0.06,
    muMin: 1,
    solidColor: [245, 226, 150],
    meltColor: [250, 214, 120],
  },
  solder: {
    id: 'solder',
    label: 'Solder',
    // Eutectic tin-lead (Sn63/Pb37), which melts sharply near 183 degC; a
    // narrow band keeps the fixed-grid method well-defined. Castable in the
    // steel mould scene (well below steel's melting band).
    rho: 8400,
    cSolid: 180,
    cLiquid: 230,
    k: 50,
    latentHeat: 42_000,
    Tsolidus: 183,
    Tliquidus: 188,
    mu0: 0.002,
    muDecay: 0.02,
    muMin: 0.0008,
    solidColor: [162, 162, 170],
    meltColor: [205, 205, 214],
  },
  toast: {
    id: 'toast',
    label: 'Toast',
    // A dry bread-like substrate: light (mostly air), insulating, and with a
    // "melting" band placed at 400-410 degC - ABOVE the T_MAX=350 heater cap -
    // so it structurally cannot melt or flow at simulation temperatures (the
    // heater clamps material at T_MAX = 350 degC but the latent plateau and
    // enormous viscosity keep toast rigid). meltColor is a darker toasted
    // brown; it is unused in practice because toast stays solid.
    rho: 250,
    cSolid: 2800,
    cLiquid: 2800,
    k: 0.08,
    latentHeat: 2_000_000,
    Tsolidus: 400,
    Tliquidus: 410,
    mu0: 1e8,
    muDecay: 0.001,
    muMin: 1e6,
    solidColor: [222, 184, 122],
    meltColor: [150, 100, 52],
    substrate: true,
  },
  steel: {
    id: 'steel',
    label: 'Steel mould',
    // A rigid, highly conductive wall material for the mould/casting scene. Its
    // melting band (1450-1460 degC) sits far above the T_MAX=350 heater cap, so
    // it never melts or flows in-sim; its high conductivity lets it act as an
    // effective cold (or hot) reservoir wall for solidification demos.
    rho: 7850,
    cSolid: 490,
    cLiquid: 490,
    k: 45,
    latentHeat: 270_000,
    Tsolidus: 1450,
    Tliquidus: 1460,
    mu0: 1e10,
    muDecay: 0.001,
    muMin: 1e8,
    solidColor: [120, 124, 130],
    meltColor: [190, 120, 80],
    substrate: true,
  },
}

/** All material presets in stable declaration order. */
export function listMaterials(): Material[] {
  return Object.values(MATERIALS)
}

/** Materials the UI offers as the meltable subject (everything but substrates). */
export function selectableMaterials(): Material[] {
  return listMaterials().filter((m) => !m.substrate)
}

/**
 * A copy of `base` with selected properties overridden - the pure backing for
 * the interactive material editor (tweak conductivity, latent heat, viscosity,
 * melting band, etc. and see the effect). The base preset is never mutated.
 */
export function withOverrides(base: Material, overrides: Partial<Material>): Material {
  return { ...base, ...overrides }
}
