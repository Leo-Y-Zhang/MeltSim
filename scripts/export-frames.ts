/**
 * Headless demo export: runs three deterministic scenes and writes PNG
 * frame strips to docs/media/. Run with: node scripts/export-frames.ts
 * (Node 23.6+ executes TypeScript directly via type stripping.)
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { MATERIALS } from '../src/core/materials.ts'
import { Sim, type SimConfig } from '../src/core/sim.ts'
import { renderToRGBA } from '../src/render/renderer.ts'
import { renderField, type ViewMode } from '../src/render/views.ts'
import { encodePng } from '../src/png/png.ts'
import { encodeGif } from '../src/gif/gif.ts'

const W = 96
const H = 64
const SCALE = 6
const GAP = 4

interface Scene {
  name: string
  cfg: SimConfig
  /** Simulated seconds at which to capture frames. */
  captureAt: number[]
  /** Simulated seconds advanced per step() call. */
  stride: number
  /** Field view to render (defaults to the material/phase view). */
  view?: ViewMode
  /** For pour scenes: simulated second at which to stop the source. */
  sourceOffAt?: number
}

const scenes: Scene[] = [
  {
    name: 'cheese-on-toast',
    cfg: {
      width: W,
      height: H,
      material: MATERIALS['cheese']!,
      dx: 0.01,
      Tambient: 25,
      initialT: 22,
      hAmbient: 8,
      heater: { x0: 24, x1: 72, side: 'top', power: 30_000, on: true },
      flowRate: 0.25,
      preset: 'toast',
    },
    captureAt: [0, 1800, 5400, 10800],
    stride: 15,
  },
  {
    name: 'cheese-hotplate',
    cfg: {
      width: W,
      height: H,
      material: MATERIALS['cheese']!,
      dx: 0.01,
      Tambient: 25,
      initialT: 22,
      hAmbient: 8,
      heater: { x0: 0, x1: 96, side: 'bottom', power: 25_000, on: true },
      flowRate: 0.25,
      preset: 'block',
    },
    captureAt: [0, 1800, 7200, 14400],
    stride: 15,
  },
  {
    name: 'chocolate-mound',
    cfg: {
      width: W,
      height: H,
      material: MATERIALS['chocolate']!,
      dx: 0.01,
      Tambient: 22,
      initialT: 22,
      hAmbient: 8,
      heater: { x0: 0, x1: 96, side: 'bottom', power: 10_000, on: true },
      flowRate: 0.25,
      preset: 'mound',
    },
    captureAt: [0, 1800, 5400, 14400],
    stride: 20,
  },
  {
    name: 'ice-room',
    cfg: {
      width: W,
      height: H,
      material: MATERIALS['ice']!,
      dx: 0.01,
      Tambient: 40,
      initialT: -15,
      hAmbient: 30,
      heater: { x0: 0, x1: 0, side: 'top', power: 0, on: false },
      flowRate: 0.25,
      preset: 'mound',
    },
    captureAt: [0, 7200, 21600, 43200],
    stride: 60,
  },
  {
    // Solidification: pour molten solder into a cool steel mould and let it set.
    name: 'solder-cast',
    cfg: {
      width: W,
      height: H,
      material: MATERIALS['solder']!,
      dx: 0.01,
      Tambient: 22,
      initialT: 22,
      hAmbient: 6,
      heater: { x0: 0, x1: 0, side: 'top', power: 0, on: false },
      flowRate: 0.3,
      preset: 'mould',
      mould: { Twall: 22 },
      source: { x0: 34, x1: 62, material: MATERIALS['solder']!, T: 230, massRate: 0.09, on: true },
    },
    captureAt: [60, 200, 600, 1400],
    stride: 3,
    sourceOffAt: 220,
  },
  {
    // Boiling: a hot water block under a strong hotplate loses mass to vapour.
    name: 'water-boil',
    cfg: {
      width: W,
      height: H,
      material: MATERIALS['ice']!,
      dx: 0.01,
      Tambient: 30,
      initialT: 82,
      hAmbient: 4,
      heater: { x0: 10, x1: 86, side: 'bottom', power: 45_000, on: true },
      flowRate: 0.3,
      preset: 'block',
    },
    captureAt: [0, 400, 1000, 2000],
    stride: 5,
  },
  {
    // Gallium (melts at ~30 C) on a warm hotplate: it slumps into a silvery
    // puddle far below the melting point of an ordinary metal.
    name: 'gallium-melt',
    cfg: {
      width: W,
      height: H,
      material: MATERIALS['gallium']!,
      dx: 0.01,
      Tambient: 22,
      initialT: 18,
      hAmbient: 6,
      heater: { x0: 6, x1: 90, side: 'bottom', power: 10_000, on: true },
      flowRate: 0.3,
      preset: 'block',
    },
    captureAt: [0, 600, 1800, 3600],
    stride: 6,
  },
]

