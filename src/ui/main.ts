/**
 * Browser wiring for the MeltSim bench. Deliberately a thin, untested layer:
 * all physics lives in src/core, all field maths in src/render, all scenario
 * and chart maths in their own unit-tested modules. This file only maps DOM
 * controls onto a Sim instance, blits a chosen field view onto the canvas, and
 * feeds the ledger and stats into the instrument panels.
 */
import { MATERIALS, selectableMaterials, withOverrides, type Material } from '../core/materials.ts'
import { liquidFraction, temperatureFromEnthalpy } from '../core/enthalpy.ts'
import { MASS_EPS, cellMaterial, specificEnthalpy } from '../core/grid.ts'
import { Sim, type ScenePreset, type SimConfig, type SimStats } from '../core/sim.ts'
import { renderField, isotherms, type ViewMode } from '../render/views.ts'
import { TimeSeries, seriesToPolyline, energyFlows } from '../charts/charts.ts'
import {
  scenarioFromJSON,
  scenarioFromQuery,
  scenarioToJSON,
  scenarioToQuery,
  type Scenario,
} from '../scenario/scenario.ts'

const GRID_W = 120
const GRID_H = 72
const DX = 0.01
const POUR_CENTER = 0.5
const POUR_SPAN = 0.26
const CHART_CAP = 200

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing element #${id}`)
  return el as T
}

const stage = $<HTMLCanvasElement>('stage')
const stageCtx = stage.getContext('2d')!
const off = document.createElement('canvas')
off.width = GRID_W
off.height = GRID_H
const offCtx = off.getContext('2d')!
const imageData = offCtx.createImageData(GRID_W, GRID_H)

const SELECTABLE: Material[] = selectableMaterials()

// ---------- state ----------

const state = {
  materialId: 'cheese',
  preset: 'block' as ScenePreset,
  view: 'material' as ViewMode,
  isotherms: false,
  heaterSide: 'bottom' as 'top' | 'bottom' | 'off',
  heaterCenter: 0.5,
  heaterSpan: 0.4,
  powerKw: 25,
  ambient: 22,
  speedExp: 2.1,
  pourTempC: 120,
  pourRate: 6,
  mouldTempC: -20,
  kFactor: 1,
  latentFactor: 1,
  viscFactor: 1,
  running: false,
}

function baseMaterial(): Material {
  return MATERIALS[state.materialId] ?? MATERIALS['cheese']!
}

/** The selected preset material with the live tuning multipliers applied. */
function tunedMaterial(): Material {
  const b = baseMaterial()
  if (state.kFactor === 1 && state.latentFactor === 1 && state.viscFactor === 1) return b
  return withOverrides(b, {
    k: b.k * state.kFactor,
    latentHeat: b.latentHeat * state.latentFactor,
    mu0: b.mu0 * state.viscFactor,
    muMin: b.muMin * state.viscFactor,
  })
}

function speed(): number {
  return Math.round(10 ** state.speedExp)
}

function span(frac: number, center: number): { x0: number; x1: number } {
  const half = (frac * GRID_W) / 2
  const c = center * GRID_W
  // Clamp x0 before widening so a zero-span band at the far edge stays on-grid
  // (mirrors spanToCols in the scenario module so shared links reproduce).
  const x0 = Math.min(GRID_W - 1, Math.round(Math.max(0, c - half)))
  const x1 = Math.min(GRID_W, Math.max(Math.round(Math.min(GRID_W, c + half)), x0 + 1))
  return { x0, x1 }
}

