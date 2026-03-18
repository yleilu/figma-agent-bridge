import { validatePort } from '@figma-agent-bridge/shared'
import { findAvailablePort, startRelay } from './relay'

const envPort = process.env.PORT

let port: number

if (envPort !== undefined) {
  port = Number(envPort)
  validatePort(port)
} else {
  port = await findAvailablePort()
}

startRelay(port)
console.log(`Relay listening on port ${port}`)
