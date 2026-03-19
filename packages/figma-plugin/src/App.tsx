import { useState, useEffect } from 'react'
import { useRelay } from './hooks/useRelay'
import { useDiscovery } from './hooks/useDiscovery'

const DEFAULT_PORT = 18080

export const App = () => {
  const [port, setPort] = useState(DEFAULT_PORT)
  const { status, channel, error, connect, disconnect } =
    useRelay()
  const { port: discoveredPort, retry } = useDiscovery()

  const isConnected = status === 'connected'

  // Auto-connect when port resolved, restoring saved channel if available
  useEffect(() => {
    if (discoveredPort && status === 'disconnected') {
      setPort(discoveredPort)

      // Request saved channel ID from clientStorage
      const handler = (event: MessageEvent) => {
        const msg = event.data?.pluginMessage
        if (
          msg?.type === 'storage-result' &&
          msg.key === 'channel-id'
        ) {
          window.removeEventListener('message', handler)
          connect(
            discoveredPort,
            msg.value ?? undefined,
          )
        }
      }

      window.addEventListener('message', handler)
      parent.postMessage(
        {
          pluginMessage: {
            type: 'storage-get',
            key: 'channel-id',
          },
        },
        '*',
      )
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
    </div>
  )
}