function upscale(src: Uint8ClampedArray, w: number, h: number, s: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * s * h * s * 4)
  for (let y = 0; y < h * s; y++) {
    for (let x = 0; x < w * s; x++) {
      const si = ((y / s) | 0) * w + ((x / s) | 0)
      const di = y * w * s + x
      out[di * 4] = src[si * 4]!
      out[di * 4 + 1] = src[si * 4 + 1]!
      out[di * 4 + 2] = src[si * 4 + 2]!
      out[di * 4 + 3] = 255
    }
  }
  return out
}

/** Lay frames out horizontally with a dark gap between them. */
function strip(frames: Uint8ClampedArray[], fw: number, fh: number): {
  buf: Uint8ClampedArray
  width: number
  height: number
} {
  const width = frames.length * fw + (frames.length - 1) * GAP
  const buf = new Uint8ClampedArray(width * fh * 4)
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255
  frames.forEach((f, fi) => {
    const x0 = fi * (fw + GAP)
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const di = (y * width + x0 + x) * 4
        const si = (y * fw + x) * 4
        buf[di] = f[si]!
        buf[di + 1] = f[si + 1]!
        buf[di + 2] = f[si + 2]!
      }
    }
  })
  return { buf, width, height: fh }
}

mkdirSync('docs/media', { recursive: true })
const deflate = (d: Uint8Array): Uint8Array => new Uint8Array(deflateSync(d))

for (const scene of scenes) {
  const sim = new Sim(scene.cfg)
  const render = (g: typeof sim.grid): Uint8ClampedArray =>
    scene.view ? renderField(g, scene.view) : renderToRGBA(g)
  const frames: Uint8ClampedArray[] = []
  for (const t of scene.captureAt) {
    while (sim.simTime < t - 1e-9) {
      if (scene.sourceOffAt !== undefined && sim.cfg.source && sim.simTime >= scene.sourceOffAt) {
        sim.cfg.source.on = false
      }
      sim.step(scene.stride)
    }
    frames.push(upscale(render(sim.grid), W, H, SCALE))
    const s = sim.stats()
    console.log(
      `${scene.name} t=${sim.simTime}s melted=${(s.meltedFraction * 100).toFixed(1)}% ` +
        `Tmin=${s.minT.toFixed(1)} Tmax=${s.maxT.toFixed(1)}`,
    )
  }
  const { buf, width, height } = strip(frames, W * SCALE, H * SCALE)
  const png = encodePng(width, height, buf, deflate)
  writeFileSync(`docs/media/${scene.name}.png`, png)
  console.log(`wrote docs/media/${scene.name}.png (${width}x${height})`)
}

// Animated README hero: the cheese-on-toast scene as a looping GIF, rendered
// by the same physics + renderer + hand-rolled GIF89a encoder (src/gif).
{
  const scene = scenes[0]!
  const sim = new Sim(scene.cfg)
  const frames: Uint8ClampedArray[] = []
  const GIF_FRAMES = 21
  const GIF_SPAN = 10_800 // 3 simulated hours
  for (let f = 0; f < GIF_FRAMES; f++) {
    const t = (GIF_SPAN / (GIF_FRAMES - 1)) * f
    while (sim.simTime < t - 1e-9) sim.step(scene.stride)
    frames.push(upscale(renderToRGBA(sim.grid), W, H, SCALE))
  }
  const gif = encodeGif(W * SCALE, H * SCALE, frames, { delayCs: 12 })
  writeFileSync('docs/media/cheese-on-toast.gif', gif)
  console.log(
    `wrote docs/media/cheese-on-toast.gif (${W * SCALE}x${H * SCALE}, ` +
      `${GIF_FRAMES} frames, ${(gif.length / 1024).toFixed(0)} KiB)`,
  )
}

// The four field views of one partially-melted frame, side by side, so the
// README can show what temperature / phase / energy views reveal.
{
  const sim = new Sim({
    width: W,
    height: H,
    material: MATERIALS['chocolate']!,
    dx: 0.01,
    Tambient: 22,
    initialT: 20,
    hAmbient: 8,
    heater: { x0: 20, x1: 76, side: 'bottom', power: 14_000, on: true },
    flowRate: 0.25,
    preset: 'mound',
  })
  while (sim.simTime < 2400) sim.step(15)
  const modes: ViewMode[] = ['material', 'temperature', 'phase', 'energy']
  const frames = modes.map((mode) => upscale(renderField(sim.grid, mode), W, H, SCALE))
  const { buf, width, height } = strip(frames, W * SCALE, H * SCALE)
  writeFileSync('docs/media/field-views.png', encodePng(width, height, buf, deflate))
  console.log(`wrote docs/media/field-views.png (${width}x${height}, views: ${modes.join(' / ')})`)
}
console.log('done')
