import { useState, useEffect, useCallback, useRef } from 'react'

// Must match APP_NAME in shared/constants.ts
const APP_NAME = 'figma-agent-bridge'
const PROBE_TIMEOUT = 300
// Scan 3000-3099 only (100 ports). Relay range is 3000-3999 but
// scanning all 1000 ports at 300ms timeout each would take too long.
// If relay auto-assigns above 3099, user must connect manually.
const SCAN_START = 3000
const SCAN_END = 3099

export const probePort = (port: number): Promise<boolean> => {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      ws.close()
      resolve(false)
    }, PROBE_TIMEOUT)

    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://localhost:${port}`)
    } catch {
      clearTimeout(timer)
      resolve(false)
      return
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'ping' }))
    }

    ws.onmessage = (event: MessageEvent) => {
      clearTimeout(timer)
      try {
        const data = JSON.parse(event.data as string)
        if (
          data.type === 'pong' &&
          data.name === APP_NAME
        ) {
          ws.close()
          resolve(true)
        } else {
          ws.close()
          resolve(false)
        }
      } catch {
        ws.close()
        resolve(false)
      }
    }

    ws.onerror = () => {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

type DiscoveryState =
  | 'idle'
  | 'scanning'
  | 'found'
  | 'not-found'

type StorageMessage = {
  type: 'storage-result'
  key: string
  value: unknown
}

const getStorageValue = (
  key: string,
): Promise<unknown> => {
  const storagePromise = new Promise<unknown>(resolve => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
        ?.pluginMessage as StorageMessage | null
      if (
        msg &&
        msg.type === 'storage-result' &&
        msg.key === key
      ) {
        window.removeEventListener('message', handler)
        resolve(msg.value)
      }
    }
    window.addEventListener('message', handler)
    parent.postMessage(
      {
        pluginMessage: { type: 'storage-get', key },
      },
      '*',
    )
  })
  const timeout = new Promise<null>(resolve =>
    setTimeout(() => resolve(null), 500),
  )
  return Promise.race([storagePromise, timeout])
}

const setStorageValue = (
  key: string,
  value: unknown,
): void => {
  parent.postMessage(
    {
      pluginMessage: {
        type: 'storage-set',
        key,
        value,
      },
    },
    '*',
  )
}

const deleteStorageValue = (key: string): void => {
  parent.postMessage(
    {
      pluginMessage: {
        type: 'storage-delete',
        key,
      },
    },
    '*',
  )
}

const STORAGE_KEY = 'relay-port'

export const useDiscovery = () => {
  const [state, setState] = useState<DiscoveryState>('idle')
  const [discoveredPort, setDiscoveredPort] = useState<
    number | null
  >(null)
  const abortRef = useRef(false)

  const scan = useCallback(async () => {
    abortRef.current = false
    setState('scanning')
    setDiscoveredPort(null)

    // Try saved port first
    try {
      const saved = (await getStorageValue(
        STORAGE_KEY,
      )) as number | null
      if (saved && !abortRef.current) {
        const ok = await probePort(saved)
        if (ok && !abortRef.current) {
          setDiscoveredPort(saved)
          setState('found')
          return
        }
        // Saved port failed — clear it
        deleteStorageValue(STORAGE_KEY)
      }
    } catch {
      // clientStorage unavailable (e.g. outside Figma)
    }

    // Scan port range
    for (let port = SCAN_START; port <= SCAN_END; port++) {
      if (abortRef.current) return
      const ok = await probePort(port)
      if (ok && !abortRef.current) {
        setDiscoveredPort(port)
        setStorageValue(STORAGE_KEY, port)
        setState('found')
        return
      }
    }

    if (!abortRef.current) {
      setState('not-found')
    }
  }, [])

  const cancel = useCallback(() => {
    abortRef.current = true
    setState('idle')
  }, [])

  useEffect(() => {
    scan()
    return () => {
      abortRef.current = true
    }
  }, [scan])

  return { state, discoveredPort, scan, cancel }
}
