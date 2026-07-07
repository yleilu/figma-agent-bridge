import type { FeedbackCategory } from '@figma-agent-bridge/shared'

export interface PostFeedbackArgs {
  workerUrl: string
  secret: string
  category: FeedbackCategory
  title: string
  body: string
  version: string
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
      'x-feedback-secret': args.secret,
    },
    body: JSON.stringify({
      category: args.category,
      title: args.title,
      body: args.body,
      version: args.version,
    }),
  })
  if (!res.ok) {
    throw new Error(`Worker responded ${res.status}`)
  }
  const data = (await res.json()) as {
    comment_url?: string
  }
  if (!data.comment_url) {
    throw new Error('Worker response missing comment_url')
  }
  return { commentUrl: data.comment_url }
}
