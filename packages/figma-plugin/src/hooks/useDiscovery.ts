import { useState, useEffect, useCallback } from 'react'

export const DEFAULT_RELAY_PORT = 18080
const STORAGE_KEY = 'relay-port'

/** The stored port wins; the default is the fallback. Exported so the
 *  fallback is pinned by a test — a port that silently resolves to the wrong
 *  relay reads as "the bridge is not running", not as a bug. */
export const resolveRelayPort = (saved: unknown): number =>
  (saved as number | null | undefined) ?? DEFAULT_RELAY_PORT

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

export const setStorageValue = (
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

export const deleteStorageValue = (key: string): void => {
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

export const useDiscovery = () => {
  const [port, setPort] = useState<number | null>(null)

  const resolve = useCallback(async () => {
    try {
      const saved = await getStorageValue(STORAGE_KEY)
      setPort(resolveRelayPort(saved))
    } catch {
      setPort(DEFAULT_RELAY_PORT)
    }
  }, [])

  useEffect(() => { void resolve() }, [resolve])

  return { port, retry: resolve }
}
