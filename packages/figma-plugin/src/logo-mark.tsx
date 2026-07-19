import {
  BRAND,
  LOGO_PATH,
  LOGO_VIEWBOX,
} from '@figma-agent-bridge/branding'

export const LogoMark = ({
  size = 16,
  decorative = false,
}: {
  size?: number
  decorative?: boolean
}) => (
  <svg
    width={size}
    height={size}
    viewBox={LOGO_VIEWBOX}
    fill="none"
    role={decorative ? undefined : 'img'}
    aria-hidden={decorative || undefined}
    aria-label={decorative ? undefined : BRAND.name}
    className="shrink-0"
  >
    <path
      d={LOGO_PATH}
      fill={BRAND.color}
    />
  </svg>
)
