export interface RateLimiter {
  limit(options: {
    key: string
  }): Promise<{ success: boolean }>
}

export interface Env {
  GITHUB_TOKEN: string
  REPO: string
  BUGS_ISSUE: string
  PROPOSALS_ISSUE: string
  FEEDBACK_LIMITER: RateLimiter
}

// A feedback item is a title and a paragraph; 16 KiB is
// orders of magnitude above an honest send.
const MAX_BODY_BYTES = 16 * 1024

const CATEGORIES = ['bugs', 'proposals'] as const
type Category = (typeof CATEGORIES)[number]

export const composeBody = (
  title: string,
  body: string,
  version: string,
): string =>
  `## ${title}\n\n${body}\n\n_Filed via figma-agent-bridge ${version}._`

const issueFor = (
  env: Env,
  category: unknown,
): string | null => {
  if (typeof category !== 'string') {
    return null
  }
  if (!CATEGORIES.includes(category as Category)) {
    return null
  }
  const key = `${category.toUpperCase()}_ISSUE` as
    | 'BUGS_ISSUE'
    | 'PROPOSALS_ISSUE'
  return env[key] || null
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export const handle = async (
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
    })
  }
  // The gate is deliberately fail-CLOSED: if the limiter
  // binding is missing or the call throws, refuse rather
  // than let the bot PAT be spent ungated — and say why,
  // instead of surfacing an opaque 500.
  let allowed: boolean
  try {
    const decision = await env.FEEDBACK_LIMITER.limit({
      key:
        request.headers.get('CF-Connecting-IP') ||
        'unknown',
    })
    allowed = decision.success
  } catch {
    return new Response(
      'Feedback gate unavailable — nothing was filed; try again later.',
      { status: 503 },
    )
  }
  if (!allowed) {
    return new Response(
      'Too many feedback sends from this address — try again in a minute.',
      { status: 429 },
    )
  }
  const raw = await request.text()
  if (
    new TextEncoder().encode(raw).length > MAX_BODY_BYTES
  ) {
    return new Response('Payload too large', {
      status: 413,
    })
  }
  // Openly reachable means anything can POST anything:
  // refuse garbage cleanly rather than throwing.
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return new Response('Malformed JSON body', {
      status: 400,
    })
  }
  if (typeof payload !== 'object' || payload === null) {
    return new Response('Malformed JSON body', {
      status: 400,
    })
  }
  const { category, title, body, version } =
    payload as Record<string, unknown>
  const issue = issueFor(env, category)
  if (!issue) {
    return new Response('Unknown category', { status: 400 })
  }
  if (!isText(title) || !isText(body)) {
    return new Response('Missing or empty title or body', {
      status: 400,
    })
  }
  const stamp = isText(version) ? version : 'unknown'
  const gh = await fetchImpl(
    `https://api.github.com/repos/${env.REPO}/issues/${issue}/comments`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': 'figma-agent-bridge',
      },
      body: JSON.stringify({
        body: composeBody(title, body, stamp),
      }),
    },
  )
  if (!gh.ok) {
    return new Response(`GitHub error ${gh.status}`, {
      status: 502,
    })
  }
  const data = (await gh.json()) as { html_url: string }
  return Response.json({ comment_url: data.html_url })
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    handle(request, env),
}
