import { expect, test } from 'bun:test'

import { projectComponentDefs } from './project-component-defs'

// get_components and update_component must emit the SAME `properties` array
// shape — {id,name,type,defaultValue,variantOptions?} keyed by the CANONICAL
// property id, with the human name being the part before "#" (read == write,
// T2). projectComponentDefs is the single source of that projection.

test('projects each definition to {id,name,type,defaultValue}', () => {
  const out = projectComponentDefs({
    'Label#1:0': { type: 'TEXT', defaultValue: 'Hello' },
  })
  expect(out).toEqual([
    {
      id: 'Label#1:0',
      name: 'Label',
      type: 'TEXT',
      defaultValue: 'Hello',
    },
  ])
})

test('splits the human name from the canonical id at "#"', () => {
  const out = projectComponentDefs({
    'Disabled#7:3': {
      type: 'BOOLEAN',
      defaultValue: false,
    },
  })
  expect(out[0].id).toBe('Disabled#7:3')
  expect(out[0].name).toBe('Disabled')
})

test('uses the full key as name when there is no "#"', () => {
  const out = projectComponentDefs({
    Variant: { type: 'VARIANT', defaultValue: 'Primary' },
  })
  expect(out[0].id).toBe('Variant')
  expect(out[0].name).toBe('Variant')
})

test('carries variantOptions only for VARIANT definitions', () => {
  const out = projectComponentDefs({
    Variant: {
      type: 'VARIANT',
      defaultValue: 'Primary',
      variantOptions: ['Primary', 'Secondary'],
    },
  })
  expect(out[0].variantOptions).toEqual([
    'Primary',
    'Secondary',
  ])
})

test('omits variantOptions for non-VARIANT definitions', () => {
  const out = projectComponentDefs({
    'Label#1:0': {
      type: 'TEXT',
      defaultValue: 'Hello',
      // a stray variantOptions on a non-VARIANT def must NOT be projected
      variantOptions: ['nope'],
    },
  })
  expect('variantOptions' in out[0]).toBe(false)
})

test('omits variantOptions when a VARIANT def has none', () => {
  const out = projectComponentDefs({
    Variant: { type: 'VARIANT', defaultValue: 'Primary' },
  })
  expect('variantOptions' in out[0]).toBe(false)
})

test('preserves boolean defaultValue without coercion', () => {
  const out = projectComponentDefs({
    'Disabled#7:3': {
      type: 'BOOLEAN',
      defaultValue: false,
    },
  })
  expect(out[0].defaultValue).toBe(false)
})

test('preserves definition order across multiple keys', () => {
  const out = projectComponentDefs({
    Variant: {
      type: 'VARIANT',
      defaultValue: 'Primary',
      variantOptions: ['Primary', 'Secondary'],
    },
    'Label#1:0': { type: 'TEXT', defaultValue: 'Hello' },
    'Disabled#7:3': {
      type: 'BOOLEAN',
      defaultValue: false,
    },
  })
  expect(out.map(p => p.id)).toEqual([
    'Variant',
    'Label#1:0',
    'Disabled#7:3',
  ])
})

test('projects an empty map to an empty array', () => {
  expect(projectComponentDefs({})).toEqual([])
})
