import { describe, expect, it } from 'vitest'
import { encodeGif } from '../src/gif/gif.ts'

// ---------- helpers: build synthetic RGBA frames ----------

function solidFrame(w: number, h: number, rgb: [number, number, number]): Uint8ClampedArray {
  const f = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    f[i * 4] = rgb[0]
    f[i * 4 + 1] = rgb[1]
    f[i * 4 + 2] = rgb[2]
    f[i * 4 + 3] = 255
  }
  return f
}

/** A frame whose pixels sweep through many distinct colours (> 256). */
function rainbowFrame(w: number, h: number): Uint8ClampedArray {
  const f = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    f[i * 4] = i % 256
    f[i * 4 + 1] = (i * 7) % 256
    f[i * 4 + 2] = (i * 13) % 256
    f[i * 4 + 3] = 255
  }
  return f
}

// ---------- helpers: minimal GIF parser (spec-driven, test-only) ----------

interface ParsedGif {
  width: number
  height: number
  globalPalette: [number, number, number][]
  frames: { left: number; top: number; width: number; height: number; indices: Uint8Array }[]
  delaysCs: number[]
  netscapeLoop: number | null
  trailer: number
}

function parseGif(bytes: Uint8Array): ParsedGif {
  const sig = String.fromCharCode(...bytes.subarray(0, 6))
  if (sig !== 'GIF89a') throw new Error(`bad signature ${sig}`)
  const u16 = (o: number): number => bytes[o]! | (bytes[o + 1]! << 8)
  const width = u16(6)
  const height = u16(8)
  const packed = bytes[10]!
  if (!(packed & 0x80)) throw new Error('expected a global color table')
  const gctLen = 2 << (packed & 0x07)
  let p = 13
  const globalPalette: [number, number, number][] = []
  for (let i = 0; i < gctLen; i++, p += 3) {
    globalPalette.push([bytes[p]!, bytes[p + 1]!, bytes[p + 2]!])
  }

  const frames: ParsedGif['frames'] = []
  const delaysCs: number[] = []
  let netscapeLoop: number | null = null
  let pendingDelay = 0

  const skipSubBlocks = (): Uint8Array => {
    const chunks: number[] = []
    while (bytes[p]! !== 0) {
      const len = bytes[p]!
      for (let i = 0; i < len; i++) chunks.push(bytes[p + 1 + i]!)
      p += len + 1
    }
    p++ // block terminator
    return new Uint8Array(chunks)
  }

  while (p < bytes.length) {
    const b = bytes[p]!
    if (b === 0x3b) return { width, height, globalPalette, frames, delaysCs, netscapeLoop, trailer: b }
    if (b === 0x21) {
      const label = bytes[p + 1]!
      p += 2
      if (label === 0xf9) {
        // graphic control: single 4-byte sub-block
        pendingDelay = u16(p + 2)
        p += bytes[p]! + 1
        if (bytes[p]! !== 0) throw new Error('GCE missing terminator')
        p++
      } else if (label === 0xff) {
        const len = bytes[p]!
        const app = String.fromCharCode(...bytes.subarray(p + 1, p + 1 + len))
        p += len + 1
        const data = skipSubBlocks()
        if (app === 'NETSCAPE2.0' && data[0] === 1) {
          netscapeLoop = data[1]! | (data[2]! << 8)
        }
      } else {
        skipSubBlocks()
      }
    } else if (b === 0x2c) {
      const left = u16(p + 1)
      const top = u16(p + 3)
      const fw = u16(p + 5)
      const fh = u16(p + 7)
      const fPacked = bytes[p + 9]!
      if (fPacked & 0x80) throw new Error('local color tables not expected')
      p += 10
      const minCodeSize = bytes[p]!
      p++
      const data = skipSubBlocks()
      frames.push({ left, top, width: fw, height: fh, indices: lzwDecode(data, minCodeSize) })
      delaysCs.push(pendingDelay)
    } else {
      throw new Error(`unexpected block 0x${b.toString(16)} at ${p}`)
    }
  }
  throw new Error('missing trailer')
}

