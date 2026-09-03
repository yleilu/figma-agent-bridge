import { describe, expect, it } from 'bun:test'
import type { ScopedFigmaClient } from '@figma-agent-bridge/server/figma-client'
import { handleCreateFromSvg } from '@figma-agent-bridge/server/tools/create-svg'

const createMockClient = (
  handler: (
    cmd: string,
    params: Record<string, unknown>,
  ) => unknown,
): ScopedFigmaClient => ({
  fileKey: 'fk-test',
  sendCommand: (cmd, params) =>
    Promise.resolve(handler(cmd, params ?? {})),
})

describe('handleCreateFromSvg', () => {
  it('sends create_from_svg command', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_from_svg') {
        sentParams = params
        return {
          id: 'svg:1',
          name: 'Icon',
          type: 'FRAME',
          childCount: 2,
        }
      }
      return null
    })

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 2L2 22h20z"/></svg>'

    const result = await handleCreateFromSvg(
      { parentId: '1:2', svg, name: 'Icon' },
      client,
    )

    expect(result.content[0].text).toContain('svg:1')
    expect(sentParams.svg).toBe(svg)
    expect(sentParams.name).toBe('Icon')
    expect(sentParams.parentId).toBe('1:2')
  })

  it('sends with optional size', async () => {
    let sentParams: Record<string, unknown> = {}
    const client = createMockClient((cmd, params) => {
      if (cmd === 'create_from_svg') {
        sentParams = params
        return {
          id: 'svg:2',
          name: 'Resized',
          type: 'FRAME',
          childCount: 1,
        }
      }
      return null
    })

    await handleCreateFromSvg(
      {
        parentId: '1:2',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
        size: [100, 100],
      },
      client,
    )

    expect(sentParams.size).toEqual([100, 100])
  })

  it('maps a thrown plugin error to a tool-formatted message', async () => {
    const client: ScopedFigmaClient = {
      fileKey: 'fk-test',
      sendCommand: () =>
        Promise.reject(new Error('plugin exploded')),
    }

    const result = await handleCreateFromSvg(
      { parentId: '1:2', svg: '<svg></svg>' },
      client,
    )

    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'plugin exploded',
      code: 'PLUGIN_ERROR',
    })
  })
})
