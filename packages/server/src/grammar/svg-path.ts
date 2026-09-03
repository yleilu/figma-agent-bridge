// svg-path.ts — the SVG commands Figma will not take, rewritten into the ones
// it will (B77).
//
// `grammar.md` promises that "data copied straight out of an SVG file lands as
// written". Figma's own converter does not honour that: `H`, `V` and `A` are
// refused outright — `path(NONE,"M 4 4 H 10 V 10 H 4 Z")` came back as
// *"vectorPaths rejected by Figma: in set_vectorPaths: Failed to convert path.
// Invalid command at H"* — and the node lands with no geometry at all. On the
// 2026-08-30 build that cost 5 of 12 icons plus every chain glyph a hand
// rewrite: `H`/`V` expanded to `L` by hand, circles and rounded corners
// re-expressed as cubic Béziers with the kappa constant.
//
// WHY NORMALIZE RATHER THAN REJECT. The doc-hierarchy rule makes the promise
// authoritative and the behaviour the defect, so the choice is between keeping
// the promise and withdrawing it. Every one of these commands is pure syntax
// sugar — `H x` IS `L x <current y>`, `S`/`T` ARE `C`/`Q` with one control
// point reflected, and an elliptical arc has a standard, exact-to-tolerance
// cubic decomposition (SVG 1.1 F.6.5). A caller handed the refusal can do
// nothing about it except perform that same conversion by hand, which is work
// with one correct answer and no design content. So the surface does it.
//
// WHAT IS NOT TOUCHED. `M`, `L`, `C`, `Q`, `Z` and their relative forms pass
// through byte-for-byte: a path with none of the five rewritten commands is
// returned as the SAME STRING, so a read → write round trip cannot be
// perturbed by a normaliser that had nothing to do. Relative commands are
// TRACKED (the current point has to be right for an `H` that follows an `l`)
// but never rewritten — Figma accepts them, and rewriting data that already
// works would put this module in the path of every vector in a file for no
// gain.
//
// AN UNPARSEABLE STRING IS RETURNED UNCHANGED, never repaired and never
// rejected here. `path()` deliberately forwards data it cannot vouch for so
// that Figma's own refusal is what the caller sees (path.ts), and a normaliser
// that started rejecting would move that judgement to the wrong side of the
// wire.

/** The five commands Figma refuses, and the two that need the same tracking. */
const REWRITTEN = /[HhVvSsTtAa]/

/** One command and its raw argument text. */
type Token = { cmd: string; args: number[] }

const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g

/** How many numbers one instance of each command consumes. */
const ARITY: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
}

/**
 * Split path data into commands, expanding IMPLICIT REPEATS.
 *
 * `L 1 2 3 4` is two line segments, and `M 1 2 3 4` is a move followed by a
 * LINE — the one place the repeated command is not the command that opened it.
 * Returns undefined when the data does not tokenize cleanly; the caller then
 * forwards the original string and lets Figma be the judge.
 */
