export {
  LOGO_SVG,
  LOGO_ON_WHITE_SVG,
  LOGO_PATH,
  LOGO_VIEWBOX,
} from './logo.generated'

import {
  LOGO_SVG,
  LOGO_ON_WHITE_SVG,
} from './logo.generated'

// The naming forms — see docs/specs/branding.md §4. Each names a
// different thing and they are not interchangeable.
export const BRAND = {
  // the project as a whole, in prose
  name: 'Figma Agent Bridge',
  // the Figma plugin, as shown inside Figma
  figmaName: 'Agent Bridge',
  // the Claude Code plugin, as shown inside Claude
  claudeName: 'Figma Bridge',
  // every machine-read name
  id: 'figma-agent-bridge',
  color: '#D97757',
  bg: '#FFFFFF',
} as const

export const ICON_SIZES = [
  16, 32, 48, 128, 256, 512, 1024,
] as const

const svgToDataUri = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`

export const logoDataUri = svgToDataUri(LOGO_SVG)

export const logoOnWhiteDataUri = svgToDataUri(
  LOGO_ON_WHITE_SVG,
)
