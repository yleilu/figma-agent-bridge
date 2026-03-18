import { useState } from 'react'
import { useRelay } from './hooks/useRelay'

export const App = () => {
  const [port, setPort] = useState(3000)
  const { status, channel, error, connect, disconnect } =
    useRelay()

  const isConnected = status === 'connected'

  const statusClass = (() => {
    if (status === 'connected') {
      return 'bg-figma-bg-success text-figma-text-success'
    }
    if (status === 'connecting') {
      return 'bg-figma-bg-warning text-figma-text-warning'
    }
    return 'bg-figma-bg-danger text-figma-text-danger'
  })()

  return (
    <div className="p-4 font-sans text-sm text-figma-text bg-figma-bg">
      <h3 className="text-base font-semibold mb-3">
        Agent Bridge
      </h3>

      <div
        className={`px-3 py-2 rounded-md mb-3 text-xs font-medium ${statusClass}`}
      >
        {status === 'connecting'
          ? 'Connecting...'
          : isConnected
            ? 'Connected'
            : 'Disconnected'}
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md mb-3 text-xs bg-figma-bg-warning text-figma-text-warning">
          {error}
        </div>
      )}

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
          disabled={isConnected}
          className="w-full px-3 py-2 rounded-md border border-figma-border text-sm bg-figma-bg text-figma-text disabled:opacity-50 focus:border-figma-border-selected outline-none"
        />
      </div>

      <button
        onClick={() =>
          isConnected ? disconnect() : connect(port)
        }
        className={`w-full px-3 py-2 rounded-md text-sm font-medium ${
          isConnected
            ? 'bg-figma-bg-danger text-figma-text-onbrand hover:opacity-90'
            : 'bg-figma-bg-brand text-figma-text-onbrand hover:bg-figma-bg-brand-hover active:bg-figma-bg-brand-pressed'
        }`}
      >
        {isConnected ? 'Disconnect' : 'Connect'}
      </button>

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