/** Reference GIF-LZW decoder (LSB-first bit order, growing code size). */
function lzwDecode(data: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  let codeSize = minCodeSize + 1
  let dict: number[][] = []
  const resetDict = (): void => {
    dict = []
    for (let i = 0; i < clear; i++) dict.push([i])
    dict.push([], []) // clear, eoi placeholders
    codeSize = minCodeSize + 1
  }
  resetDict()
  const out: number[] = []
  let acc = 0
  let bits = 0
  let pos = 0
  let prev: number | null = null
  for (;;) {
    while (bits < codeSize) {
      if (pos >= data.length) throw new Error('ran out of LZW data before EOI')
      acc |= data[pos++]! << bits
      bits += 8
    }
    const code = acc & ((1 << codeSize) - 1)
    acc >>= codeSize
    bits -= codeSize
    if (code === clear) {
      resetDict()
      prev = null
      continue
    }
    if (code === eoi) break
    let entry: number[]
    if (code < dict.length && (code < clear || dict[code]!.length > 0)) {
      entry = dict[code]!
    } else if (code === dict.length && prev !== null) {
      entry = [...dict[prev]!, dict[prev]![0]!]
    } else {
      throw new Error(`bad LZW code ${code}`)
    }
    out.push(...entry)
    if (prev !== null) {
      dict.push([...dict[prev]!, entry[0]!])
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++
    }
    prev = code
  }
  return new Uint8Array(out)
}

// ---------- tests ----------

const RED: [number, number, number] = [255, 0, 0]
const GREEN: [number, number, number] = [0, 200, 0]
const BLUE: [number, number, number] = [0, 0, 255]

describe('encodeGif: container format', () => {
  const gif = encodeGif(7, 5, [solidFrame(7, 5, RED), solidFrame(7, 5, GREEN)])

  it('starts with the GIF89a signature', () => {
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a')
  })

  it('encodes the logical screen dimensions little-endian', () => {
    expect(gif[6]! | (gif[7]! << 8)).toBe(7)
    expect(gif[8]! | (gif[9]! << 8)).toBe(5)
  })

  it('ends with the 0x3B trailer', () => {
    expect(gif[gif.length - 1]).toBe(0x3b)
  })

  it('declares a global color table sized to a power of two', () => {
    const parsed = parseGif(gif)
    expect(parsed.globalPalette.length).toBeGreaterThanOrEqual(2)
    expect(Math.log2(parsed.globalPalette.length) % 1).toBe(0)
    expect(parsed.globalPalette.length).toBeLessThanOrEqual(256)
  })

  it('contains one image block per input frame', () => {
    expect(parseGif(gif).frames).toHaveLength(2)
  })

  it('loops forever via the NETSCAPE2.0 application extension by default', () => {
    expect(parseGif(gif).netscapeLoop).toBe(0)
  })

  it('can omit looping', () => {
    const once = encodeGif(4, 4, [solidFrame(4, 4, RED)], { loop: false })
    expect(parseGif(once).netscapeLoop).toBeNull()
  })

  it('writes the requested frame delay in centiseconds (default 12)', () => {
    expect(parseGif(gif).delaysCs).toEqual([12, 12])
    const slow = encodeGif(4, 4, [solidFrame(4, 4, RED)], { delayCs: 25 })
    expect(parseGif(slow).delaysCs).toEqual([25])
  })

  it('gives every frame full logical-screen bounds at origin', () => {
    for (const f of parseGif(gif).frames) {
      expect([f.left, f.top, f.width, f.height]).toEqual([0, 0, 7, 5])
    }
  })
})

