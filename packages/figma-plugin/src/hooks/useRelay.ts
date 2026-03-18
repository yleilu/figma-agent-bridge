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

  // Listen for command results from plugin code
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data && event.data.pluginMessage
      if (!msg || msg.type !== 'command-result') {
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

  const connect = useCallback((port: number) => {
    const channel = generateChannel()
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
        setState({
          status: 'connected',
          channel,
          error: null,
        })
        return
      }

      if (
        data.type === 'broadcast' &&
        data.message &&
        data.message.command
      ) {
        parent.postMessage(
          {
            pluginMessage: {
              type: 'execute-command',
              id: data.message.id,
              command: data.message.command,
              params: data.message.params ?? {},
            },
          },
          '*',
        )
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
      setState({
        status: 'disconnected',
        channel: null,
        error: errorRef.current,
      })
      errorRef.current = null
    }
  }, [])

  const disconnect = useCallback(() => {
    const ws = wsRef.current
    if (ws) {
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
