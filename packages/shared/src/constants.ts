import pkg from '../../../package.json'

export const APP_NAME: string = pkg.name
export const APP_VERSION: string = pkg.version

export const PORT_MIN = 3000
export const PORT_MAX = 3999
// Relay allocates and probes scan within this narrower range.
// Keeps scan time bounded (~100 ports * 300ms = 30s worst case).
export const PORT_SCAN_MAX = 3099

export const validatePort = (port: number): void => {
  if (port < PORT_MIN || port > PORT_MAX) {
    throw new Error(
      `Port ${port} is out of range. Must be ${PORT_MIN}-${PORT_MAX}.`,
    )
  }
}
