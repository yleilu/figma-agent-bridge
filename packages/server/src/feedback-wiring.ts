import type { FigmaClient } from './figma-client'
import type { FeedbackItem } from '@figma-agent-bridge/shared'
import { listPending, readItem, markSent, markFailed } from './feedback-store'
import { postFeedback } from './worker-client'

const FEEDBACK_HYDRATE_LIMIT = 50

type Notify = (command: string, params: Record<string, unknown>) => void

export const buildFeedbackHandlers = (notify: Notify, fetchImpl: typeof fetch = fetch) => ({
  sync: async (): Promise<{ items: FeedbackItem[] }> => ({
    items: await listPending(FEEDBACK_HYDRATE_LIMIT),
  }),

  send: async (params: Record<string, unknown>): Promise<{ item: FeedbackItem }> => {
    const path = String(params.path)
    const item = await readItem(path)
    if (item.status === 'sent') return { item } // idempotent no-op
    try {
      const { commentUrl } = await postFeedback(
        {
          workerUrl: process.env.WORKER_URL ?? '',
          secret: process.env.WORKER_SECRET ?? '',
          category: item.category,
          title: item.title,
          body: item.description,
          version: item.version,
        },
        fetchImpl,
      )
      const updated = await markSent(path, commentUrl)
      notify('feedback-updated', { item: updated })
      return { item: updated }
    } catch (err) {
      const failed = await markFailed(path)
      notify('feedback-updated', { item: failed })
      throw err // → correlated { id, error }
    }
  },
})

export const wireFeedback = (client: FigmaClient, fetchImpl: typeof fetch = fetch): void => {
  const handlers = buildFeedbackHandlers(
    (command, params) => client.notify(command, params),
    fetchImpl,
  )
  client.onRequest('feedback-sync', handlers.sync)
  client.onRequest('send-feedback', handlers.send)
}
