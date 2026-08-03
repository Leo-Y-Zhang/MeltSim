/**
 * Dependency-free GIF89a encoder (animated, global palette, LZW).
 *
 * Scope: exactly what the headless README-media exporter needs —
 *  - one GLOBAL 256-colour table shared by all frames, built by simple
 *    uniform quantization: if the frames use <= 256 exact colours the
 *    palette is exact; otherwise the channel precision is reduced one bit
 *    at a time (8 -> 7 -> 6 ... bits) until the colour buckets fit, and
 *    each bucket's palette entry is the mean of the pixels in it. This is
 *    deliberately simpler than median-cut; worst-case per-channel error is
 *    half a bucket (asserted in tests).
 *  - full-frame images (no inter-frame delta), no transparency, optional
 *    infinite looping via the NETSCAPE2.0 application extension.
 *  - standard GIF-flavoured LZW with LSB-first bit packing, growing code
 *    sizes and dictionary reset at 4096 codes.
 *
 * The format details follow the GIF89a specification; the byte layout is
 * verified in tests/gif.test.ts by an independent parser + LZW decoder.
 */

export interface GifOptions {
  /** Per-frame delay in hundredths of a second (default 12 = 120 ms). */
  delayCs?: number
  /** Loop forever via NETSCAPE2.0 (default true). */
  loop?: boolean
}

interface Palette {
  /** RGB triples, length <= 256. */
  colors: number[][]
  /** Bits of per-channel precision kept (8 = exact). */
  bits: number
  /** bucket key -> palette index */
  lookup: Map<number, number>
}

function bucketKey(r: number, g: number, b: number, shift: number): number {
  return ((r >> shift) << 16) | ((g >> shift) << 8) | (b >> shift)
}

/** Uniform-quantization palette over all frames (<= 256 entries). */
function buildPalette(frames: readonly Uint8ClampedArray[]): Palette {
  for (let shift = 0; shift <= 6; shift++) {
    const sums = new Map<number, [number, number, number, number]>()
    let overflow = false
    for (const f of frames) {
      for (let i = 0; i < f.length; i += 4) {
        const key = bucketKey(f[i]!, f[i + 1]!, f[i + 2]!, shift)
        const s = sums.get(key)
        if (s) {
          s[0] += f[i]!
          s[1] += f[i + 1]!
          s[2] += f[i + 2]!
          s[3]++
        } else {
          if (sums.size === 256) {
            overflow = true
            break
          }
          sums.set(key, [f[i]!, f[i + 1]!, f[i + 2]!, 1])
        }
      }
      if (overflow) break
    }
    if (overflow) continue
    const colors: number[][] = []
    const lookup = new Map<number, number>()
    for (const [key, [r, g, b, n]] of sums) {
      lookup.set(key, colors.length)
      colors.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
    }
    return { colors, bits: 8 - shift, lookup }
  }
  /* v8 ignore next: shift 6 yields <= 64 buckets, so this is unreachable */
  throw new Error('palette quantization failed')
}

/** Map one RGBA frame to palette indices. */
function indexFrame(frame: Uint8ClampedArray, pal: Palette): Uint8Array {
  const shift = 8 - pal.bits
  const out = new Uint8Array(frame.length / 4)
  for (let i = 0; i < out.length; i++) {
    const key = bucketKey(frame[i * 4]!, frame[i * 4 + 1]!, frame[i * 4 + 2]!, shift)
    out[i] = pal.lookup.get(key)!
  }
  return out
}

/** GIF-flavoured LZW: index stream -> code stream bytes (LSB-first). */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const out: number[] = []
  let acc = 0
  let accBits = 0
  let codeSize = minCodeSize + 1
  const emit = (code: number): void => {
    acc |= code << accBits
    accBits += codeSize
    while (accBits >= 8) {
      out.push(acc & 0xff)
      acc >>= 8
      accBits -= 8
    }
  }
  let table = new Map<number, number>()
  let nextCode = eoi + 1
  emit(clear)
  let prefix = indices[0]!
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!
    const key = (prefix << 8) | k
    const hit = table.get(key)
    if (hit !== undefined) {
      prefix = hit
      continue
    }
    emit(prefix)
    if (nextCode === 4096) {
      emit(clear)
      table = new Map()
      nextCode = eoi + 1
      codeSize = minCodeSize + 1
    } else {
      if (nextCode === 1 << codeSize) codeSize++
      table.set(key, nextCode++)
    }
    prefix = k
  }
  emit(prefix)
  emit(eoi)
  if (accBits > 0) out.push(acc & 0xff)
  return new Uint8Array(out)
}

/** Encode RGBA frames (w*h*4 each, alpha ignored) into an animated GIF89a. */
export function encodeGif(
  width: number,
  height: number,
  frames: readonly Uint8ClampedArray[],
  opts: GifOptions = {},
): Uint8Array {
  if (frames.length === 0) throw new Error('encodeGif needs at least one frame')
  if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
    throw new Error(`dimensions ${width}x${height} outside the GIF u16 range`)
  }
  for (const f of frames) {
    if (f.length !== width * height * 4) {
      throw new Error(`frame has ${f.length} bytes, expected ${width * height * 4}`)
    }
  }
  const delayCs = opts.delayCs ?? 12
  const loop = opts.loop ?? true

  const pal = buildPalette(frames)
  // bits needed to index the palette; GIF's LZW minimum code size is >= 2
  const indexBits = Math.max(2, Math.ceil(Math.log2(Math.max(pal.colors.length, 2))))
  const gctSize = 1 << indexBits

  const bytes: number[] = []
  const pushU16 = (v: number): void => {
    bytes.push(v & 0xff, (v >> 8) & 0xff)
  }
  const pushStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i))
  }

  // header + logical screen descriptor
  pushStr('GIF89a')
  pushU16(width)
  pushU16(height)
  bytes.push(0x80 | 0x70 | (indexBits - 1)) // GCT present, 8-bit colour resolution
  bytes.push(0, 0) // background index, pixel aspect ratio

  // global color table (padded to a power of two)
  for (let i = 0; i < gctSize; i++) {
    const c = pal.colors[i] ?? [0, 0, 0]
    bytes.push(c[0]!, c[1]!, c[2]!)
  }

  // NETSCAPE2.0 looping extension (loop count 0 = forever)
  if (loop) {
    bytes.push(0x21, 0xff, 0x0b)
    pushStr('NETSCAPE2.0')
    bytes.push(0x03, 0x01)
    pushU16(0)
    bytes.push(0x00)
  }

  for (const frame of frames) {
    // graphic control extension: delay only (no transparency, no disposal)
    bytes.push(0x21, 0xf9, 0x04, 0x00)
    pushU16(delayCs)
    bytes.push(0x00, 0x00)
    // image descriptor: full logical screen, no local palette
    bytes.push(0x2c)
    pushU16(0)
    pushU16(0)
    pushU16(width)
    pushU16(height)
    bytes.push(0x00)
    // LZW-compressed indices in <=255-byte sub-blocks
    bytes.push(indexBits)
    const data = lzwEncode(indexFrame(frame, pal), indexBits)
    for (let o = 0; o < data.length; o += 255) {
      const n = Math.min(255, data.length - o)
      bytes.push(n)
      for (let i = 0; i < n; i++) bytes.push(data[o + i]!)
    }
    bytes.push(0x00) // block terminator
  }

  bytes.push(0x3b) // trailer
  return new Uint8Array(bytes)
}
