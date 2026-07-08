import { useState, useCallback, useRef, useEffect } from 'react'
import type { FeedbackItem } from '@figma-agent-bridge/shared'
import { APP_VERSION } from '@figma-agent-bridge/shared'
import { deriveChannel } from '../file-channel'

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
  const fileKeyRef = useRef<string | null>(null)
  // Per-session channel for a never-saved file (no stable fileKey).
  // Stable across reconnects within this session; a reload starts a new
  // session. A saved file never uses this — its channel is deterministic.
  const sessionChannelRef = useRef<string | null>(null)

  // Feedback review list, keyed by FeedbackItem.path (its stable identity).
  const [feedbackItems, setFeedbackItems] = useState<
    Record<string, FeedbackItem>
  >({})
  // Requests THIS plugin originated (send-feedback / feedback-sync), tracked by
  // id so their correlated replies can be matched without swallowing normal
  // figma command traffic.
  const feedbackPending = useRef(
    new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: unknown) => void }
    >(),
  )
  const upsert = useCallback((item: FeedbackItem) => {
    setFeedbackItems(prev => ({ ...prev, [item.path]: item }))
  }, [])

  // Send a correlated request over the relay and resolve on its reply.
  const request = useCallback(
    (command: string, params: Record<string, unknown>): Promise<unknown> => {
      const socket = wsRef.current
      const ch = channelRef.current
      if (!socket || !ch) return Promise.reject(new Error('Not connected'))
      const id = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        feedbackPending.current.set(id, { resolve, reject })
        socket.send(
          JSON.stringify({
            type: 'message',
            channel: ch,
            message: { id, command, params },
          }),
        )
      })
    },
    [],
  )

  const sendFeedback = useCallback(
    (path: string) => request('send-feedback', { path }),
    [request],
  )

  const syncFeedback = useCallback(async () => {
    const { items } = (await request('feedback-sync', {})) as {
      items: FeedbackItem[]
    }
    setFeedbackItems(Object.fromEntries(items.map(i => [i.path, i])))
  }, [request])

  // Listen for command results and file name from plugin code
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data && event.data.pluginMessage
      if (!msg) return

      if (msg.type === 'identity') {
        fileKeyRef.current = msg.fileKey ?? null
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

  // Ask code.ts for the file identity and resolve when it replies (or
  // after a short timeout, so connect never blocks forever). This is the
  // race-free path: the reply arrives AFTER this listener is attached.
  const requestIdentity = useCallback(
    (): Promise<void> =>
      new Promise<void>(resolve => {
        let settled = false
        const handler = (event: MessageEvent) => {
          const m = event.data?.pluginMessage
          if (m?.type === 'identity') {
            fileKeyRef.current = m.fileKey ?? null
            fileNameRef.current = m.fileName ?? null
            finish()
          }
        }
        const finish = () => {
          if (settled) return
          settled = true
          window.removeEventListener('message', handler)
          resolve()
        }
        window.addEventListener('message', handler)
        parent.postMessage(
          { pluginMessage: { type: 'get-identity' } },
          '*',
        )
        setTimeout(finish, 500)
      }),
    [],
  )

  const connect = useCallback(
    (port: number) => {
      setState({
        status: 'connecting',
        channel: null,
        error: null,
      })

      void requestIdentity().then(() => {
        // Deterministic channel for a saved file; stable per-session
        // channel for a never-saved one. No clientStorage — a reload of
        // a saved file re-derives the SAME channel from its fileKey.
        const fk = fileKeyRef.current
        let channel: string
        if (fk !== null) {
          channel = deriveChannel(fk)
        } else {
          if (sessionChannelRef.current === null) {
            sessionChannelRef.current = generateChannel()
          }
          channel = sessionChannelRef.current
        }
        channelRef.current = channel

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
            // Register with the file identity. fileKey lets the server
            // address commands to exactly THIS file (B3).
            ws.send(
              JSON.stringify({
                type: 'register',
                channel,
                fileKey: fileKeyRef.current,
                fileName: fileNameRef.current,
                version: APP_VERSION,
              }),
            )

            setState({
              status: 'connected',
              channel,
              error: null,
            })

            void syncFeedback().catch(() => {})
            return
          }

          if (data.type === 'broadcast' && data.message) {
            const msg = data.message as Record<
              string,
              unknown
            >

            if (
              msg.command === 'feedback-added' ||
              msg.command === 'feedback-updated'
            ) {
              upsert(
                (msg.params as { item: FeedbackItem }).item,
              )
              return
            }

            const replyId = msg.id as string | undefined
            if (
              !msg.command &&
              replyId &&
              feedbackPending.current.has(replyId)
            ) {
              const p =
                feedbackPending.current.get(replyId)!
              feedbackPending.current.delete(replyId)
              if (msg.error)
                p.reject(new Error(String(msg.error)))
              else p.resolve(msg.result)
              return
            }

            if (msg.command) {
              parent.postMessage(
                {
                  pluginMessage: {
                    type: 'execute-command',
                    id: msg.id,
                    command: msg.command,
                    params:
                      (msg.params as Record<
                        string,
                        unknown
                      >) ?? {},
                    targetFileKey:
                      (msg.targetFileKey as
                        string | null | undefined) ?? null,
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

          // Settle any in-flight feedback requests — the socket is gone.
          feedbackPending.current.forEach(({ reject }) =>
            reject(new Error('Disconnected')),
          )
          feedbackPending.current.clear()

          setState({
            status: 'disconnected',
            channel: null,
            error: errorRef.current,
          })
          errorRef.current = null
        }
      })
    },
    [requestIdentity, syncFeedback, upsert],
  )

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

  return {
    ...state,
    connect,
    disconnect,
    feedbackItems,
    sendFeedback,
    syncFeedback,
  }
}
