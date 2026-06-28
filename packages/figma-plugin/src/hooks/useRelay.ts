import { useState, useCallback, useRef, useEffect } from 'react'

type RelayState = {
  status: 'disconnected' | 'connecting' | 'connected'
  channel: string | null
  error: string | null
}

const generateChannel = (): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'

  return Array.from({ length: 8 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length)),
  ).join('')
}

export const useRelay = () => {
  const [state, setState] = useState<RelayState>({
    status: 'disconnected',
    channel: null,
    error: null,
  })
  const wsRef = useRef<WebSocket | null>(null)
  const channelRef = useRef<string | null>(null)
  const errorRef = useRef<string | null>(null)
  const fileNameRef = useRef<string | null>(null)
  // True only for an explicit user Disconnect — so onclose forgets the saved
  // channel ONLY then, and an unintended close (reload/blip) keeps it.
  const intentionalCloseRef = useRef(false)

  // Listen for command results and file name from plugin code
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data && event.data.pluginMessage
      if (!msg) return

      if (msg.type === 'file-name') {
        fileNameRef.current = msg.fileName ?? null
        return
      }

      if (msg.type !== 'command-result') {
        return
      }

      const ws = wsRef.current
      const channel = channelRef.current
      if (ws && channel) {
        ws.send(
          JSON.stringify({
            type: 'message',
            channel,
            message: {
              id: msg.id,
              result: msg.result,
            },
          }),
        )
      }
    }

    window.addEventListener('message', handler)

    return () => {
      window.removeEventListener('message', handler)
    }
  }, [])

  const connect = useCallback(
    (port: number, channelOverride?: string) => {
      const channel = channelOverride ?? generateChannel()
      channelRef.current = channel

      setState({
        status: 'connecting',
        channel: null,
        error: null,
      })

      const ws = new WebSocket(`ws://localhost:${port}`)
      wsRef.current = ws

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', channel }))
      }

      ws.onmessage = (event: MessageEvent) => {
        let data: Record<string, unknown>

        try {
          data = JSON.parse(event.data as string)
        } catch {
          return
        }

        if (data.type === 'system') {
          // Send register with file name
          ws.send(
            JSON.stringify({
              type: 'register',
              channel,
              fileName: fileNameRef.current,
            }),
          )

          // Persist channel ID
          parent.postMessage(
            {
              pluginMessage: {
                type: 'storage-set',
                key: 'channel-id',
                value: channel,
              },
            },
            '*',
          )

          setState({
            status: 'connected',
            channel,
            error: null,
          })
          return
        }

        if (data.type === 'broadcast' && data.message) {
          const msg = data.message as Record<string, unknown>
          if (msg.command) {
            parent.postMessage(
              {
                pluginMessage: {
                  type: 'execute-command',
                  id: msg.id,
                  command: msg.command,
                  params: (msg.params as Record<string, unknown>) ?? {},
                },
              },
              '*',
            )
          }
        }
      }

      ws.onerror = () => {
        errorRef.current = 'Connection failed'
        setState(prev => ({
          ...prev,
          status: 'disconnected',
          error: 'Connection failed',
        }))
      }

      ws.onclose = () => {
        wsRef.current = null
        channelRef.current = null

        // Forget the channel ONLY on an explicit user Disconnect. An unintended
        // close (plugin reload, relay restart, network blip) keeps channel-id so
        // the next launch restores + rejoins the same channel (overview.md →
        // Connection lifecycle). Read-then-reset so the flag can't leak into a
        // later unintended close.
        const intentional = intentionalCloseRef.current
        intentionalCloseRef.current = false
        if (intentional) {
          parent.postMessage(
            {
              pluginMessage: {
                type: 'storage-delete',
                key: 'channel-id',
              },
            },
            '*',
          )
        }

        setState({
          status: 'disconnected',
          channel: null,
          error: errorRef.current,
        })
        errorRef.current = null
      }
    },
    [],
  )

  const disconnect = useCallback(() => {
    const ws = wsRef.current
    if (ws) {
      // Mark this close intentional BEFORE ws.close() — onclose fires async and
      // will see the flag, so it forgets the persisted channel.
      intentionalCloseRef.current = true
      ws.close()
      wsRef.current = null
      channelRef.current = null
    }
    setState({
      status: 'disconnected',
      channel: null,
      error: null,
    })
  }, [])

  return { ...state, connect, disconnect }
}
