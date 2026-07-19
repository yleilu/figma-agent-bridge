import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRAND,
  ICON_SIZES,
  LOGO_PATH,
  LOGO_SVG,
  LOGO_ON_WHITE_SVG,
  logoDataUri,
  logoOnWhiteDataUri,
} from '../src/index'

const assetsDir = join(import.meta.dir, '..', 'assets')

describe('branding', () => {
  test('default LOGO_SVG is a valid, transparent SVG', () => {
    expect(LOGO_SVG).toContain('<svg')
    expect(LOGO_SVG).toContain('</svg>')
    expect(LOGO_SVG).toContain('#D97757')
    expect(LOGO_SVG).not.toMatch(/<rect[^>]*fill="white"/i)
  })

  test('LOGO_ON_WHITE_SVG keeps the white background rect', () => {
    expect(LOGO_ON_WHITE_SVG).toContain('<svg')
    expect(LOGO_ON_WHITE_SVG).toMatch(
      /<rect[^>]*fill="white"/i,
    )
    expect(LOGO_ON_WHITE_SVG).toContain('#D97757')
  })

  test('LOGO_PATH is the bridge path geometry', () => {
    expect(LOGO_PATH.startsWith('M')).toBe(true)
    expect(LOGO_PATH).not.toContain('<')
  })

  test('data URIs are well-formed', () => {
    expect(
      logoDataUri.startsWith('data:image/svg+xml'),
    ).toBe(true)
    expect(
      logoOnWhiteDataUri.startsWith('data:image/svg+xml'),
    ).toBe(true)
    expect(decodeURIComponent(logoDataUri)).toContain(
      '#D97757',
    )
  })

  test('baked SVG uses the BRAND color (no drift)', () => {
    expect(LOGO_SVG).toContain(BRAND.color)
    expect(LOGO_ON_WHITE_SVG).toContain(BRAND.color)
  })

  test('BRAND tokens', () => {
    expect(BRAND.color).toBe('#D97757')
    expect(BRAND.name).toBe('Agent Bridge')
    expect(BRAND.bg).toBe('#FFFFFF')
  })

  test('every transparent icon size exists on disk', () => {
    for (const size of ICON_SIZES) {
      expect(
        // eslint-disable-next-line n/no-sync -- test-only existence check
        existsSync(join(assetsDir, `logo-${size}.png`)),
      ).toBe(true)
    }
  })

  test('white-tile icons exist on disk', () => {
    for (const size of [128, 256, 512]) {
      expect(
        // eslint-disable-next-line n/no-sync -- test-only existence check
        existsSync(join(assetsDir, `icon-${size}.png`)),
      ).toBe(true)
    }
  })
})
