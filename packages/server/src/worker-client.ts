import type { FeedbackCategory } from '@figma-agent-bridge/shared'

export interface PostFeedbackArgs {
  workerUrl: string
  category: FeedbackCategory
  title: string
  body: string
  version: string
}

// A non-2xx from the Worker, carrying the status so the
// caller can tell a throttled batch (429) from a one-off
// failure and stop hammering the endpoint.
export class WorkerError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'WorkerError'
    this.status = status
  }
}

export const postFeedback = async (
  args: PostFeedbackArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<{ commentUrl: string }> => {
  if (!args.workerUrl) {
    throw new Error('WORKER_URL is not configured')
  }
  const res = await fetchImpl(args.workerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      category: args.category,
      title: args.title,
      body: args.body,
      version: args.version,
    }),
  })
  if (!res.ok) {
    const detail = (await res.text()).trim().slice(0, 200)
    throw new WorkerError(
      res.status,
      detail
        ? `Worker responded ${res.status}: ${detail}`
        : `Worker responded ${res.status}`,
    )
  }
  const data = (await res.json()) as {
    comment_url?: string
  }
  if (!data.comment_url) {
    throw new Error('Worker response missing comment_url')
  }
  return { commentUrl: data.comment_url }
}
