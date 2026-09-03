import {
  APP_VERSION,
  REPO,
  issueForCategory,
} from '@figma-agent-bridge/shared'
import type { FeedbackCategory } from '@figma-agent-bridge/shared'
import {
  discard,
  listPending,
  markFailed,
  markSent,
  readItem,
  recordFeedback,
} from '../feedback-store'
import {
  readCredentials,
  clearToken,
  setPreference,
} from '../credential-store'
import { WorkerError, postFeedback } from '../worker-client'
import {
  GithubError,
  postIssueComment,
} from '../github-client'
import {
  type ToolResult,
  textResult,
  errorMessage,
  toolError,
} from './shared'

export interface ListFeedbackInput {
  cursor?: string
  limit?: number
}

export const handleListFeedback = async (
  params: ListFeedbackInput,
): Promise<ToolResult> => {
  try {
    const page = await listPending({
      limit: params.limit ?? 100,
      cursor: params.cursor,
    })
    const c = await readCredentials()
    const identity = c.preference
      ? {
          preference: c.preference,
          ...(c.identity?.login
            ? { login: c.identity.login }
            : {}),
          ...(c.identity?.name
            ? { name: c.identity.name }
            : {}),
          ...(c.identity?.email
            ? { email: c.identity.email }
            : {}),
        }
      : null
    return textResult(
      JSON.stringify({
        pending: page.items,
        truncated: page.truncated,
        ...(page.cursor ? { cursor: page.cursor } : {}),
        identity,
      }),
    )
  } catch (err) {
    return toolError(err)
  }
}

export interface SendFeedbackInput {
  send: string[]
  add?: {
    category: FeedbackCategory
    title: string
    description: string
  }
  identity?: 'anonymous' | 'github'
}

interface SendResult {
  path: string
  status: 'sent' | 'failed' | 'auth-required' | 'no-access'
  commentUrl?: string
  error?: string
}

// The item's title becomes the comment heading, followed by the body
// and a provenance footer.
const composeBody = (item: {
  title: string
  description: string
  version: string
}): string =>
  `## ${item.title}\n\n${item.description}\n\n_filed via figma-agent-bridge ${item.version}_`

const failItem = async (path: string): Promise<void> => {
  try {
    await markFailed(path)
  } catch {
    // best-effort; a missing/stale path stays failed
  }
}

export const handleSendFeedback = async (
  params: SendFeedbackInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> => {
  try {
    const cred = await readCredentials()
    const identity =
      params.identity ?? cred.preference ?? 'anonymous'

    // 1. build the send list, appending the free-text add item
    const toSend = [...params.send]
    if (params.add) {
      const created = await recordFeedback(
        params.add,
        APP_VERSION,
      )
      toSend.push(created.path)
    }

    // 2. remember the identity choice ONLY when the human
    //    explicitly chose it (never persist the default)
    if (params.identity) {
      await setPreference(params.identity)
    }

    // 3. file each — one bad item fails only itself
    const results: SendResult[] = []
    // ...except a 429: the whole batch shares one IP, so
    // every remaining send would be refused too. Stop
    // calling and mark the rest failed; they stay pending.
    let throttled = ''
    for (const path of toSend) {
      if (throttled) {
        await failItem(path)
        results.push({
          path,
          status: 'failed',
          error: throttled,
        })
        continue
      }
      try {
        const item = await readItem(path)
        let commentUrl: string
        if (identity === 'github') {
          if (!cred.token) {
            results.push({
              path,
              status: 'auth-required',
              error: 'not logged in',
            })
            continue
          }
          const r = await postIssueComment(
            {
              repo: REPO,
              issueNumber: issueForCategory(item.category),
              body: composeBody(item),
              token: cred.token,
            },
            fetchImpl,
          )
          commentUrl = r.commentUrl
        } else {
          const r = await postFeedback(
            {
              workerUrl: process.env.WORKER_URL ?? '',
              category: item.category,
              title: item.title,
              body: item.description,
              version: item.version,
            },
            fetchImpl,
          )
          commentUrl = r.commentUrl
        }
        const updated = await markSent(path, commentUrl)
        results.push({
          path,
          status: 'sent',
          commentUrl: updated.commentUrl,
        })
      } catch (err) {
        if (
          err instanceof GithubError &&
          err.code === 'auth'
        ) {
          await clearToken()
          results.push({
            path,
            status: 'auth-required',
            error: err.message,
          })
        } else if (
          err instanceof GithubError &&
          err.code === 'access'
        ) {
          results.push({
            path,
            status: 'no-access',
            error: err.message,
          })
        } else {
          if (
            err instanceof WorkerError &&
            err.status === 429
          ) {
            throttled = errorMessage(err)
          }
          await failItem(path)
          results.push({
            path,
            status: 'failed',
            error: errorMessage(err),
          })
        }
      }
    }
    return textResult(JSON.stringify({ results }))
  } catch (err) {
    return toolError(err)
  }
}

export interface DiscardFeedbackInput {
  paths: string[]
}

interface DiscardResult {
  path: string
  ok: boolean
  error?: string
}

export const handleDiscardFeedback = async (
  params: DiscardFeedbackInput,
): Promise<ToolResult> => {
  try {
    const results: DiscardResult[] = []
    for (const path of params.paths) {
      try {
        await discard(path)
        results.push({ path, ok: true })
      } catch (err) {
        results.push({
          path,
          ok: false,
          error: errorMessage(err),
        })
      }
    }
    return textResult(JSON.stringify({ results }))
  } catch (err) {
    return toolError(err)
  }
}