describe('encodeGif: pixel round-trip through a reference LZW decoder', () => {
  it('reproduces a solid frame exactly', () => {
    const gif = encodeGif(9, 4, [solidFrame(9, 4, BLUE)])
    const { globalPalette, frames } = parseGif(gif)
    expect(frames[0]!.indices).toHaveLength(9 * 4)
    for (const idx of frames[0]!.indices) {
      expect(globalPalette[idx]).toEqual(BLUE)
    }
  })

  it('reproduces a multi-colour frame exactly when few colours are used', () => {
    const w = 16
    const h = 16
    const frame = new Uint8ClampedArray(w * h * 4)
    const colors: [number, number, number][] = [RED, GREEN, BLUE, [10, 20, 30]]
    for (let i = 0; i < w * h; i++) {
      const c = colors[i % 4]!
      frame[i * 4] = c[0]
      frame[i * 4 + 1] = c[1]
      frame[i * 4 + 2] = c[2]
      frame[i * 4 + 3] = 255
    }
    const { globalPalette, frames } = parseGif(encodeGif(w, h, [frame]))
    for (let i = 0; i < w * h; i++) {
      expect(globalPalette[frames[0]!.indices[i]!]).toEqual(colors[i % 4])
    }
  })

  it('keeps frames independent: each decodes to its own colour', () => {
    const gif = encodeGif(6, 6, [solidFrame(6, 6, RED), solidFrame(6, 6, GREEN), solidFrame(6, 6, BLUE)])
    const { globalPalette, frames } = parseGif(gif)
    expect(frames).toHaveLength(3)
    const expected = [RED, GREEN, BLUE]
    frames.forEach((f, fi) => {
      for (const idx of f.indices) expect(globalPalette[idx]).toEqual(expected[fi])
    })
  })

  it('survives a noisy frame large enough to force a 4096-code dictionary reset', () => {
    // Deterministic pseudo-random noise over 16 colours: poor compressibility
    // means the LZW dictionary exhausts its 4096 codes and must emit a CLEAR
    // and rebuild mid-stream (256x128 = 32768 pixels >> 4096 codes).
    const w = 256
    const h = 128
    const frame = new Uint8ClampedArray(w * h * 4)
    let seed = 42
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed >> 16
    }
    const picks: number[] = []
    for (let i = 0; i < w * h; i++) {
      const c = rand() % 16
      picks.push(c)
      frame[i * 4] = c * 16
      frame[i * 4 + 1] = 255 - c * 16
      frame[i * 4 + 2] = (c * 37) % 256
      frame[i * 4 + 3] = 255
    }
    const { globalPalette, frames } = parseGif(encodeGif(w, h, [frame]))
    expect(frames[0]!.indices).toHaveLength(w * h)
    for (let i = 0; i < w * h; i++) {
      const c = picks[i]!
      expect(globalPalette[frames[0]!.indices[i]!]).toEqual([c * 16, 255 - c * 16, (c * 37) % 256])
    }
  })

  it('survives an image long enough to exercise LZW code-size growth', () => {
    // 64x64 with a diagonal 2-colour pattern generates plenty of dictionary
    // entries, pushing the code size past its initial width.
    const w = 64
    const h = 64
    const frame = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const on = (x + y * 3) % 7 < 3
        const i = (y * w + x) * 4
        frame[i] = on ? 255 : 0
        frame[i + 1] = on ? 0 : 200
        frame[i + 2] = 0
        frame[i + 3] = 255
      }
    }
    const { globalPalette, frames } = parseGif(encodeGif(w, h, [frame]))
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const on = (x + y * 3) % 7 < 3
        const got = globalPalette[frames[0]!.indices[y * w + x]!]
        expect(got).toEqual(on ? [255, 0, 0] : [0, 200, 0])
      }
    }
  })
})

describe('encodeGif: quantization of rich-colour frames', () => {
  it('caps the palette at 256 entries and keeps every pixel close to its source', () => {
    const w = 64
    const h = 64
    const frame = rainbowFrame(w, h)
    const { globalPalette, frames } = parseGif(encodeGif(w, h, [frame]))
    expect(globalPalette.length).toBeLessThanOrEqual(256)
    let maxErr = 0
    for (let i = 0; i < w * h; i++) {
      const c = globalPalette[frames[0]!.indices[i]!]!
      maxErr = Math.max(
        maxErr,
        Math.abs(c[0] - frame[i * 4]!),
        Math.abs(c[1] - frame[i * 4 + 1]!),
        Math.abs(c[2] - frame[i * 4 + 2]!),
      )
    }
    // simple uniform quantization: error bounded by the bucket width
    expect(maxErr).toBeLessThanOrEqual(32)
  })
})

describe('encodeGif: input validation', () => {
  it('rejects an empty frame list', () => {
    expect(() => encodeGif(4, 4, [])).toThrow()
  })

  it('rejects frames whose byte length does not match the dimensions', () => {
    expect(() => encodeGif(4, 4, [new Uint8ClampedArray(3)])).toThrow()
  })

  it('rejects dimensions outside the u16 range', () => {
    expect(() => encodeGif(0, 4, [new Uint8ClampedArray(0)])).toThrow()
    expect(() => encodeGif(70000, 1, [new Uint8ClampedArray(70000 * 4)])).toThrow()
  })
})