function buildConfig(): SimConfig {
  const mat = tunedMaterial()
  const { x0, x1 } = span(state.heaterSpan, state.heaterCenter)
  const casting = state.preset === 'mould'
  const cfg: SimConfig = {
    width: GRID_W,
    height: GRID_H,
    material: mat,
    dx: DX,
    Tambient: state.ambient,
    initialT: casting ? state.ambient : Math.min(state.ambient, mat.Tsolidus - 5),
    hAmbient: 12,
    heater: {
      x0,
      x1,
      side: state.heaterSide === 'off' ? 'top' : state.heaterSide,
      power: state.powerKw * 1000,
      on: !casting && state.heaterSide !== 'off',
    },
    flowRate: 0.25,
    preset: state.preset,
  }
  if (casting) {
    const s = span(POUR_SPAN, POUR_CENTER)
    cfg.source = {
      x0: s.x0,
      x1: s.x1,
      material: mat,
      T: state.pourTempC,
      massRate: state.pourRate * 0.01,
      on: true,
    }
    cfg.mould = { Twall: state.mouldTempC }
  }
  return cfg
}

let sim = new Sim(buildConfig())

function rebuildSim(): void {
  sim = new Sim(buildConfig())
  tempSeries.clear()
  meltSeries.clear()
  lastSampleT = -Infinity
}

function syncHeater(): void {
  const { x0, x1 } = span(state.heaterSpan, state.heaterCenter)
  sim.cfg.heater.x0 = x0
  sim.cfg.heater.x1 = x1
  if (state.heaterSide !== 'off') sim.cfg.heater.side = state.heaterSide
  sim.cfg.heater.on = state.preset !== 'mould' && state.heaterSide !== 'off'
  sim.cfg.heater.power = state.powerKw * 1000
}

function syncPour(): void {
  if (sim.cfg.source) {
    sim.cfg.source.T = state.pourTempC
    sim.cfg.source.massRate = state.pourRate * 0.01
  }
  if (sim.cfg.mould) sim.cfg.mould.Twall = state.mouldTempC
}

// ---------- rendering ----------

const isoColor = 'rgba(120, 200, 255, 0.75)'
const boilColor = 'rgba(255, 150, 60, 0.8)'

function drawIsotherms(): void {
  const m = baseMaterial()
  const sx = stage.width / GRID_W
  const sy = stage.height / GRID_H
  const meltLevels = [m.Tsolidus, (m.Tsolidus + m.Tliquidus) / 2, m.Tliquidus]
  const stroke = (levels: number[], color: string): void => {
    const segs = isotherms(sim.grid, levels)
    if (segs.length === 0) return
    stageCtx.strokeStyle = color
    stageCtx.lineWidth = 1.4
    stageCtx.beginPath()
    for (const s of segs) {
      stageCtx.moveTo(s.x0 * sx, s.y0 * sy)
      stageCtx.lineTo(s.x1 * sx, s.y1 * sy)
    }
    stageCtx.stroke()
  }
  stageCtx.save()
  stroke(meltLevels, isoColor)
  if (m.Tboil !== undefined) stroke([m.Tboil], boilColor)
  stageCtx.restore()
}

function draw(nowMs: number): void {
  renderField(sim.grid, state.view, {
    out: imageData.data,
    tMin: state.ambient - 5,
    tMax: 350,
  })
  offCtx.putImageData(imageData, 0, 0)
  stageCtx.imageSmoothingEnabled = false
  stageCtx.clearRect(0, 0, stage.width, stage.height)
  stageCtx.drawImage(off, 0, 0, stage.width, stage.height)

  if (state.isotherms) drawIsotherms()

  if (state.preset !== 'mould' && state.heaterSide !== 'off') {
    const sx = stage.width / GRID_W
    const { x0, x1 } = span(state.heaterSpan, state.heaterCenter)
    const y = state.heaterSide === 'top' ? 0 : stage.height - 6
    const pulse = state.running ? 0.75 + 0.25 * Math.sin(nowMs / 300) : 0.45
    stageCtx.save()
    stageCtx.globalAlpha = pulse
    stageCtx.shadowColor = 'rgba(255,140,26,0.9)'
    stageCtx.shadowBlur = 14
    stageCtx.fillStyle = '#ff8c1a'
    stageCtx.fillRect(x0 * sx, y, (x1 - x0) * sx, 6)
    stageCtx.restore()
  }
}

