import { describe, expect, it } from 'vitest'
import { deflateSync, inflateSync } from 'node:zlib'
import { crc32, encodePng } from '../src/png/png.ts'

const deflate = (d: Uint8Array): Uint8Array => new Uint8Array(deflateSync(d))

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0
}

function rgba(w: number, h: number): Uint8ClampedArray {
  const b = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < b.length; i++) b[i] = (i * 37) % 256
  return b
}

describe('crc32', () => {
  it('matches the known CRC of the IEND chunk type', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082)
  })

  it('matches the known CRC of the empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('encodePng', () => {
  it('starts with the PNG signature', () => {
    const png = encodePng(3, 2, rgba(3, 2), deflate)
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })

  it('encodes width and height big-endian in IHDR', () => {
    const png = encodePng(640, 480, rgba(640, 480), deflate)
    // signature(8) + length(4) + "IHDR"(4) => data at 16
    expect(readU32(png, 16)).toBe(640)
    expect(readU32(png, 20)).toBe(480)
    expect(png[24]).toBe(8) // bit depth
    expect(png[25]).toBe(6) // colour type RGBA
  })

  it('ends with a valid IEND chunk', () => {
    const png = encodePng(2, 2, rgba(2, 2), deflate)
    const tail = png.slice(png.length - 12)
    expect(readU32(tail, 0)).toBe(0)
    expect(new TextDecoder().decode(tail.slice(4, 8))).toBe('IEND')
    expect(readU32(tail, 8)).toBe(0xae426082)
  })

  it('stores scanlines (filter 0) recoverable by inflating IDAT', () => {
    const w = 4
    const h = 3
    const src = rgba(w, h)
    const png = encodePng(w, h, src, deflate)
    // find IDAT chunk
    let off = 8
    let idat: Uint8Array | null = null
    while (off < png.length) {
      const len = readU32(png, off)
      const type = new TextDecoder().decode(png.slice(off + 4, off + 8))
      if (type === 'IDAT') {
        idat = png.slice(off + 8, off + 8 + len)
        break
      }
      off += 12 + len
    }
    expect(idat).not.toBeNull()
    const raw = new Uint8Array(inflateSync(idat!))
    expect(raw.length).toBe(h * (1 + w * 4))
    for (let y = 0; y < h; y++) {
      expect(raw[y * (1 + w * 4)]).toBe(0) // filter byte
      for (let i = 0; i < w * 4; i++) {
        expect(raw[y * (1 + w * 4) + 1 + i]).toBe(src[y * w * 4 + i])
      }
    }
  })

  it('has a correct CRC on every chunk', () => {
    const png = encodePng(5, 5, rgba(5, 5), deflate)
    let off = 8
    while (off < png.length) {
      const len = readU32(png, off)
      const typeAndData = png.slice(off + 4, off + 8 + len)
      expect(readU32(png, off + 8 + len)).toBe(crc32(typeAndData))
      off += 12 + len
    }
  })
})
