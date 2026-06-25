// read/index.ts — barrel export for the read-model runtime.
// Consumers import from '@figma-agent-bridge/server/read'.

export { estimateTokens, fillToBudget } from './budget'
export {
  truncateTree,
  isStub,
  toStub,
} from './truncate-tree'
export { encodeCursor, decodeCursor } from './cursor'
export { PROFILES, projectNode } from './project'
export { buildMatcher } from './match'

// Re-export shared types used by the runtime
export type {
  TreeResult,
  ListResult,
  TruncationReceipt,
  Cursor,
  Match,
  Profile,
} from '@figma-agent-bridge/shared/read-model'
export type {
  NodeSpec,
  NodeSpecOrStub,
  IdStub,
} from '@figma-agent-bridge/shared/node-spec'