function fmtClock(totalSeconds: number): string {
  const s = Math.floor(totalSeconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function updateReadouts(st: SimStats): void {
  $('ro-clock').textContent = fmtClock(st.simTime)
  $('ro-melt').textContent = `${(st.meltedFraction * 100).toFixed(1)}%`
  $('ro-tmax').textContent = st.totalMass > 0 ? `${st.maxT.toFixed(0)}°C` : '--'
  $('ro-tmin').textContent = st.totalMass > 0 ? `${st.minT.toFixed(0)}°C` : '--'
}

// ---------- instruments: charts + energy budget ----------

const tempSeries = new TimeSeries(CHART_CAP)
const meltSeries = new TimeSeries(CHART_CAP)
let lastSampleT = -Infinity
const chartTemp = $('chart-temp')
const chartMelt = $('chart-melt')

function sampleCharts(st: SimStats): void {
  // Sample on a simulated-time cadence (so faster time-warp doesn't flood the
  // buffer). lastSampleT starts at -Infinity, so the first call always samples.
  const sampleEvery = Math.max(5, speed() * 0.25)
  if (st.simTime - lastSampleT < sampleEvery) return
  lastSampleT = st.simTime
  if (st.totalMass > 0) tempSeries.push(st.simTime, st.maxT)
  meltSeries.push(st.simTime, st.meltedFraction * 100)
}

function renderCharts(st: SimStats): void {
  const tp = tempSeries.points()
  if (tp.length > 1) {
    let lo = Infinity
    let hi = -Infinity
    for (const p of tp) {
      if (p.v < lo) lo = p.v
      if (p.v > hi) hi = p.v
    }
    const pad = Math.max(2, (hi - lo) * 0.08)
    chartTemp.setAttribute(
      'points',
      seriesToPolyline(tp, { w: 100, h: 38 }, { vMin: lo - pad, vMax: hi + pad }),
    )
  }
  const mp = meltSeries.points()
  if (mp.length > 1) {
    chartMelt.setAttribute('points', seriesToPolyline(mp, { w: 100, h: 38 }, { vMin: 0, vMax: 100 }))
  }
  $('chart-temp-hi').textContent = st.totalMass > 0 ? `${st.maxT.toFixed(0)}°C` : '--'
  $('chart-melt-hi').textContent = `${(st.meltedFraction * 100).toFixed(0)}%`
}

const energyBars = $('energy-bars')

function renderEnergy(): void {
  const flows = energyFlows(sim)
  const max = flows.reduce((a, f) => Math.max(a, Math.abs(f.joules)), 1)
  energyBars.replaceChildren()
  for (const f of flows) {
    const row = document.createElement('div')
    row.className = `energy-row is-${f.kind}`
    const label = document.createElement('span')
    label.className = 'energy-label'
    label.textContent = f.label
    const track = document.createElement('span')
    track.className = 'energy-track'
    const fill = document.createElement('span')
    fill.className = 'energy-fill'
    fill.style.width = `${(Math.abs(f.joules) / max) * 100}%`
    track.appendChild(fill)
    const val = document.createElement('span')
    val.className = 'energy-val'
    val.textContent = `${(f.joules / 1000).toFixed(1)} kJ`
    row.append(label, track, val)
    energyBars.appendChild(row)
  }
  if (flows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hint'
    empty.textContent = 'no energy exchanged yet'
    energyBars.appendChild(empty)
  }
}

// ---------- main loop ----------

let last = performance.now()
let energyTick = 0

function frame(now: number): void {
  const realDt = Math.min(0.05, (now - last) / 1000)
  last = now
  if (state.running) sim.step(speed() * realDt)
  const st = sim.stats()
  draw(now)
  updateReadouts(st)
  if (state.running) sampleCharts(st)
  renderCharts(st)
  if (energyTick++ % 12 === 0) renderEnergy()
  requestAnimationFrame(frame)
}

// ---------- control helpers ----------

function wireSeg(id: string, current: () => string, onPick: (v: string) => void): () => void {
  const seg = $(id)
  const refresh = (): void => {
    for (const b of seg.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset['v'] === current()))
    }
  }
  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b?.dataset['v']) return
    onPick(b.dataset['v'])
    refresh()
  })
  refresh()
  return refresh
}

