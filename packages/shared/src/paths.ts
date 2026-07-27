/**
 * The one path sanitizer (change-feed.md, Count mirror). Returns a path
 * SEGMENT with no extension, so one function serves both a directory name
 * (`changes/<sanitizeKey(fileKey)>/`) and a file stem
 * (`component-index/<sanitizeKey(fileKey)>.json`).
 *
 * Its shell twin — `LC_ALL=C sed 's/[^A-Za-z0-9_-]/_/g'`, used by the presence
 * and session-end hooks, which cannot import TypeScript — is held to it by the
 * fixture tables in packages/shared/test/paths.test.ts,
 * test/presence-hook.test.ts and test/lifecycle-hooks.test.ts. The pair agrees
 * only over an ASCII input alphabet, which is what real keys are.
 */
export const sanitizeKey = (key: string): string =>
  key.replace(/[^A-Za-z0-9_-]/g, '_')
