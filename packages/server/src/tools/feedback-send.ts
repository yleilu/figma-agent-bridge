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
import { postFeedback } from '../worker-client'
import {
  GithubError,
  createSubIssue,
} from '../github-client'
import {
  type ToolResult,
  textResult,
  errorMessage,
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
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export interface SendFeedbackInput {
  send: string[]
  discard: string[]
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

// The item's title becomes the sub-issue title, so the body is just
// the description + a provenance footer.
const composeBody = (item: {
  description: string
  version: string
}): string =>
  `${item.description}\n\n_filed via figma-agent-bridge ${item.version}_`

export const handleSendFeedback = async (
  params: SendFeedbackInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> => {
  try {
    const cred = await readCredentials()
    const identity =
      params.identity ?? cred.preference ?? 'anonymous'

    // 1. discards first (deletes; already-gone is fine)
    for (const path of params.discard) {
      try {
        await discard(path)
      } catch {
        // already gone — fine
      }
    }

    // 2. build the send list, appending the free-text add item
    const toSend = [...params.send]
    if (params.add) {
      const created = await recordFeedback(
        params.add,
        APP_VERSION,
      )
      toSend.push(created.path)
    }

    // 3. remember the identity choice ONLY when the human
    //    explicitly chose it (never persist the default)
    if (params.identity) {
      await setPreference(params.identity)
    }

    // 4. file each — one bad item fails only itself
    const results: SendResult[] = []
    for (const path of toSend) {
      try {
        const item = await readItem(path)
        let commentUrl: string
        let linkError: string | undefined
        if (identity === 'github') {
          if (!cred.token) {
            results.push({
              path,
              status: 'auth-required',
              error: 'not logged in',
            })
            continue
          }
          const r = await createSubIssue(
            {
              repo: REPO,
              parentIssueNumber: issueForCategory(
                item.category,
              ),
              title: item.title,
              body: composeBody(item),
              token: cred.token,
            },
            fetchImpl,
          )
          commentUrl = r.url
          // The issue IS filed even if linking under the parent
          // failed — mark it sent either way so a retry never
          // files a duplicate. Just flag it as unlinked.
          if (!r.linked) {
            linkError =
              'issue created but not nested under parent — relink manually'
          }
        } else {
          const r = await postFeedback(
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
          commentUrl = r.commentUrl
        }
        const updated = await markSent(path, commentUrl)
        results.push({
          path,
          status: 'sent',
          commentUrl: updated.commentUrl,
          ...(linkError ? { error: linkError } : {}),
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
          try {
            await markFailed(path)
          } catch {
            // best-effort; a missing/stale path stays failed
          }
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
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
