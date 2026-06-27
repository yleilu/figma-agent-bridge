import { expect, test } from 'bun:test'

import { resolveInstanceProps } from './resolve-instance-props'

// resolveInstanceProps bridges friendly component-property NAMES to the EXACT
// keys instance.setProperties requires (#11). Exact keys and VARIANT bare names
// pass through; a unique friendly name resolves to its "#id" key; ambiguous or
// unknown names warn and are skipped (never silently coerced).

test('passes an exact key through unchanged', () => {
  const { resolved, warnings } = resolveInstanceProps(
    { 'Label#1:0': 'Hi' },
    ['Label#1:0'],
  )
  expect(resolved).toEqual({ 'Label#1:0': 'Hi' })
  expect(warnings).toEqual([])
})

test('resolves a friendly name to its "#id" key', () => {
  const { resolved, warnings } = resolveInstanceProps(
    { Label: 'Hi' },
    ['Label#1:0'],
  )
  expect(resolved).toEqual({ 'Label#1:0': 'Hi' })
  expect(warnings).toEqual([])
})

test('passes a VARIANT bare name through unchanged', () => {
  const { resolved, warnings } = resolveInstanceProps(
    { Size: 'Large' },
    ['Size'],
  )
  expect(resolved).toEqual({ Size: 'Large' })
  expect(warnings).toEqual([])
})

test('uses exact name-segment equality, not startsWith', () => {
  // "Icon" must resolve only to "Icon#1:0" and must NOT match "IconColor#2:0".
  const { resolved, warnings } = resolveInstanceProps(
    { Icon: 'star' },
    ['Icon#1:0', 'IconColor#2:0'],
  )
  expect(resolved).toEqual({ 'Icon#1:0': 'star' })
  expect(warnings).toEqual([])
})

test('warns and skips a truly ambiguous friendly name', () => {
  const { resolved, warnings } = resolveInstanceProps(
    { Icon: 'star' },
    ['Icon#1:0', 'Icon#2:0'],
  )
  expect(resolved).toEqual({})
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("ambiguous property name 'Icon'")
  expect(warnings[0]).toContain('Icon#1:0')
  expect(warnings[0]).toContain('Icon#2:0')
  expect(warnings[0]).toContain('pass the exact key')
})

test('warns and skips an unknown property name', () => {
  const { resolved, warnings } = resolveInstanceProps(
    { Nope: 'x' },
    ['Label#1:0'],
  )
  expect(resolved).toEqual({})
  expect(warnings).toEqual([
    "no component property named 'Nope'",
  ])
})

test('preserves boolean values during resolution', () => {
  const { resolved } = resolveInstanceProps(
    { Disabled: true },
    ['Disabled#7:3'],
  )
  expect(resolved).toEqual({ 'Disabled#7:3': true })
})

test('resolves a mix of exact keys, friendly names, and skips unknowns', () => {
  const { resolved, warnings } = resolveInstanceProps(
    {
      'Label#1:0': 'Hi', // exact key
      Size: 'Large', // VARIANT bare name (exact)
      Disabled: true, // friendly → Disabled#7:3
      Ghost: 'x', // unknown → warn + skip
    },
    ['Label#1:0', 'Size', 'Disabled#7:3'],
  )
  expect(resolved).toEqual({
    'Label#1:0': 'Hi',
    Size: 'Large',
    'Disabled#7:3': true,
  })
  expect(warnings).toEqual([
    "no component property named 'Ghost'",
  ])
})

test('returns empty result for empty input', () => {
  expect(resolveInstanceProps({}, ['Label#1:0'])).toEqual({
    resolved: {},
    warnings: [],
  })
})
