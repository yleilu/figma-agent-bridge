import type {
  BroadcastMessage,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
  RegisterMessage,
  SystemMessage,
} from '../../packages/shared/src/types'
import cardFixture from '../fixtures/card-node-raw.json'
import pageLayoutFixture from '../fixtures/page-layout-raw.json'
import stylesFixture from '../fixtures/styles-raw.json'
import componentsFixture from '../fixtures/components-raw.json'

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
        result = [{ id: '1:42', name: 'Card', type: 'FRAME' }]
        break

      case 'get_node':
        result = cardFixture
        break

      case 'get_nodes':
        result = [cardFixture]
        break

      case 'get_page_layout':
        result = pageLayoutFixture
        break

      case 'get_pages':
        result = [{ id: 'page:1', name: pageName, isCurrent: true, childCount: 3 }]
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

      case 'export_node':
        result = { format: 'PNG', scale: 1, data: 'bW9ja2Jhc2U2NA==' }
        break

      default:
        error = 'Unknown command'
        break
    }

    const resolved: CommandMessage =
      error !== undefined
        ? { id: cmd.id, command: cmd.command, error }
        : { id: cmd.id, command: cmd.command, result }

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