// material segment buttons are built from the presets. Substrate materials
// (toast, steel) are excluded: in two-material scenes the selector picks only
// the material placed ON TOP of / poured into the substrate.
{
  const seg = $('seg-material')
  for (const m of SELECTABLE) {
    const b = document.createElement('button')
    b.dataset['v'] = m.id
    b.textContent = m.label.toLowerCase()
    seg.appendChild(b)
  }
}

const refreshMaterial = wireSeg('seg-material', () => state.materialId, (v) => {
  state.materialId = v
  updateLegend()
  rebuildSim()
})

const refreshScene = wireSeg('seg-scene', () => state.preset, (v) => {
  state.preset = v as ScenePreset
  updateSceneUi()
  rebuildSim()
})

const refreshView = wireSeg('seg-view', () => state.view, (v) => {
  state.view = v as ViewMode
  updateLegend()
})

const refreshSide = wireSeg('seg-side', () => state.heaterSide, (v) => {
  state.heaterSide = v as typeof state.heaterSide
  syncHeater()
})

function wireSlider(inputId: string, outId: string, apply: (raw: number) => string): void {
  const input = $<HTMLInputElement>(inputId)
  const out = $<HTMLOutputElement>(outId)
  const handle = (): void => {
    out.textContent = apply(Number(input.value))
  }
  input.addEventListener('input', handle)
  handle()
}

wireSlider('in-power', 'out-power', (v) => {
  state.powerKw = v
  syncHeater()
  return String(v)
})
wireSlider('in-span', 'out-span', (v) => {
  state.heaterSpan = v / 100
  syncHeater()
  return String(v)
})
wireSlider('in-ambient', 'out-ambient', (v) => {
  state.ambient = v
  sim.cfg.Tambient = v
  return String(v)
})
wireSlider('in-speed', 'out-speed', (v) => {
  state.speedExp = v
  return String(Math.round(10 ** v))
})
wireSlider('in-pour-temp', 'out-pour-temp', (v) => {
  state.pourTempC = v
  syncPour()
  return String(v)
})
wireSlider('in-pour-rate', 'out-pour-rate', (v) => {
  state.pourRate = v
  syncPour()
  return String(v)
})
wireSlider('in-mould-temp', 'out-mould-temp', (v) => {
  state.mouldTempC = v
  syncPour()
  return String(v)
})

// material tuning: rebuild on release (constants bake into the sim state)
function wireTune(inputId: string, outId: string, set: (v: number) => void): void {
  const input = $<HTMLInputElement>(inputId)
  const out = $<HTMLOutputElement>(outId)
  const label = (): void => {
    out.textContent = Number(input.value).toFixed(input.value.includes('.') ? 1 : 0)
  }
  input.addEventListener('input', () => {
    set(Number(input.value))
    label()
  })
  input.addEventListener('change', () => rebuildSim())
  label()
}
wireTune('in-k', 'out-k', (v) => (state.kFactor = v))
wireTune('in-latent', 'out-latent', (v) => (state.latentFactor = v))
wireTune('in-visc', 'out-visc', (v) => (state.viscFactor = v))

const chkIso = $<HTMLInputElement>('chk-iso')
chkIso.addEventListener('change', () => (state.isotherms = chkIso.checked))

$('btn-tune-reset').addEventListener('click', () => {
  state.kFactor = 1
  state.latentFactor = 1
  state.viscFactor = 1
  for (const [id, out] of [
    ['in-k', 'out-k'],
    ['in-latent', 'out-latent'],
    ['in-visc', 'out-visc'],
  ] as const) {
    $<HTMLInputElement>(id).value = '1'
    $(out).textContent = '1.0'
  }
  rebuildSim()
})

// ---------- scene-dependent UI ----------

function updateSceneUi(): void {
  const casting = state.preset === 'mould'
  $('ctl-pour').hidden = !casting
  $('ctl-heater').style.opacity = casting ? '0.45' : '1'
  $('scene-hint').textContent = casting
    ? 'pour is auto-on; adjust pour + mould below, then RUN'
    : 'drag on the window to aim the heater'
}

