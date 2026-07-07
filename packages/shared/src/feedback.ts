export const FEEDBACK_CATEGORIES = [
  'bugs',
  'proposals',
] as const
export type FeedbackCategory =
  (typeof FEEDBACK_CATEGORIES)[number]
export type FeedbackStatus = 'pending' | 'sent' | 'failed'

export interface FeedbackItem {
  path: string // identity: relative path from the feedbacks dir, e.g. 'bugs/2026-...md'
  category: FeedbackCategory
  title: string
  description: string // markdown body
  version: string
  created: string // ISO 8601
  tool?: string
  status: FeedbackStatus
  sentAt?: string
  commentUrl?: string
}
