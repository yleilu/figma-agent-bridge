import { startRelay } from './relay'

const port = Number(process.env.PORT ?? 3000)

startRelay(port)
