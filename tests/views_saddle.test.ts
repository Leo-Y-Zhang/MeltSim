import { describe, expect, it } from 'vitest'
import { MATERIALS } from '../src/core/materials.ts'
import { enthalpyFromTemperature } from '../src/core/enthalpy.ts'
import { createGrid } from '../src/core/grid.ts'
import { isotherms } from '../src/render/views.ts'

const wax = MATERIALS['wax']!

/**
 * A single 2x2 block whose four corner temperatures are set explicitly, so the
 * marching-squares saddle branch (all four edges crossing) can be pinned down.
 * Corner args are clockwise from the top-left: TL, TR, BR, BL.
 */
function saddleGrid(tl: number, tr: number, br: number, bl: number): ReturnType<typeof createGrid> {
  const g = createGrid(2, 2, [wax])
  const set = (x: number, y: number, T: number): void => {
    const i = y * 2 + x
    g.mass[i] = 1
    g.energy[i] = enthalpyFromTemperature(wax, T)
  }
  set(0, 0, tl)
  set(1, 0, tr)
  set(1, 1, br)
  set(0, 1, bl)
  return g
}

describe('isotherms saddle resolution (four-crossing block)', () => {
  it('centre >= level pairs top-right and bottom-left (isolating the low corners)', () => {
    // TL=BR=100, TR=BL=10 -> block-centre average 55 >= 50
    const segs = isotherms(saddleGrid(100, 10, 100, 10), [50])
    expect(segs).toHaveLength(2)
    // segment 0: top edge (y=0) to right edge (x=1)
    expect(segs[0]!.y0).toBe(0)
    expect(segs[0]!.x1).toBe(1)
    // segment 1: bottom edge (y=1) to left edge (x=0)
    expect(segs[1]!.y0).toBe(1)
    expect(segs[1]!.x1).toBe(0)
  })

  it('centre < level pairs the other diagonal (top-left and right-bottom)', () => {
    // TL=BR=0, TR=BL=90 -> block-centre average 45 < 50
    const segs = isotherms(saddleGrid(0, 90, 0, 90), [50])
    expect(segs).toHaveLength(2)
    // segment 0: top edge (y=0) to left edge (x=0)
    expect(segs[0]!.y0).toBe(0)
    expect(segs[0]!.x1).toBe(0)
    // segment 1: right edge (x=1) to bottom edge (y=1)
    expect(segs[1]!.x0).toBe(1)
    expect(segs[1]!.y1).toBe(1)
  })

  it('a non-saddle block (two crossings) yields a single segment', () => {
    // hot top row, cold bottom row -> one horizontal crossing, no saddle
    const segs = isotherms(saddleGrid(100, 100, 0, 0), [50])
    expect(segs).toHaveLength(1)
  })
})