// ---------- transport ----------

const btnRun = $<HTMLButtonElement>('btn-run')
const stamp = $('stamp')

function setRunning(run: boolean): void {
  state.running = run
  btnRun.setAttribute('aria-pressed', String(run))
  btnRun.textContent = run ? 'PAUSE' : 'RUN'
  stamp.hidden = run
}

btnRun.addEventListener('click', () => setRunning(!state.running))
$('btn-reset').addEventListener('click', () => rebuildSim())
$('btn-snap').addEventListener('click', () => {
  stage.toBlob((blob) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'meltsim-snapshot.png'
    a.click()
    URL.revokeObjectURL(a.href)
  })
})

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return
  if (e.code === 'Space') {
    e.preventDefault()
    setRunning(!state.running)
  } else if (e.key === 'r' || e.key === 'R') {
    rebuildSim()
  } else if (e.key === 'v' || e.key === 'V') {
    const modes: ViewMode[] = ['material', 'temperature', 'energy']
    state.view = modes[(modes.indexOf(state.view) + 1) % modes.length]!
    updateLegend()
    refreshView()
  } else {
    const n = Number(e.key)
    if (n >= 1 && n <= SELECTABLE.length) {
      state.materialId = SELECTABLE[n - 1]!.id
      updateLegend()
      rebuildSim()
      refreshMaterial()
    }
  }
})

// ---------- pointer: aim heater + probe ----------

let aiming = false

function canvasCell(e: PointerEvent): { x: number; y: number } {
  const r = stage.getBoundingClientRect()
  const x = Math.floor(((e.clientX - r.left) / r.width) * GRID_W)
  const y = Math.floor(((e.clientY - r.top) / r.height) * GRID_H)
  return { x: Math.max(0, Math.min(GRID_W - 1, x)), y: Math.max(0, Math.min(GRID_H - 1, y)) }
}

stage.addEventListener('pointerdown', (e) => {
  if (state.preset === 'mould') return
  aiming = true
  stage.setPointerCapture(e.pointerId)
  state.heaterCenter = canvasCell(e).x / GRID_W
  syncHeater()
})
stage.addEventListener('pointerup', () => {
  aiming = false
})
stage.addEventListener('pointermove', (e) => {
  if (aiming) {
    state.heaterCenter = canvasCell(e).x / GRID_W
    syncHeater()
  }
  const { x, y } = canvasCell(e)
  const i = y * GRID_W + x
  const probe = $('ro-probe')
  if (sim.grid.mass[i]! > MASS_EPS) {
    const m = cellMaterial(sim.grid, i)
    const h = specificEnthalpy(sim.grid, i)
    const T = temperatureFromEnthalpy(m, h)
    const phi = liquidFraction(m, h)
    probe.textContent = `${T.toFixed(0)}°C φ${phi.toFixed(2)}`
  } else {
    probe.textContent = '--'
  }
})
stage.addEventListener('pointerleave', () => {
  $('ro-probe').textContent = '--'
})

// ---------- legend ----------

function updateLegend(): void {
  const m = baseMaterial()
  const c = (rgb: readonly [number, number, number]): string => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
  const bar = $('legend-bar')
  if (state.view === 'temperature' || state.view === 'energy') {
    bar.style.background = 'linear-gradient(90deg, #2b4cff, #21d0d0, #ffe14d, #ff3b2f)'
    $('legend-lo').textContent = state.view === 'energy' ? 'low' : 'cold'
    $('legend-hi').textContent = state.view === 'energy' ? 'high' : 'hot'
  } else {
    bar.style.background = `linear-gradient(90deg, ${c(m.solidColor)}, ${c(m.meltColor)})`
    $('legend-lo').textContent = 'solid'
    $('legend-hi').textContent = 'molten'
  }
}

// ---------- scenario save / load / share ----------

