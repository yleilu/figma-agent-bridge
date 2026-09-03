import { test, expect } from 'bun:test'

const root = new URL('../', import.meta.url).pathname // test/ → repo root
const SCRIPT = `${root}plugin/hooks/identity`

const run = async (payload: unknown) => {
  const proc = Bun.spawn(['bash', SCRIPT], {
    stdin: 'pipe',
    stdout: 'pipe',
  })
  proc.stdin.write(JSON.stringify(payload))
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { out, code, json: JSON.parse(out) }
}

const runRaw = async (raw: string) => {
  const proc = Bun.spawn(['bash', SCRIPT], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  proc.stdin.write(raw)
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { out, code }
}

test('subagent call: injects sessionId + agentId + agentType, preserving args', async () => {
  const { json, code } = await run({
    session_id: 'sess-1',
    agent_id: 'agent-1',
    agent_type: 'general-purpose',
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__figma-bridge__update_node',
    tool_input: {
      fileKey: 'fk',
      nodeId: '1:2',
      fills: [{ color: '#fff' }],
    },
  })
  expect(code).toBe(0)
  const ui = json.hookSpecificOutput.updatedInput
  expect(json.hookSpecificOutput.hookEventName).toBe(
    'PreToolUse',
  )
  expect(ui.sessionId).toBe('sess-1')
  expect(ui.agentId).toBe('agent-1')
  expect(ui.agentType).toBe('general-purpose')
  // original args preserved untouched (incl. nested)
  expect(ui.nodeId).toBe('1:2')
  expect(ui.fills).toEqual([{ color: '#fff' }])
  expect(ui.fileKey).toBe('fk')
})

test('top-level call: injects sessionId only, omits agent fields', async () => {
  const { json } = await run({
    session_id: 'sess-top',
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__figma-bridge__status',
    tool_input: {},
  })
  const ui = json.hookSpecificOutput.updatedInput
  expect(ui.sessionId).toBe('sess-top')
  expect('agentId' in ui).toBe(false)
  expect('agentType' in ui).toBe(false)
})

test('security: identity written LAST — agent-supplied values are overwritten', async () => {
  const { json } = await run({
    session_id: 'real-sess',
    agent_id: 'real-agent',
    agent_type: 'Explore',
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__figma-bridge__inspect',
    tool_input: {
      fileKey: 'fk',
      sessionId: 'SPOOF',
      agentId: 'SPOOF',
      agentType: 'SPOOF',
    },
  })
  const ui = json.hookSpecificOutput.updatedInput
  expect(ui.sessionId).toBe('real-sess')
  expect(ui.agentId).toBe('real-agent')
  expect(ui.agentType).toBe('Explore')
})

test('security: top-level spoof of agentId/agentType is STRIPPED, not passed through', async () => {
  const { json } = await run({
    session_id: 'sess-top',
    // no agent_id / agent_type → this is a top-level call
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__figma-bridge__inspect',
    tool_input: {
      fileKey: 'fk',
      agentId: 'SPOOF',
      agentType: 'SPOOF',
    },
  })
  const ui = json.hookSpecificOutput.updatedInput
  expect(ui.sessionId).toBe('sess-top')
  expect('agentId' in ui).toBe(false) // spoof deleted and NOT re-added (no real agent_id)
  expect('agentType' in ui).toBe(false)
  expect(ui.fileKey).toBe('fk') // non-identity args preserved
})

test('fail-open: malformed/empty stdin exits 0 with no output (never blocks a tool call)', async () => {
  // A PreToolUse hook must never BLOCK a real call because of its own failure.
  // None of these are reachable from real CC (always a valid JSON object payload),
  // but the hook degrades to "no injection" rather than a blocking non-zero exit.
  for (const raw of [
    '',
    'not json{',
    '{"session_id":"S","tool_input":"oops"}',
  ]) {
    const { out, code } = await runRaw(raw)
    expect(code).toBe(0) // never a blocking non-zero exit
    expect(out.trim()).toBe('') // no updatedInput → CC proceeds with original input
  }
})
