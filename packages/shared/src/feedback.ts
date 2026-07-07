export const FEEDBACK_CATEGORIES = ['bugs', 'proposals'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
export type FeedbackStatus = 'pending' | 'sent' | 'failed'

export interface FeedbackItem {
  path: string
  category: FeedbackCategory
  title: string
  description: string
  version: string
  created: string
  tool?: string
  status: FeedbackStatus
  sentAt?: string
  commentUrl?: string
}
