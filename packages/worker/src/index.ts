export interface Env {
  GITHUB_TOKEN: string
  SHARED_SECRET: string
  REPO: string
  BUGS_ISSUE: string
  PROPOSALS_ISSUE: string
}

const CATEGORIES = ['bugs', 'proposals'] as const
type Category = (typeof CATEGORIES)[number]

export const composeBody = (title: string, body: string, version: string): string =>
  `## ${title}\n\n${body}\n\n_Filed via figma-agent-bridge ${version}._`

const issueFor = (env: Env, category: string): string | null => {
  if (!CATEGORIES.includes(category as Category)) return null
  const key = `${category.toUpperCase()}_ISSUE` as keyof Env
  return env[key] || null
}

export const handle = async (
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (request.headers.get('x-feedback-secret') !== env.SHARED_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }
  const { category, title, body, version } = (await request.json()) as {
    category: string; title: string; body: string; version: string
  }
  const issue = issueFor(env, category)
  if (!issue) return new Response('Unknown category', { status: 400 })
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
      body: JSON.stringify({ body: composeBody(title, body, version) }),
    },
  )
  if (!gh.ok) return new Response(`GitHub error ${gh.status}`, { status: 502 })
  const data = (await gh.json()) as { html_url: string }
  return Response.json({ comment_url: data.html_url })
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
}
