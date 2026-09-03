import { describe, it, expect } from 'bun:test'
import {
  resolveBump,
  assertExplicitVersion,
  decide,
} from '../scripts/release-version'

// docs/specs/dev-ops.md §6.5 — the label -> bump table, and the
// larger-wins rule when a PR carries more than one release label.
describe('resolveBump', () => {
  it('maps each release label to its bump', () => {
    expect(resolveBump(['release:patch'])).toBe('patch')
    expect(resolveBump(['release:minor'])).toBe('minor')
    expect(resolveBump(['release:major'])).toBe('major')
  })
  it('falls back to patch when there is no release label', () => {
    expect(resolveBump([])).toBe('patch')
    expect(resolveBump(['bug', 'documentation'])).toBe(
      'patch',
    )
  })
  it('takes the larger bump when several are present, in either order', () => {
    expect(
      resolveBump(['release:patch', 'release:major']),
    ).toBe('major')
    expect(
      resolveBump(['release:major', 'release:patch']),
    ).toBe('major')
    expect(
      resolveBump(['release:patch', 'release:minor']),
    ).toBe('minor')
    expect(
      resolveBump([
        'release:minor',
        'release:major',
        'release:patch',
      ]),
    ).toBe('major')
  })
  it('ignores labels that only look like release labels', () => {
    // a bare `minor` label is not the release label, and an unknown
    // suffix is not a bump — neither may silently move the version
    expect(resolveBump(['minor'])).toBe('patch')
    expect(resolveBump(['major'])).toBe('patch')
    expect(resolveBump(['release:'])).toBe('patch')
    expect(resolveBump(['release:breaking'])).toBe('patch')
    expect(resolveBump(['prerelease:major'])).toBe('patch')
  })
})

// §7 — a dispatched release stamps the string it is given verbatim; the
// pipeline does NOT check it is >= the version-of-record. It does check
// the SHAPE, because `bump` reads a release TYPE when the argument
// looks like one.
describe('assertExplicitVersion', () => {
  it('accepts a bare semver number', () => {
    expect(assertExplicitVersion('0.4.0')).toBe('0.4.0')
    expect(assertExplicitVersion('10.20.30')).toBe(
      '10.20.30',
    )
    expect(assertExplicitVersion('1.0.0-rc.1')).toBe(
      '1.0.0-rc.1',
    )
    expect(assertExplicitVersion('  0.4.0  ')).toBe('0.4.0')
  })
  it('refuses anything `bump` would read as a release type or a filename', () => {
    for (const bad of [
      'patch',
      'minor',
      'major',
      'prompt',
      'prerelease',
      'v0.4.0',
      '',
      '0.4',
      '01.2.3',
      'latest',
    ]) {
      expect(() => assertExplicitVersion(bad)).toThrow()
    }
  })
  it('does not refuse a version lower than the version-of-record', () => {
    // deliberately unchecked (§7): dispatch is the override, and the
    // number is the operator's to choose
    expect(assertExplicitVersion('0.0.1')).toBe('0.0.1')
  })
})

describe('decide', () => {
  it('reads the labels on the merge trigger', () => {
    expect(
      decide({
        RELEASE_TRIGGER: 'pull_request',
        LABELS_JSON: '["bug","release:minor"]',
      }),
    ).toBe('minor')
  })
  it('treats an absent label list as no labels', () => {
    expect(
      decide({ RELEASE_TRIGGER: 'pull_request' }),
    ).toBe('patch')
  })
  it('takes the input verbatim on dispatch', () => {
    expect(
      decide({
        RELEASE_TRIGGER: 'workflow_dispatch',
        INPUT_VERSION: '0.4.0',
        LABELS_JSON: '["release:major"]',
      }),
    ).toBe('0.4.0')
  })
  it('throws rather than guessing on a malformed or unknown trigger', () => {
    expect(() =>
      decide({
        RELEASE_TRIGGER: 'pull_request',
        LABELS_JSON: 'not json',
      }),
    ).toThrow()
    expect(() =>
      decide({
        RELEASE_TRIGGER: 'pull_request',
        LABELS_JSON: '{"name":"release:major"}',
      }),
    ).toThrow()
    expect(() => decide({})).toThrow()
    expect(() =>
      decide({ RELEASE_TRIGGER: 'push' }),
    ).toThrow()
  })
})
