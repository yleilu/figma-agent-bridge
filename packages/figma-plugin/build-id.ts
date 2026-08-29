// build-id.ts (vite config helper) — the BUILD IDENTITY both fig-plugin bundles
// carry (I62).
//
// Delegates to scripts/build-id.sh so the fig-plugin and the server bundle are
// stamped by ONE definition of "which build is this". Two definitions would drift,
// and a drifting pair reads exactly like the skew this stamp exists to detect.
//
// A failure here degrades to `'source'` rather than aborting the build: an
// unstamped bundle reports itself as unstamped and the comparison stays quiet,
// which is a far better outcome than a build that will not run.

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export const buildId = (): string => {
  try {
    return execFileSync(
      'bash',
      [resolve(__dirname, '../../scripts/build-id.sh')],
      { encoding: 'utf8' },
    ).trim()
  } catch {
    return 'source'
  }
}
