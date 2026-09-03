import { describe, expect, it } from 'bun:test'
import {
  BUILD_ID,
  SOURCE_BUILD,
  buildSkew,
} from '../src/build-id'

describe('BUILD_ID', () => {
  it('reads SOURCE_BUILD when no bundler stamped it (I62)', () => {
    // The suite runs from the working tree, which no build ever passed
    // through — so the constant must report exactly that rather than an
    // invented sha.
    expect(BUILD_ID).toBe(SOURCE_BUILD)
  })
})

describe('buildSkew (ADVISORY — never a refusal, I62)', () => {
  it('says nothing when both sides came out of one build', () => {
    expect(
      buildSkew(
        'a1b2c3d@2026-08-29T15:40Z',
        'a1b2c3d@2026-08-29T15:40Z',
      ),
    ).toBeNull()
  })

  it('names BOTH stamps when the two bundles came from different builds', () => {
    const skew = buildSkew(
      'a1b2c3d@2026-08-29T15:40Z',
      'ff00aa1@2026-08-21T09:02Z',
    )
    expect(skew).not.toBeNull()
    expect(skew).toContain('a1b2c3d@2026-08-29T15:40Z')
    expect(skew).toContain('ff00aa1@2026-08-21T09:02Z')
  })

  it('says nothing when EITHER side runs from source — an unstamped side is not evidence', () => {
    expect(
      buildSkew(SOURCE_BUILD, 'ff00aa1@2026-08-21T09:02Z'),
    ).toBeNull()
    expect(
      buildSkew('ff00aa1@2026-08-21T09:02Z', SOURCE_BUILD),
    ).toBeNull()
  })

  it('says nothing when the plugin reports no build at all (an older plugin)', () => {
    expect(
      buildSkew(undefined, 'ff00aa1@2026-08-21T09:02Z'),
    ).toBeNull()
  })
})
