import { CONTEXT_MAX_BYTES } from '@figma-agent-bridge/shared'
import { ToolError } from '../errors'

/** Reject an over-cap `context` before it is sent to the plugin. UTF-8 bytes, not chars.
 * The thrown ToolError already carries its code (errors.ts) and is caught by each
 * handler's try/catch, which renders it via toolError(err) into the typed envelope. */
export const assertContextWithinCap = (spec: {
  context?: unknown
}): void => {
  if (typeof spec.context !== 'string') {
    return
  }
  const bytes = Buffer.byteLength(spec.context, 'utf8')
  if (bytes > CONTEXT_MAX_BYTES) {
    throw new ToolError(
      'INVALID_PARAM',
      `context is ${bytes} bytes; limit is ${CONTEXT_MAX_BYTES} — trim the body or move detail behind a Links entry`,
    )
  }
}
