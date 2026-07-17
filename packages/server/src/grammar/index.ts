// grammar/index.ts — the atom-grammar engine public API.
//
// One grammar, both faces (T8). The wrapper (style()/var()) and the
// {…} attr channel are parsed ONCE (parse-atom) and re-emitted ONCE
// (render-atom); the typed converters in figma-paint map an atom AST to
// and from Figma Paint/Effect/FontName/stroke objects.
//
//   View face (read):  paintToAtom/effectToAtom/fontToAtom/strokeToAtom
//                      emit hex (6/8-char UPPERCASE), image(HASH) — never
//                      write sugar.
//   Write face:        atomToPaint/etc. also accept rgb()/rgba() and
//                      image(url) sugar the view never emits. var() is
//                      read-only (binding rides on bind_variable).

export type {
  AtomAST,
  AtomArg,
  Attrs,
  AttrValue,
  Wrapper,
} from './types'

export { parseAtom, tryParseAtom } from './parse-atom'
export { renderAtom } from './render-atom'
export { tokenize } from './tokenize'

export {
  atomToPaint,
  paintToAtom,
  atomToEffect,
  effectToAtom,
  atomToFont,
  fontToAtom,
  atomToStroke,
  strokeToAtom,
  angleToTransform,
  transformToAngle,
  hexToRgba,
  rgbaToHex,
} from './figma-paint'

export type {
  RGB,
  RGBA,
  Transform,
  FigmaPaint,
  FigmaSolidPaint,
  FigmaGradientPaint,
  FigmaImagePaint,
  FigmaVideoPaint,
  FigmaPatternPaint,
  FigmaEffect,
  FigmaFontName,
  FigmaStrokeGeom,
} from './figma-paint'

export { atomToGrid, gridToAtom } from './heads/grid'
export type { FigmaLayoutGrid } from './heads/grid'

export { atomToPath, pathToAtom } from './heads/path'
export type { FigmaVectorPath } from './heads/path'
