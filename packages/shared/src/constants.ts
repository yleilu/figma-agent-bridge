import pkg from '../../../package.json'

export const APP_NAME: string = pkg.name
export const APP_VERSION: string = pkg.version

export const DEFAULT_PORT = 18080

// major.minor of a semver string — the compat key for the version handshake (B2).
// A patch difference is tolerated; a minor/major difference is a breaking change.
export const majorMinor = (v: string): string => v.split('.').slice(0, 2).join('.')
