import pkg from '../../../package.json'

export const APP_NAME: string = pkg.name
export const APP_VERSION: string = pkg.version

export const DEFAULT_PORT = 18080

// major.minor of a semver string — the compat key for the version handshake (B2).
// A patch difference is tolerated; a minor/major difference is a breaking change.
export const majorMinor = (v: string): string =>
  v.split('.').slice(0, 2).join('.')

// Reserved shared-pluginData location + caps for the agent `context` field
// (docs/specs/self-describing-nodes.md). CONTEXT_NS is deliberately a dedicated
// literal, NOT APP_NAME (scoped/hyphenated + packaging-tied).
export const CONTEXT_NS = 'figmabridge'
export const CONTEXT_KEY = 'context'
export const CONTEXT_MAX_BYTES = 2048
export const CONTEXT_SUMMARY_MAX_BYTES = 512
