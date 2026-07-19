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

export const BRAND = {
  name: 'Agent Bridge',
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
