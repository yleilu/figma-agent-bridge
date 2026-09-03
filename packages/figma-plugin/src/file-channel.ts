// Deterministic per-file channel binding + the plugin-side identity
// guard (principle B3: every command is addressed to exactly one file).

// A saved file has a stable, unique figma.fileKey, so we bind its
// channel DIRECTLY to that key (with a 'file-' prefix that also marks
// it as a deterministic file-bound channel vs. the per-session random
// fallback for never-saved files). Collision-free by construction:
// two distinct fileKeys can never map to the same channel, and a
// reload of the same file re-derives the SAME channel — no
// clientStorage persistence needed.
export const deriveChannel = (fileKey: string): string =>
  `file-${fileKey}`

export {
  isTargetMismatch,
  targetGuardError,
} from '@figma-agent-bridge/shared'
