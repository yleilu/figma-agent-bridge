import { CONTEXT_MAX_BYTES } from '@figma-agent-bridge/shared'

/** Reject an over-cap `context` before it is sent to the plugin. UTF-8 bytes, not chars.
 * The thrown Error is caught by each handler's try/catch and surfaced as the
 * INVALID_PARAM-labelled reply (there is no error-code enum in this repo). */
export const assertContextWithinCap = (spec: {
  context?: unknown
}): void => {
  if (typeof spec.context !== 'string') return
  const bytes = Buffer.byteLength(spec.context, 'utf8')
  if (bytes > CONTEXT_MAX_BYTES) {
    throw new Error(
      `context is ${bytes} bytes; limit is ${CONTEXT_MAX_BYTES} — trim the body or move detail behind a Links entry`,
    )
  }
}
