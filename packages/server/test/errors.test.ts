import { describe, expect, it } from 'bun:test'
import {
  ToolError,
  classify,
  classifyMessage,
  errorMessage,
} from '../src/errors'
import { PluginDisconnectedError } from '../src/figma-client'

describe('errorMessage', () => {
  it('returns err.message for Errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })
  it('stringifies non-Errors', () => {
    expect(errorMessage('raw')).toBe('raw')
    expect(errorMessage(42)).toBe('42')
  })
})

describe('classify — an explicit code wins', () => {
  it('honours ToolError.code over any string match', () => {
    expect(
      classify(
        new ToolError('INVALID_PARAM', 'Node not found: x'),
      ),
    ).toBe('INVALID_PARAM')
  })
  it('maps PluginDisconnectedError', () => {
    expect(
      classify(new PluginDisconnectedError('fk-a')),
    ).toBe('DISCONNECTED')
  })
})

describe('classifyMessage — transport', () => {
  it('maps the not-connected reject', () => {
    expect(classifyMessage('Not connected')).toBe(
      'DISCONNECTED',
    )
  })
  it('maps the not-joined reject', () => {
    expect(classifyMessage('Not joined to file fk-a')).toBe(
      'DISCONNECTED',
    )
  })
  it('maps the command timeout', () => {
    expect(
      classifyMessage('Command cmd_a1b2 timed out'),
    ).toBe('TIMEOUT')
  })
})

// These are the strings the REAL plugin emits — observed live, not invented.
describe('classifyMessage — observed plugin strings', () => {
  it('maps the font failure Figma itself throws', () => {
    expect(
      classifyMessage(
        'The font "NoSuchFontFamily Regular" could not be loaded',
      ),
    ).toBe('FONT_LOAD_FAILED')
  })
  it('maps a failed remote-key import', () => {
    expect(
      classifyMessage(
        'importComponentByKeyAsync failed for key "3f2a"',
      ),
    ).toBe('LIBRARY_UNPUBLISHED')
  })
  it('maps every not-found shape', () => {
    for (const m of [
      'Node not found: 1:42',
      'Instance not found: 99999:1',
      'Page not found: 0:1',
      'Style not found: S:9',
      'Variable not found: VariableID:2:3',
    ]) {
      expect(classifyMessage(m)).toBe('NODE_NOT_FOUND')
    }
  })
  it('maps a wrong node type', () => {
    expect(
      classifyMessage('Node is not an instance: 0:1'),
    ).toBe('UNSUPPORTED_NODE_TYPE')
  })
  it('prefers WRONG_EDITOR over the generic unavailable', () => {
    expect(
      classifyMessage(
        'Annotations API unavailable in this editor',
      ),
    ).toBe('WRONG_EDITOR')
  })
  it('maps a feature-detect miss', () => {
    expect(
      classifyMessage(
        'transform_group: figma.transformGroup is unavailable in this Figma runtime.',
      ),
    ).toBe('API_UNAVAILABLE')
  })
})

describe('the fallback', () => {
  it('is PLUGIN_ERROR, never INVALID_PARAM', () => {
    expect(
      classifyMessage(
        'No valid parent for the variant set',
      ),
    ).toBe('PLUGIN_ERROR')
    expect(classifyMessage('')).toBe('PLUGIN_ERROR')
  })
})
