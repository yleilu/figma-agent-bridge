import {
  APP_NAME,
  PORT_MIN,
  PORT_SCAN_MAX,
} from '@figma-agent-bridge/shared'

const PROBE_TIMEOUT = 300

export const probeRelay = (
  port: number,
): Promise<boolean> => {
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
        ws.close()
        resolve(
          data.type === 'pong' && data.name === APP_NAME,
        )
      } catch {
        ws.close()
        resolve(false)
      }
    }

    ws.onerror = () => {
      clearTimeout(timer)
      ws.close()
      resolve(false)
    }
  })
}

export const findRelayPort = async (
  start = PORT_MIN,
  end = PORT_SCAN_MAX,
): Promise<number> => {
  for (let port = start; port <= end; port++) {
    if (await probeRelay(port)) {
      return port
    }
  }
  throw new Error(
    `No relay found in port range ${start}-${end}`,
  )
}
