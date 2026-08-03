/**
 * Minimal dependency-free PNG encoder (8-bit RGBA, filter 0, one IDAT).
 * The DEFLATE implementation is injected so this module stays platform
 * agnostic: node callers pass node:zlib's deflateSync, and no compression
 * code needs to ship to the browser (which uses canvas.toBlob instead).
 */

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

/** Standard CRC-32 (as used by PNG chunks). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function u32be(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const out = new Uint8Array(4 + body.length + 4)
  out.set(u32be(data.length), 0)
  out.set(body, 4)
  out.set(u32be(crc32(body)), 4 + body.length)
  return out
}

/**
 * Encode an RGBA buffer as a PNG file.
 * `deflate` must be a raw zlib-format DEFLATE function (e.g. node:zlib deflateSync).
 */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  deflate: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba length ${rgba.length} does not match ${width}x${height}`)
  }
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdr = new Uint8Array(13)
  ihdr.set(u32be(width), 0)
  ihdr.set(u32be(height), 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // no interlace

  const stride = width * 4
  const raw = new Uint8Array(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0 // filter type 0 (None)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1)
  }

  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', deflate(raw)), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((s, p) => s + p.length, 0)
  const png = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    png.set(p, off)
    off += p.length
  }
  return png
}
