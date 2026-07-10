import { useState, useCallback, useRef, useEffect } from 'react'
import type { FeedbackItem, Meta } from '@figma-agent-bridge/shared'
import { APP_VERSION, genId, genToken } from '@figma-agent-bridge/shared'
import { deriveChannel } from '../file-channel'

type RelayState = {
  status: 'disconnected' | 'connecting' | 'connected'
  channel: string | null
  error: string | null
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
  // Presence (Plugin Presence): current page name + selection count, mirrored
  // from code.ts's identity/presence pushes. Written in BOTH the persistent
  // identity listener and requestIdentity's one-shot handler — the latter is
  // load-bearing because the register frame (sent from the ws 'system'
  // branch) reads these refs before the persistent listener would otherwise
  // have populated them.
  const currentPageRef = useRef<string | null>(null)
  const selectedRef = useRef<number | null>(null)
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

  // Plugin Presence (Task 8): best-effort clean-close signal. Sends a
  // `leave` frame so the relay drops the channel immediately instead of
  // waiting for the ~60s heartbeat timeout. Fired from the `leave` push
  // (code.ts's figma.on('close') listener, forwarded via window message
  // below) and from disconnect().
  const sendLeave = useCallback(() => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN && channelRef.current) {
      ws.send(
        JSON.stringify({ type: 'leave', channel: channelRef.current }),
      )
    }
  }, [])

  // Send a correlated request over the relay and resolve on its reply.
  const request = useCallback(
    (command: string, params: Record<string, unknown>): Promise<unknown> => {
      const socket = wsRef.current
      const ch = channelRef.current
      if (!socket || !ch) return Promise.reject(new Error('Not connected'))
      const id = genId('req')
      return new Promise((resolve, reject) => {
        feedbackPending.current.set(id, { resolve, reject })
        socket.send(
          JSON.stringify({
            type: 'message',
            channel: ch,
            message: { command, params, meta: { requestId: id } },
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
        currentPageRef.current = msg.currentPage ?? null
        selectedRef.current =
          typeof msg.selected === 'number' ? msg.selected : null
        return
      }

      // Presence push (Plugin Presence): code.ts sends this (debounced) on
      // currentpagechange/selectionchange. Mirror the refs so a later
      // register/reconnect carries fresh values, and forward a presence
      // frame to the relay so the channel registry can enrich discovery.
      // MUST sit above the `command-result` gate below (same placement as
      // index-stale) since this isn't a command-result frame.
      if (msg.type === 'presence') {
        currentPageRef.current = msg.currentPage ?? null
        selectedRef.current =
          typeof msg.selected === 'number' ? msg.selected : null
        const presenceWs = wsRef.current
        const presenceChannel = channelRef.current
        if (presenceWs && presenceChannel) {
          presenceWs.send(
            JSON.stringify({
              type: 'presence',
              channel: presenceChannel,
              currentPage: msg.currentPage,
              selected: msg.selected,
            }),
          )
        }
        return
      }

      // Unsolicited freshness push: the component index on the server marks
      // this file stale. This is a PUSH, not a request — it carries a command
      // the server handles (document_changed) but NO meta and NO requestId, so
      // the server dispatches it by command + params.fileId and sends back no
      // reply (a reply would fan a stray frame to every joined channel). No
      // id/target guard needed (plugin→server, unsolicited).
      // Clean-close signal (Plugin Presence, Task 8): code.ts's
      // figma.on('close') listener pushes this so the UI can tell the
      // relay to drop the channel immediately rather than waiting for the
      // heartbeat. MUST sit above the `command-result` gate below (same
      // placement as presence/index-stale) since this isn't a
      // command-result frame.
      if (msg.type === 'leave') {
        sendLeave()
        return
      }

      if (msg.type === 'index-stale') {
        const staleWs = wsRef.current
        const staleChannel = channelRef.current
        if (staleWs && staleChannel) {
          staleWs.send(
            JSON.stringify({
              type: 'message',
              channel: staleChannel,
              message: {
                command: 'document_changed',
                params: { fileId: msg.fileKey ?? null },
              },
            }),
          )
        }
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
              // Echo the command's requestId in meta so the server correlates
              // this reply to its pending command. msg.id here is the internal
              // command-result id, which was seeded from meta.requestId when the
              // inbound command was forwarded to the sandbox below.
              meta: { requestId: msg.id },
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
  }, [sendLeave])

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
            currentPageRef.current = m.currentPage ?? null
            selectedRef.current =
              typeof m.selected === 'number' ? m.selected : null
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
            sessionChannelRef.current = genToken(8)
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
                currentPage: currentPageRef.current ?? undefined,
                selected: selectedRef.current ?? undefined,
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

            const replyId = (msg.meta as Meta | undefined)
              ?.requestId
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
              // The command's identity rides in meta (request-envelope.md):
              // requestId correlates the reply, fileKey is the B3 target the
              // sandbox guards against. Forward both into the internal
              // execute-command message (whose fields keep their names).
              const meta = msg.meta as Meta | undefined
              const requestId = meta?.requestId
              // The server contract always stamps meta.requestId on a command
              // frame; a frame without one can't be correlated, so drop it
              // loudly rather than round-trip a reply the server can't match
              // (which would hang the caller).
              if (requestId === undefined) {
                console.warn(
                  'Dropping inbound command with no meta.requestId:',
                  msg.command,
                )
                return
              }
              parent.postMessage(
                {
                  pluginMessage: {
                    type: 'execute-command',
                    id: requestId,
                    command: msg.command,
                    params:
                      (msg.params as Record<
                        string,
                        unknown
                      >) ?? {},
                    targetFileKey: meta?.fileKey ?? null,
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
      // Best-effort clean-close signal (Plugin Presence, Task 8): let the
      // relay drop the channel immediately instead of waiting for the
      // heartbeat. Must fire before ws.close() while the socket is still
      // open.
      sendLeave()
      ws.close()
      wsRef.current = null
      channelRef.current = null
    }
    setState({
      status: 'disconnected',
      channel: null,
      error: null,
    })
  }, [sendLeave])

  return {
    ...state,
    connect,
    disconnect,
    feedbackItems,
    sendFeedback,
    syncFeedback,
  }
}
