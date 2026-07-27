import { useState, useEffect, useCallback } from 'react'

// POC ONLY (change-feed Task 1f) — reverted with the probe harness in Task 7.
// The POC relay runs on 18081 with its token bucket disarmed so probe frames
// cannot be silently dropped; 18080 must keep serving the real relay. There is
// no UI control for the port, and the stored value would win over the default,
// so the POC build pins it unconditionally below.
const DEFAULT_RELAY_PORT = 18081
const STORAGE_KEY = 'relay-port'

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
      await getStorageValue(STORAGE_KEY)
      // POC ONLY: ignore the stored port so the probe build always reaches
      // the disarmed POC relay. Restored to `saved ?? DEFAULT` in Task 7.
      setPort(DEFAULT_RELAY_PORT)
    } catch {
      setPort(DEFAULT_RELAY_PORT)
    }
  }, [])

  useEffect(() => { void resolve() }, [resolve])

  return { port, retry: resolve }
}
