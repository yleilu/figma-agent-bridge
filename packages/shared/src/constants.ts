import {
  name as pkgName,
  version as pkgVersion,
} from '../../../package.json'
import type { FeedbackCategory } from './feedback'

export const APP_NAME: string = pkgName
export const APP_VERSION: string = pkgVersion

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

// ── Feedback: GitHub filing target + OAuth (public, non-secret) ────────────────

// owner/repo the feedback issues live in
export const REPO = 'yleilu/figma-agent-bridge'

// Standing issue numbers, one per category — feedback is posted as a comment on one of these.
export const BUGS_ISSUE = 1
export const PROPOSALS_ISSUE = 2

// OAuth App device-flow client id (public — safe to ship; no secret).
export const OAUTH_CLIENT_ID = 'Ov23li2wE2mr9sLPX6dP'
// 'public_repo' (repo is public); 'repo' if it ever goes private again.
export const OAUTH_SCOPE = 'public_repo'

// The standing issue a category's comments are posted to.
export const issueForCategory = (
  category: FeedbackCategory,
): number =>
  category === 'bugs' ? BUGS_ISSUE : PROPOSALS_ISSUE
