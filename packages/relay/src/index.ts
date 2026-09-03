import { DEFAULT_PORT } from '@figma-agent-bridge/shared'
import { startRelay } from './relay'

const port =
  process.env.PORT !== undefined
    ? Number(process.env.PORT)
    : DEFAULT_PORT

startRelay(port)
console.log(`Relay listening on port ${port}`)