function stateToScenario(): Scenario {
  const s: Scenario = {
    materialId: state.materialId,
    preset: state.preset,
    heaterSide: state.heaterSide,
    powerKw: state.powerKw,
    ambient: state.ambient,
    spanPct: Math.round(state.heaterSpan * 100),
    centerPct: Math.round(state.heaterCenter * 100),
    speedExp: state.speedExp,
  }
  if (state.preset === 'mould') {
    s.source = {
      materialId: state.materialId,
      T: state.pourTempC,
      massRate: state.pourRate * 0.01,
      x0Pct: Math.round((POUR_CENTER - POUR_SPAN / 2) * 100),
      x1Pct: Math.round((POUR_CENTER + POUR_SPAN / 2) * 100),
    }
    s.mould = { Twall: state.mouldTempC }
  }
  return s
}

function applyScenario(s: Scenario): void {
  state.materialId = MATERIALS[s.materialId] && !MATERIALS[s.materialId]!.substrate
    ? s.materialId
    : state.materialId
  state.preset = s.preset
  state.heaterSide = s.heaterSide
  state.powerKw = s.powerKw
  state.ambient = s.ambient
  state.heaterSpan = s.spanPct / 100
  state.heaterCenter = s.centerPct / 100
  state.speedExp = s.speedExp
  if (s.source) {
    state.pourTempC = s.source.T
    state.pourRate = Math.round(s.source.massRate * 100)
  }
  if (s.mould) state.mouldTempC = s.mould.Twall
  syncControlsToState()
  updateSceneUi()
  updateLegend()
  rebuildSim()
}

function syncControlsToState(): void {
  const setSlider = (id: string, out: string, value: number, fmt?: (n: number) => string): void => {
    $<HTMLInputElement>(id).value = String(value)
    $(out).textContent = fmt ? fmt(value) : String(value)
  }
  setSlider('in-power', 'out-power', state.powerKw)
  setSlider('in-span', 'out-span', Math.round(state.heaterSpan * 100))
  setSlider('in-ambient', 'out-ambient', state.ambient)
  setSlider('in-speed', 'out-speed', state.speedExp, (v) => String(Math.round(10 ** v)))
  setSlider('in-pour-temp', 'out-pour-temp', state.pourTempC)
  setSlider('in-pour-rate', 'out-pour-rate', state.pourRate)
  setSlider('in-mould-temp', 'out-mould-temp', state.mouldTempC)
  refreshMaterial()
  refreshScene()
  refreshSide()
  refreshView()
}

function flashScenarioMsg(text: string): void {
  const el = $('scenario-msg')
  el.textContent = text
  el.hidden = false
  window.setTimeout(() => (el.hidden = true), 2200)
}

$('btn-link').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?${scenarioToQuery(stateToScenario())}`
  try {
    await navigator.clipboard.writeText(url)
    flashScenarioMsg('link copied to clipboard')
  } catch {
    history.replaceState(null, '', url)
    flashScenarioMsg('link set in address bar')
  }
})

$('btn-save').addEventListener('click', () => {
  const blob = new Blob([scenarioToJSON(stateToScenario())], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'meltsim-scenario.json'
  a.click()
  URL.revokeObjectURL(a.href)
})

const fileInput = $<HTMLInputElement>('file-scenario')
$('btn-load').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (!file) return
  file
    .text()
    .then((txt) => {
      applyScenario(scenarioFromJSON(txt))
      flashScenarioMsg(`loaded ${file.name}`)
    })
    .catch(() => flashScenarioMsg('could not read that scenario file'))
    .finally(() => (fileInput.value = ''))
})

// ---------- URL params: reproducible demo states ----------

function applyUrlParams(): void {
  if (!location.search) return
  const s = scenarioFromQuery(location.search)
  applyScenario(s)
  const warp = Number(new URLSearchParams(location.search).get('warp'))
  if (Number.isFinite(warp) && warp > 0) {
    for (let t = 0; t < Math.min(warp, 86_400); t += 60) sim.step(60)
  }
  if (new URLSearchParams(location.search).has('autorun')) setRunning(true)
}

updateSceneUi()
updateLegend()
setRunning(false)
applyUrlParams()
requestAnimationFrame(frame)
