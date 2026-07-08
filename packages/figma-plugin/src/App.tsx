import { useState, useEffect } from 'react'
import { useRelay } from './hooks/useRelay'
import { useDiscovery } from './hooks/useDiscovery'

const DEFAULT_PORT = 18080

export const App = () => {
  const [port, setPort] = useState(DEFAULT_PORT)
  const [sending, setSending] = useState<Set<string>>(new Set())
  const {
    status,
    channel,
    error,
    connect,
    disconnect,
    feedbackItems,
    sendFeedback,
  } = useRelay()
  const { port: discoveredPort, retry } = useDiscovery()

  const isConnected = status === 'connected'

  // Auto-connect once a port is resolved. The channel is derived from
  // figma.fileKey inside connect(), so a reload rejoins the same file's
  // channel with no saved-channel restore.
  useEffect(() => {
    if (discoveredPort && status === 'disconnected') {
      setPort(discoveredPort)
      connect(discoveredPort)
    }
  }, [discoveredPort, status, connect])

  const statusClass = (() => {
    if (status === 'connected') {
      return 'bg-figma-bg-success text-figma-text-success'
    }
    if (status === 'connecting') {
      return 'bg-figma-bg-warning text-figma-text-warning'
    }
    return 'bg-figma-bg-danger text-figma-text-danger'
  })()

  const statusText = (() => {
    if (status === 'connecting') return 'Connecting...'
    if (isConnected) return 'Connected'
    return 'Disconnected'
  })()

  return (
    <div className="p-4 font-sans text-sm text-figma-text bg-figma-bg">
      <h3 className="text-base font-semibold mb-3">
        Agent Bridge
      </h3>

      <div
        className={`px-3 py-2 rounded-md mb-3 text-xs font-medium ${statusClass}`}
      >
        {statusText}
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md mb-3 text-xs bg-figma-bg-warning text-figma-text-warning">
          {error}
        </div>
      )}

      {!isConnected && (
        <>
          <div className="mb-3">
            <label className="block text-xs text-figma-text-secondary mb-1">
              Port
            </label>
            <input
              type="number"
              value={port}
              onChange={e => {
                const val = parseInt(e.target.value, 10)
                if (!Number.isNaN(val) && val > 0) {
                  setPort(val)
                }
              }}
              min={1}
              max={65535}
              className="w-full px-3 py-2 rounded-md border border-figma-border text-sm bg-figma-bg text-figma-text focus:border-figma-border-selected outline-none"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => connect(port)}
              className="flex-1 px-3 py-2 rounded-md text-sm font-medium bg-figma-bg-brand text-figma-text-onbrand hover:bg-figma-bg-brand-hover active:bg-figma-bg-brand-pressed"
            >
              Connect
            </button>
            <button
              onClick={retry}
              className="px-3 py-2 rounded-md text-sm font-medium bg-figma-bg-secondary text-figma-text hover:opacity-90"
            >
              Retry
            </button>
          </div>
        </>
      )}

      {isConnected && (
        <button
          onClick={disconnect}
          className="w-full px-3 py-2 rounded-md text-sm font-medium bg-figma-bg-danger text-figma-text-onbrand hover:opacity-90"
        >
          Disconnect
        </button>
      )}

      {channel && (
        <div className="mt-3 px-3 py-2 bg-figma-bg-secondary rounded-md">
          <span className="text-xs text-figma-text-secondary">
            Channel:{' '}
          </span>
          <span className="font-mono font-bold text-xs text-figma-text">
            {channel}
          </span>
        </div>
      )}

      {isConnected && (
        <div className="mt-3 px-3 py-2 bg-figma-bg-secondary rounded-md">
          <div className="text-xs text-figma-text-secondary mb-2">
            Feedback
          </div>
          {Object.values(feedbackItems).length === 0 && (
            <div className="text-xs text-figma-text-secondary">
              No feedback recorded.
            </div>
          )}
          {(['bugs', 'proposals'] as const).map(category => {
            const rows = Object.values(feedbackItems).filter(
              i => i.category === category,
            )
            if (rows.length === 0) return null
            return (
              <div key={category} className="mb-2">
                <div className="text-xs font-semibold mb-1 capitalize">
                  {category}
                </div>
                {rows.map(item => (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-2 py-1"
                  >
                    <div className="min-w-0">
                      <div className="truncate">{item.title}</div>
                      <div className="text-xs text-figma-text-secondary">
                        {new Date(item.created).toLocaleString()}
                        {item.status !== 'pending' && ` · ${item.status}`}
                      </div>
                    </div>
                    <button
                      className="px-2 py-1 rounded-md bg-figma-bg-brand text-figma-text-onbrand hover:bg-figma-bg-brand-hover active:bg-figma-bg-brand-pressed disabled:opacity-50"
                      disabled={
                        item.status === 'sent' || sending.has(item.path)
                      }
                      onClick={() => {
                        if (
                          item.status === 'sent' ||
                          sending.has(item.path)
                        )
                          return
                        setSending(s => new Set(s).add(item.path))
                        void sendFeedback(item.path)
                          .catch(() => {})
                          .finally(() => {
                            setSending(s => {
                              const next = new Set(s)
                              next.delete(item.path)
                              return next
                            })
                          })
                      }}
                    >
                      {sending.has(item.path)
                        ? 'Sending…'
                        : item.status === 'failed'
                          ? 'Retry'
                          : item.status === 'sent'
                            ? 'Sent'
                            : 'Send'}
                    </button>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
