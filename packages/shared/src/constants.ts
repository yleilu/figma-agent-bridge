import pkg from '../../../package.json'

export const APP_NAME: string = pkg.name
export const APP_VERSION: string = pkg.version

export const DEFAULT_PORT = 18080

// Protocol/compat version for the plugin↔server handshake.
// Bump ONLY on a breaking transport/protocol change — NOT every release.
export const PROTOCOL_VERSION = '1'
