import type {
  BroadcastMessage,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
  RegisterMessage,
  SystemMessage,
} from '@figma-agent-bridge/shared/types'
import cardFixture from '../fixtures/card-node-raw.json'
import pageLayoutFixture from '../fixtures/page-layout-raw.json'
import stylesFixture from '../fixtures/styles-raw.json'
import componentsFixture from '../fixtures/components-raw.json'

const MOCK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red" width="100" height="100"/></svg>'

const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type MockPluginOptions = {
  relayUrl: string
  channel: string
  documentName?: string
  pageName?: string
}

type MockPlugin = {
  start: () => Promise<void>
  stop: () => void
}

export const createMockPlugin = (
  options: MockPluginOptions,
): MockPlugin => {
  const {
    relayUrl,
    channel,
    documentName = 'Mock Document',
    pageName = 'Page 1',
  } = options

  let ws: WebSocket | null = null

  const handleBroadcast = (
    socket: WebSocket,
    cmd: CommandMessage,
  ): void => {
    let result: unknown = undefined
    let error: string | undefined = undefined

    switch (cmd.command) {
      case 'get_document_info':
        result = {
          name: documentName,
          currentPage: {
            id: 'page:1',
            name: pageName,
          },
        }
        break

      case 'get_selection':
        result = [
          { id: '1:42', name: 'Card', type: 'FRAME' },
        ]
        break

      case 'get_node':
        result = cardFixture
        break

      // inspect serializes the same raw export get_node consumes; the server's
      // read model (truncate-tree + budget) decides what survives.
      case 'inspect':
        result = cardFixture
        break

      case 'get_nodes':
        result = [cardFixture]
        break

      case 'get_page_layout':
        result = pageLayoutFixture
        break

      case 'get_pages':
        result = [
          {
            id: 'page:1',
            name: pageName,
            isCurrent: true,
            childCount: 3,
          },
        ]
        break

      case 'get_styles':
        result = stylesFixture
        break

      case 'get_local_components':
        result = componentsFixture
        break

      case 'search_nodes':
        result = {
          results: [
            {
              id: '1:42',
              name: 'Card',
              type: 'FRAME',
              page: pageName,
              parent: 'Root [0:1]',
              width: 320,
              height: 200,
            },
          ],
          truncated: false,
        }
        break

      case 'export_node': {
        const fmt = (cmd.params?.format as string) || 'PNG'
        const scale = (cmd.params?.scale as number) || 1
        result = {
          format: fmt,
          scale,
          data: fmt === 'SVG' ? MOCK_SVG : MOCK_PNG_BASE64,
        }
        break
      }

      // update_node: echo the CONVERTED spec (Figma objects, not atom strings)
      // back so e2e/round-trip tests prove the server parsed and the plugin
      // only assigned. Mirrors the real plugin's {id,name,type,warnings} reply.
      case 'update_node': {
        const spec = (cmd.params?.spec ?? {}) as Record<
          string,
          unknown
        >
        result = {
          id: cmd.params?.nodeId as string,
          name: (spec.name as string) ?? 'Card',
          type: 'FRAME',
          warnings: [],
          // Echo the converted spec so the e2e can assert the parsed paint
          // arrived intact.
          spec,
        }
        break
      }

      // bind_variable: deterministic happy / degrade / error paths keyed off
      // the variableId so the e2e can drive each contract. A degrade/unknown
      // reply NEVER returns {error} — it returns {id,warnings} so the server's
      // formatMutationResult reports success-with-warning, not failure.
      case 'bind_variable': {
        const variableId = cmd.params?.variableId as string
        if (variableId.startsWith('err:')) {
          error = `Variable not found: ${variableId}`
        } else if (variableId.startsWith('degrade:')) {
          result = {
            id: cmd.params?.nodeId as string,
            warnings: [
              'setBoundVariable unavailable in this Figma version; binding skipped',
            ],
          }
        } else {
          result = {
            id: cmd.params?.nodeId as string,
            warnings: [],
          }
        }
        break
      }

      // get_variables: a card-with-binding fixture so the round-trip can pick a
      // variable id, bind it, and read it back as a var(...) wrapper atom.
      case 'get_variables': {
        result = {
          results: [
            {
              id: 'col:1',
              name: 'Brand',
              modes: [{ modeId: 'm1', name: 'Light' }],
              variables: [
                {
                  id: 'var:123',
                  name: 'Brand/Primary',
                  resolvedType: 'COLOR',
                  valuesByMode: {
                    m1: { r: 1, g: 0, b: 0, a: 1 },
                  },
                },
              ],
            },
          ],
        }
        break
      }

      case 'create_node': {
        const nodeSpec = cmd.params?.node as
          | Record<string, unknown>
          | undefined
        const parentId = cmd.params?.parentId as string
        const nodeType = nodeSpec?.type as string
        // Echo the received node spec back (serialized fills/
        // effects/layout/strokes) so e2e tests can assert that the
        // converted spec reached the plugin intact. SECTION nodes use
        // MinimalFillsMixin (read-only fills); the real plugin guards
        // before assigning, but echoing the spec is sufficient for
        // serialization-regression coverage.
        const echo: Record<string, unknown> = {
          ...(nodeSpec ?? {}),
        }
        delete echo.children
        result = {
          ...echo,
          id: `created:${Math.random().toString(36).slice(2, 8)}`,
          name: (nodeSpec?.name as string) ?? nodeType,
          type: nodeType,
          parentId,
        }
        break
      }

      case 'create_tree': {
        const treeSpec = cmd.params?.node as
          | Record<string, unknown>
          | undefined
        const treeParentId = cmd.params?.parentId as string
        const countNodes = (
          node: Record<string, unknown>,
        ): number => {
          let count = 1
          const children = node.children as
            | Record<string, unknown>[]
            | undefined
          if (children) {
            for (const child of children) {
              count += countNodes(child)
            }
          }
          return count
        }
        const totalNodes = treeSpec
          ? countNodes(treeSpec)
          : 1
        // Echo the received tree spec back (serialized fills/effects/
        // layout, plus children) so e2e/round-trip tests can assert
        // the converted spec reached the plugin intact.
        result = {
          ...(treeSpec ?? {}),
          id: `created:${Math.random().toString(36).slice(2, 8)}`,
          name:
            (treeSpec?.name as string) ??
            (treeSpec?.type as string),
          type: treeSpec?.type as string,
          parentId: treeParentId,
          totalNodes,
        }
        break
      }

      case 'create_component': {
        const compNodeId = cmd.params?.nodeId as
          | string
          | undefined
        const compNodeIds = cmd.params?.nodeIds as
          | string[]
          | undefined
        const combine = cmd.params?.combineAsVariants as
          | boolean
          | undefined
        const slots = cmd.params?.slots as
          | string[]
          | undefined
        if (combine && compNodeIds) {
          result = {
            id: `cs:${Math.random().toString(36).slice(2, 8)}`,
            name: 'VariantSet',
            type: 'COMPONENT_SET',
            key: `key:${Math.random().toString(36).slice(2, 8)}`,
          }
        } else if (slots && slots.length > 0) {
          // Mock: createSlot is not available in test environment
          result = {
            id:
              compNodeId ??
              `comp:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Component',
            type: 'COMPONENT',
            key: `key:${Math.random().toString(36).slice(2, 8)}`,
            warning:
              'createSlot is not available in this Figma version; requested slots were not created.',
          }
        } else {
          result = {
            id:
              compNodeId ??
              `comp:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Component',
            type: 'COMPONENT',
            key: `key:${Math.random().toString(36).slice(2, 8)}`,
          }
        }
        break
      }

      case 'create_from_svg': {
        const svgName =
          (cmd.params?.name as string) ?? 'SVG'
        result = {
          id: `svg:${Math.random().toString(36).slice(2, 8)}`,
          name: svgName,
          type: 'FRAME',
          childCount: 3,
        }
        break
      }

      default:
        error = 'Unknown command'
        break
    }

    // The real Figma plugin replies with { id, result|error } and NO command
    // (see figma-plugin/src/hooks/useRelay.ts). Mirror that here so the mock
    // exercises the real response shape through the relay's frame validation.
    const resolved: CommandMessage =
      error !== undefined
        ? { id: cmd.id, error }
        : { id: cmd.id, result }

    const reply: ChannelMessage = {
      type: 'message',
      channel,
      message: resolved,
    }

    socket.send(JSON.stringify(reply))
  }

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(relayUrl)
      let joined = false

      socket.onerror = () => {
        reject(new Error('Mock plugin connection failed'))
      }

      socket.onopen = () => {
        ws = socket

        socket.onmessage = event => {
          let raw: SystemMessage | BroadcastMessage

          try {
            raw = JSON.parse(event.data as string) as
              | SystemMessage
              | BroadcastMessage
          } catch {
            return
          }

          if (raw.type === 'system' && !joined) {
            joined = true

            const registerMsg: RegisterMessage = {
              type: 'register',
              channel,
              fileName: documentName ?? null,
            }
            socket.send(JSON.stringify(registerMsg))

            resolve()

            return
          }

          if (raw.type === 'broadcast') {
            handleBroadcast(socket, raw.message)
          }
        }

        const joinMsg: JoinMessage = {
          type: 'join',
          channel,
        }

        socket.send(JSON.stringify(joinMsg))
      }
    })

  const stop = (): void => {
    if (ws !== null) {
      ws.close()
      ws = null
    }
  }

  return { start, stop }
}