const tokenize = (data: string): Token[] | undefined => {
  const out: Token[] = []
  const parts = data.match(
    /[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g,
  )
  if (parts === null) {
    return undefined
  }
  // Anything before the first command, or an unrecognised character, means the
  // string is not a path this module understands.
  if (
    parts.join('').replace(/\s/g, '') !==
    data.replace(/\s/g, '')
  ) {
    return undefined
  }
  for (const part of parts) {
    const cmd = part[0]
    const lower = cmd.toLowerCase()
    const arity = ARITY[lower]
    if (arity === undefined) {
      return undefined
    }
    const nums = (part.slice(1).match(NUMBER) ?? []).map(
      Number,
    )
    if (nums.some(n => !Number.isFinite(n))) {
      return undefined
    }
    if (arity === 0) {
      if (nums.length > 0) {
        return undefined
      }
      out.push({ cmd, args: [] })
      continue
    }
    if (nums.length === 0 || nums.length % arity !== 0) {
      return undefined
    }
    for (let i = 0; i < nums.length; i += arity) {
      const chunk = nums.slice(i, i + arity)
      // A repeated `M` is an `L` (`m` an `l`) — SVG 8.3.2.
      const repeated =
        i > 0 && lower === 'm'
          ? cmd === 'M'
            ? 'L'
            : 'l'
          : cmd
      out.push({ cmd: repeated, args: chunk })
    }
  }
  return out
}

/** A number, short: no exponent, no trailing zeros, 4 decimals at most. */
const num = (v: number): string => {
  const rounded = Math.round(v * 1e4) / 1e4
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const cmdOf = (name: string, ...values: number[]): string =>
  name + ' ' + values.map(num).join(' ')

/**
 * One elliptical arc as a list of cubic segments (SVG 1.1 F.6.5).
 *
 * Endpoint parameterisation in, centre parameterisation out, then split into
 * sweeps of at most 90° — the arc where a single cubic stays inside the usual
 * error bound. Each segment's control points come from the ellipse's own
 * derivative, so the approximation is the standard one and not a hand-tuned
 * constant.
 */
const arcToCubics = (
  from: [number, number],
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  to: [number, number],
): number[][] => {
  const [x1, y1] = from
  const [x2, y2] = to
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  // A degenerate radius, or a zero-length arc, IS a straight line — the SVG
  // spec says so, and drawing it as one is exact rather than approximate.
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    return []
  }
  const phi = (phiDeg * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx2 = (x1 - x2) / 2
  const dy2 = (y1 - y2) / 2
  const x1p = cosPhi * dx2 + sinPhi * dy2
  const y1p = -sinPhi * dx2 + cosPhi * dy2
  // Radii too small to span the endpoints are scaled up until they just do.
  const lambda =
    (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const scale = Math.sqrt(lambda)
    rx *= scale
    ry *= scale
  }
  const sign = largeArc === sweep ? -1 : 1
  const numerator =
    rx * rx * ry * ry -
    rx * rx * y1p * y1p -
    ry * ry * x1p * x1p
  const denominator =
    rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coefficient =
    sign * Math.sqrt(Math.max(0, numerator / denominator))
  const cxp = (coefficient * (rx * y1p)) / ry
  const cyp = (coefficient * -(ry * x1p)) / rx
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

  const angle = (
    ux: number,
    uy: number,
    vx: number,
    vy: number,
  ): number => {
    const dot = ux * vx + uy * vy
    const len =
      Math.sqrt(ux * ux + uy * uy) *
      Math.sqrt(vx * vx + vy * vy)
    const value = Math.acos(
      Math.min(1, Math.max(-1, dot / len)),
    )
    return ux * vy - uy * vx < 0 ? -value : value
  }
  const ux = (x1p - cxp) / rx
  const uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx
  const vy = (-y1p - cyp) / ry
  const theta1 = angle(1, 0, ux, uy)
  let dtheta = angle(ux, uy, vx, vy)
  if (!sweep && dtheta > 0) {
    dtheta -= 2 * Math.PI
  }
  if (sweep && dtheta < 0) {
    dtheta += 2 * Math.PI
  }

  const pointOn = (t: number): [number, number] => [
    cosPhi * rx * Math.cos(t) -
      sinPhi * ry * Math.sin(t) +
      cx,
    sinPhi * rx * Math.cos(t) +
      cosPhi * ry * Math.sin(t) +
      cy,
  ]
  const slopeOn = (t: number): [number, number] => [
    -cosPhi * rx * Math.sin(t) - sinPhi * ry * Math.cos(t),
    -sinPhi * rx * Math.sin(t) + cosPhi * ry * Math.cos(t),
  ]

  const steps = Math.max(
    1,
    Math.ceil(Math.abs(dtheta) / (Math.PI / 2)),
  )
  const delta = dtheta / steps
  const alpha = (4 / 3) * Math.tan(delta / 4)
  const out: number[][] = []
  for (let i = 0; i < steps; i++) {
    const t0 = theta1 + i * delta
    const t1 = t0 + delta
    const p0 = pointOn(t0)
    const d0 = slopeOn(t0)
    const p1 = pointOn(t1)
    const d1 = slopeOn(t1)
    out.push([
      p0[0] + alpha * d0[0],
      p0[1] + alpha * d0[1],
      p1[0] - alpha * d1[0],
      p1[1] - alpha * d1[1],
      p1[0],
      p1[1],
    ])
  }
  return out
}

/**
 * Rewrite `H`, `V`, `S`, `T` and `A` into the `L`, `C` and `Q` Figma accepts.
 *
 * Returns the input UNCHANGED when there is nothing to rewrite, and when the
 * data does not tokenize — see the module note for why neither case is an
 * error here.
 */
export const normalizeSvgCommands = (
  data: string,
): string => {
  if (!REWRITTEN.test(data)) {
    return data
  }
  const tokens = tokenize(data)
  if (tokens === undefined) {
    return data
  }

  const out: string[] = []
  let cx = 0
  let cy = 0
  let startX = 0
  let startY = 0
  /** The previous cubic / quadratic control point, for `S` and `T`. */
  let lastCubic: [number, number] | undefined
  let lastQuad: [number, number] | undefined

  for (const { cmd, args } of tokens) {
    const lower = cmd.toLowerCase()
    const relative = cmd !== cmd.toUpperCase()
    const baseX = relative ? cx : 0
    const baseY = relative ? cy : 0
    let cubic: [number, number] | undefined
    let quad: [number, number] | undefined

    switch (lower) {
      case 'm': {
        out.push(cmd + ' ' + args.map(num).join(' '))
        cx = baseX + args[0]
        cy = baseY + args[1]
        startX = cx
        startY = cy
        break
      }
      case 'l': {
        out.push(cmd + ' ' + args.map(num).join(' '))
        cx = baseX + args[0]
        cy = baseY + args[1]
        break
      }
      case 'h': {
        // `H x` is `L x <current y>` — the whole of it.
        cx = baseX + args[0]
        out.push(cmdOf('L', cx, cy))
        break
      }
      case 'v': {
        cy = baseY + args[0]
        out.push(cmdOf('L', cx, cy))
        break
      }
      case 'c': {
        out.push(cmd + ' ' + args.map(num).join(' '))
        cubic = [baseX + args[2], baseY + args[3]]
        cx = baseX + args[4]
        cy = baseY + args[5]
        break
      }
      case 's': {
        // The first control point mirrors the previous cubic's second one
        // about the current point; with no previous cubic it IS the current
        // point (SVG 8.3.6).
        const c1x =
          lastCubic === undefined
            ? cx
            : 2 * cx - lastCubic[0]
        const c1y =
          lastCubic === undefined
            ? cy
            : 2 * cy - lastCubic[1]
        const c2x = baseX + args[0]
        const c2y = baseY + args[1]
        const ex = baseX + args[2]
        const ey = baseY + args[3]
        out.push(cmdOf('C', c1x, c1y, c2x, c2y, ex, ey))
        cubic = [c2x, c2y]
        cx = ex
        cy = ey
        break
      }
      case 'q': {
        out.push(cmd + ' ' + args.map(num).join(' '))
        quad = [baseX + args[0], baseY + args[1]]
        cx = baseX + args[2]
        cy = baseY + args[3]
        break
      }
      case 't': {
        const qx =
          lastQuad === undefined ? cx : 2 * cx - lastQuad[0]
        const qy =
          lastQuad === undefined ? cy : 2 * cy - lastQuad[1]
        const ex = baseX + args[0]
        const ey = baseY + args[1]
        out.push(cmdOf('Q', qx, qy, ex, ey))
        quad = [qx, qy]
        cx = ex
        cy = ey
        break
      }
      case 'a': {
        const ex = baseX + args[5]
        const ey = baseY + args[6]
        const cubics = arcToCubics(
          [cx, cy],
          args[0],
          args[1],
          args[2],
          args[3] !== 0,
          args[4] !== 0,
          [ex, ey],
        )
        if (cubics.length === 0) {
          // A degenerate arc is exactly a line, per the spec.
          out.push(cmdOf('L', ex, ey))
        } else {
          for (const c of cubics) {
            out.push(cmdOf('C', ...c))
          }
          cubic = [
            cubics[cubics.length - 1][2],
            cubics[cubics.length - 1][3],
          ]
        }
        cx = ex
        cy = ey
        break
      }
      default: {
        // Z — back to where this subpath started.
        out.push(cmd)
        cx = startX
        cy = startY
        break
      }
    }
    lastCubic = cubic
    lastQuad = quad
  }
  return out.join(' ')
}
