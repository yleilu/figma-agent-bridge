# M1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the three-layer architecture (MCP server ↔ relay ↔ Figma plugin) running end-to-end with `connect` and `status` tools, full test infrastructure, and CI-ready linting.

**Architecture:** Bun monorepo with 5 workspace packages (figma-plugin, relay, server, cli, shared). MCP server uses stdio transport. Relay is a minimal WebSocket pub/sub. Plugin is a thin Figma API executor. A mock plugin enables testing without Figma.

**Tech Stack:**
- Runtime: Bun (workspaces, native TS, fast test runner)
- MCP SDK: `@modelcontextprotocol/sdk`
- Validation: Zod
- Testing: `bun:test`
- Linting: ESLint 10 flat config + `typescript-eslint` strict + `eslint-config-prettier`
- Formatting: Prettier (matching nccu-cbs config)
- Plugin: Plain JS (Figma QuickJS sandbox)

**Coding Standards:** Follow @javascript-standards skill — 14 mandatory preferences. Key rules:
- Arrow functions by default (regular only for `this`)
- Always destructure
- No optional chaining — explicit null checks
- No for loops — array methods only
- Printf-style console.log
- Nullish coalescing `??` over `||`
- Blank line before return/throw (except single-statement blocks)
- Always braces for conditionals

**Notion spec:** https://www.notion.so/326de7ba50688136a5edd574d3b96c0c

---

## File Structure

```
figma-agent-bridge/
├── package.json                     # Root: Bun workspaces config
├── tsconfig.json                    # Root: shared TS config
├── eslint.config.js                 # Root: ESLint 10 flat config
├── prettier.config.js               # Root: Prettier config (from nccu-cbs)
├── .gitignore
├── docs/
│   └── plans/
│       └── 2026-03-17-m1-foundation.md  # This plan
├── packages/
│   ├── shared/                      # Shared types, schemas, constants
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts             # Re-exports
│   │       ├── types.ts             # Channel, message, command types
│   │       └── schemas.ts           # Zod schemas for tool params
│   │
│   ├── relay/                       # WebSocket pub/sub server
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts             # Entry: start relay server
│   │       └── relay.ts             # Channel logic: join, leave, route messages
│   │
│   ├── server/                      # MCP server (the brain)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts             # Entry: stdio transport setup
│   │       ├── figma-client.ts      # WebSocket client: connect to relay, send/receive
│   │       └── tools/
│   │           └── session.ts       # connect + status tools
│   │
│   ├── figma-plugin/                # Figma plugin (thin client)
│   │   ├── manifest.json            # Figma plugin manifest
│   │   ├── code.js                  # Main thread: command dispatcher
│   │   └── ui.html                  # UI: WebSocket client, connection status
│   │
│   └── cli/                         # CLI client (cloud-only, stub for now)
│       └── package.json
│
└── test/
    ├── mocks/
    │   └── mock-plugin.ts           # Simulates Figma plugin over WebSocket
    ├── relay/
    │   └── relay.test.ts            # Relay unit tests
    ├── server/
    │   ├── figma-client.test.ts     # WebSocket client tests
    │   └── tools/
    │       └── session.test.ts      # connect + status tool tests
    └── integration/
        └── e2e-roundtrip.test.ts    # Full: server → relay → mock-plugin → response
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json` (root)
- Create: `tsconfig.json` (root)
- Create: `.gitignore`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/relay/package.json`
- Create: `packages/relay/tsconfig.json`
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/cli/package.json`

- [ ] **Step 1: Initialize git repo**

```bash
cd /Users/lei/wip/figma-bridge
git init
```

- [ ] **Step 2: Create root package.json**

```json
{
  "name": "figma-agent-bridge",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "relay": "bun run packages/relay/src/index.ts",
    "server": "bun run packages/server/src/index.ts",
    "dev": "bun run relay & bun run server"
  }
}
```

- [ ] **Step 3: Create root tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "types": ["bun-types"]
  },
  "exclude": ["node_modules", "dist", "packages/figma-plugin"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.DS_Store
*.log
bun.lock
```

- [ ] **Step 5: Create workspace package.json files**

`packages/shared/package.json`:
```json
{
  "name": "@figma-agent-bridge/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

`packages/relay/package.json`:
```json
{
  "name": "@figma-agent-bridge/relay",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@figma-agent-bridge/shared": "workspace:*"
  }
}
```

`packages/server/package.json`:
```json
{
  "name": "@figma-agent-bridge/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@figma-agent-bridge/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.13.1",
    "ws": "^8.16.0",
    "zod": "^3.22.4"
  }
}
```

`packages/cli/package.json`:
```json
{
  "name": "@figma-agent-bridge/cli",
  "version": "0.0.1",
  "private": true,
  "type": "module"
}
```

Each workspace package also gets a `tsconfig.json` extending root:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 6: Install dependencies**

```bash
bun install
```

- [ ] **Step 7: Verify workspace resolution**

```bash
bun run typecheck
```
Expected: No errors (no source files yet, but config is valid).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo with Bun workspaces"
```

### ✅ Checkpoint 1
> **STOP.** Ask human to verify: monorepo structure, workspace resolution, git initialized. Do not proceed until approved.

---

## Task 2: Linting & Formatting

**Files:**
- Create: `eslint.config.js` (root)
- Create: `prettier.config.js` (root)

- [ ] **Step 1: Install linting dependencies**

```bash
bun add -d eslint@^10 @eslint/js typescript-eslint eslint-config-prettier eslint-plugin-prettier prettier prettier-plugin-packagejson
```

- [ ] **Step 2: Create prettier.config.js**

Matching nccu-cbs config, adjusted for this project (wider printWidth since no Vue templates):

```javascript
export default {
  plugins: ['prettier-plugin-packagejson'],
  useTabs: false,
  printWidth: 80,
  tabWidth: 2,
  singleQuote: true,
  trailingComma: 'all',
  bracketSpacing: true,
  singleAttributePerLine: true,
};
```

- [ ] **Step 3: Create eslint.config.js**

ESLint 10 flat config with `typescript-eslint` strict (eslintrc removed in v10, flat config is the only option):

```javascript
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'packages/figma-plugin/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  prettierConfig,
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': 'error',

      // Match @javascript-standards: no unused vars (allow _ prefix)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'none',
        },
      ],

      // Match @javascript-standards: prefer const
      'prefer-const': 'error',

      // Match @javascript-standards: always braces
      curly: ['error', 'all'],

      // Match @javascript-standards: strict equality
      eqeqeq: ['error', 'always'],

      // Match @javascript-standards: no var
      'no-var': 'error',
    },
  },
);
```

- [ ] **Step 4: Verify lint runs**

```bash
bun run lint
```
Expected: No errors (no source files yet).

- [ ] **Step 5: Verify format runs**

```bash
bun run format:check
```
Expected: No issues.

- [ ] **Step 6: Commit**

```bash
git add eslint.config.js prettier.config.js package.json bun.lock
git commit -m "chore: add ESLint 10 + typescript-eslint strict + Prettier"
```

### ✅ Checkpoint 2
> **STOP.** Ask human to verify: `bun run lint` and `bun run format:check` both pass. ESLint 10 + Prettier configured correctly. Do not proceed until approved.

---

## Task 3: Shared Types & Schemas

**Files:**
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/schemas.ts`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Create shared types**

```typescript
// packages/shared/src/types.ts

// --- WebSocket message types ---

export type JoinMessage = {
  type: 'join';
  channel: string;
};

export type ChannelMessage = {
  type: 'message';
  channel: string;
  message: CommandMessage;
};

export type BroadcastMessage = {
  type: 'broadcast';
  message: CommandMessage;
};

export type SystemMessage = {
  type: 'system';
  message: {
    id: string;
    result: string;
  };
};

export type RelayIncoming = JoinMessage | ChannelMessage;
export type RelayOutgoing = BroadcastMessage | SystemMessage;

// --- Command types ---

export type CommandMessage = {
  id: string;
  command: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

// --- Channel registry ---

export type ChannelInfo = {
  channel: string;
  fileName: string | null;
  connectedAt: number;
};
```

- [ ] **Step 2: Create Zod schemas for tool params**

```typescript
// packages/shared/src/schemas.ts

import { z } from 'zod';

export const connectParamsSchema = z.object({
  channel: z
    .string()
    .min(1)
    .describe('Channel ID to join. Pairs with the Figma plugin.'),
});

export const statusParamsSchema = z.object({}).optional();
```

- [ ] **Step 3: Create index re-exports**

```typescript
// packages/shared/src/index.ts

export * from './types';
export * from './schemas';
```

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): add types and Zod schemas for relay messages and tool params"
```

### ✅ Checkpoint 3
> **STOP.** Ask human to verify: types and schemas compile, `bun run typecheck` passes. Do not proceed until approved.

---

## Task 4: WebSocket Relay

**Files:**
- Create: `packages/relay/src/relay.ts`
- Create: `packages/relay/src/index.ts`
- Create: `test/relay/relay.test.ts`

- [ ] **Step 1: Write failing relay tests**

```typescript
// test/relay/relay.test.ts

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

import { startRelay, stopRelay } from '../../packages/relay/src/relay';

const PORT = 3099; // Test port, avoid conflict with dev

describe('relay', () => {
  let server: Awaited<ReturnType<typeof startRelay>>;

  beforeAll(async () => {
    server = await startRelay(PORT);
  });

  afterAll(() => {
    stopRelay(server);
  });

  test('accepts WebSocket connections', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });

    expect(opened).toBe(true);
    ws.close();
  });

  test('joins a channel and receives system confirmation', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    const response = await new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
      ws.send(JSON.stringify({
        type: 'join',
        channel: 'test-channel',
      }));
    });

    const parsed = JSON.parse(response);

    expect(parsed.type).toBe('system');
    expect(parsed.message.result).toContain('test-channel');
    ws.close();
  });

  test('broadcasts messages to all clients in channel', async () => {
    const ws1 = new WebSocket(`ws://localhost:${PORT}`);
    const ws2 = new WebSocket(`ws://localhost:${PORT}`);

    await Promise.all([
      new Promise<void>((resolve) => { ws1.onopen = () => resolve(); }),
      new Promise<void>((resolve) => { ws2.onopen = () => resolve(); }),
    ]);

    // Both join same channel
    const joinMsg = JSON.stringify({
      type: 'join',
      channel: 'broadcast-test',
    });

    // Consume join confirmations
    const consumeJoin = (ws: WebSocket) =>
      new Promise<void>((resolve) => {
        ws.onmessage = () => resolve();
      });

    ws1.send(joinMsg);
    await consumeJoin(ws1);

    ws2.send(joinMsg);
    await consumeJoin(ws2);

    // ws1 sends a message, ws2 should receive the broadcast
    const received = new Promise<string>((resolve) => {
      ws2.onmessage = (event) => resolve(String(event.data));
    });

    ws1.send(JSON.stringify({
      type: 'message',
      channel: 'broadcast-test',
      message: {
        id: 'cmd-1',
        command: 'test_command',
        params: {},
      },
    }));

    const broadcast = JSON.parse(await received);

    expect(broadcast.type).toBe('broadcast');
    expect(broadcast.message.command).toBe('test_command');

    ws1.close();
    ws2.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/relay/
```
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Implement relay**

```typescript
// packages/relay/src/relay.ts

import type { Server } from 'bun';

import type {
  RelayIncoming,
  ChannelMessage,
} from '@figma-agent-bridge/shared';

type ChannelClients = Set<unknown>;
const channels = new Map<string, ChannelClients>();

const getOrCreateChannel = (channel: string): ChannelClients => {
  const existing = channels.get(channel);

  if (existing) {
    return existing;
  }

  const clients = new Set<unknown>();
  channels.set(channel, clients);

  return clients;
};

const handleJoin = (ws: unknown, channel: string) => {
  const clients = getOrCreateChannel(channel);
  clients.add(ws);

  const confirmation = JSON.stringify({
    type: 'system',
    message: {
      id: crypto.randomUUID(),
      result: `Connected to channel: ${channel}`,
    },
  });

  (ws as { send: (data: string) => void }).send(confirmation);
};

const handleMessage = (ws: unknown, data: ChannelMessage) => {
  const { channel, message } = data;
  const clients = channels.get(channel);

  if (!clients) {
    return;
  }

  const broadcast = JSON.stringify({
    type: 'broadcast',
    message,
  });

  clients.forEach((client) => {
    (client as { send: (data: string) => void }).send(broadcast);
  });
};

const handleDisconnect = (ws: unknown) => {
  channels.forEach((clients) => {
    clients.delete(ws);
  });
};

export const startRelay = async (port = 3055): Promise<Server> => {
  const server = Bun.serve({
    port,
    fetch(req, server) {
      const upgraded = server.upgrade(req);

      if (!upgraded) {
        return new Response('WebSocket upgrade required', { status: 426 });
      }

      return undefined as unknown as Response;
    },
    websocket: {
      open(ws) {
        // noop — wait for join
      },
      message(ws, rawData) {
        try {
          const data = JSON.parse(String(rawData)) as RelayIncoming;

          if (data.type === 'join') {
            handleJoin(ws, data.channel);

            return;
          }

          if (data.type === 'message') {
            handleMessage(ws, data);

            return;
          }
        } catch {
          // Ignore malformed messages
        }
      },
      close(ws) {
        handleDisconnect(ws);
      },
    },
  });

  console.log('Relay running on ws://localhost:%d', port);

  return server;
};

export const stopRelay = (server: Server) => {
  server.stop(true);
  channels.clear();
};
```

```typescript
// packages/relay/src/index.ts

import { startRelay } from './relay';

const port = Number(process.env.PORT ?? 3055);

startRelay(port);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/relay/
```
Expected: All 3 tests PASS.

- [ ] **Step 5: Run lint**

```bash
bun run lint
```
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/ test/relay/
git commit -m "feat(relay): WebSocket pub/sub relay with channel routing"
```

### ✅ Checkpoint 4
> **STOP.** Ask human to verify: relay tests pass (`bun test test/relay/`), relay starts on configured port. Do not proceed until approved.

---

## Task 5: MCP Server — Figma Client (WebSocket)

**Files:**
- Create: `packages/server/src/figma-client.ts`
- Create: `test/server/figma-client.test.ts`

- [ ] **Step 1: Write failing figma-client tests**

```typescript
// test/server/figma-client.test.ts

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'bun:test';

import { startRelay, stopRelay } from '../../packages/relay/src/relay';
import {
  createFigmaClient,
  type FigmaClient,
} from '../../packages/server/src/figma-client';

const PORT = 3098;

describe('figma-client', () => {
  let server: Awaited<ReturnType<typeof startRelay>>;
  let client: FigmaClient;

  beforeAll(async () => {
    server = await startRelay(PORT);
  });

  afterEach(() => {
    if (client) {
      client.disconnect();
    }
  });

  afterAll(() => {
    stopRelay(server);
  });

  test('connects to relay and joins channel', async () => {
    client = createFigmaClient(`ws://localhost:${PORT}`);
    const result = await client.joinChannel('test-ch');

    expect(result).toContain('test-ch');
  });

  test('sends command and receives response', async () => {
    // Set up a mock plugin that echoes commands
    const mockPlugin = new WebSocket(`ws://localhost:${PORT}`);

    await new Promise<void>((resolve) => {
      mockPlugin.onopen = () => resolve();
    });

    mockPlugin.send(JSON.stringify({
      type: 'join',
      channel: 'echo-ch',
    }));

    // Wait for join confirmation
    await new Promise<void>((resolve) => {
      mockPlugin.onmessage = () => resolve();
    });

    // Mock plugin echoes back with result
    mockPlugin.onmessage = (event) => {
      const data = JSON.parse(String(event.data));

      if (data.type === 'broadcast' && data.message.command) {
        mockPlugin.send(JSON.stringify({
          type: 'message',
          channel: 'echo-ch',
          message: {
            id: data.message.id,
            result: { echo: data.message.command },
          },
        }));
      }
    };

    client = createFigmaClient(`ws://localhost:${PORT}`);
    await client.joinChannel('echo-ch');

    const result = await client.sendCommand('test_cmd', { foo: 'bar' });

    expect(result).toEqual({ echo: 'test_cmd' });

    mockPlugin.close();
  });

  test('times out when no response', async () => {
    client = createFigmaClient(`ws://localhost:${PORT}`);
    await client.joinChannel('timeout-ch');

    const promise = client.sendCommand('no_response', {}, 500);

    await expect(promise).rejects.toThrow('timed out');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/server/figma-client.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement figma-client**

```typescript
// packages/server/src/figma-client.ts

import type { CommandMessage } from '@figma-agent-bridge/shared';

export type FigmaClient = {
  joinChannel: (channel: string) => Promise<string>;
  sendCommand: (
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  disconnect: () => void;
  isConnected: () => boolean;
  currentChannel: () => string | null;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const createFigmaClient = (relayUrl: string): FigmaClient => {
  let ws: WebSocket | null = null;
  let channel: string | null = null;
  const pending = new Map<string, PendingRequest>();

  const connect = (): Promise<void> =>
    new Promise((resolve, reject) => {
      ws = new WebSocket(relayUrl);
      ws.onopen = () => resolve();
      ws.onerror = (err) => reject(new Error(`WebSocket error: ${err}`));

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data));

          if (data.type === 'broadcast' && data.message) {
            const { id, result, error } = data.message as CommandMessage;
            const req = pending.get(id);

            if (!req) {
              return;
            }

            pending.delete(id);
            clearTimeout(req.timer);

            if (error) {
              req.reject(new Error(error));

              return;
            }

            req.resolve(result);
          }
        } catch {
          // Ignore malformed messages
        }
      };
    });

  const joinChannel = async (ch: string): Promise<string> => {
    if (!ws) {
      await connect();
    }

    return new Promise((resolve) => {
      const prevHandler = ws!.onmessage;

      ws!.onmessage = (event) => {
        const data = JSON.parse(String(event.data));

        if (data.type === 'system') {
          channel = ch;
          ws!.onmessage = prevHandler;
          resolve(data.message.result);

          return;
        }

        if (prevHandler) {
          (prevHandler as (event: MessageEvent) => void)(event);
        }
      };

      ws!.send(JSON.stringify({
        type: 'join',
        channel: ch,
      }));
    });
  };

  const sendCommand = (
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 3e4,
  ): Promise<unknown> => {
    if (!ws || !channel) {
      return Promise.reject(
        new Error('Not connected. Call joinChannel first.'),
      );
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

      ws!.send(JSON.stringify({
        type: 'message',
        channel,
        message: { id, command, params },
      }));
    });
  };

  const disconnect = () => {
    pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error('Disconnected'));
    });
    pending.clear();

    if (ws) {
      ws.close();
      ws = null;
    }

    channel = null;
  };

  return {
    joinChannel,
    sendCommand,
    disconnect,
    isConnected: () => ws !== null && channel !== null,
    currentChannel: () => channel,
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/server/figma-client.test.ts
```
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/figma-client.ts test/server/figma-client.test.ts
git commit -m "feat(server): Figma WebSocket client with command send/receive and timeout"
```

### ✅ Checkpoint 5
> **STOP.** Ask human to verify: figma-client tests pass, WebSocket connect/send/timeout all working. Do not proceed until approved.

---

## Task 6: MCP Server — Session Tools (connect + status)

**Files:**
- Create: `packages/server/src/tools/session.ts`
- Create: `packages/server/src/index.ts`
- Create: `test/server/tools/session.test.ts`

- [ ] **Step 1: Write failing session tool tests**

```typescript
// test/server/tools/session.test.ts

import { describe, test, expect } from 'bun:test';

import {
  handleConnect,
  handleStatus,
} from '../../../packages/server/src/tools/session';

describe('session tools', () => {
  test('handleConnect returns success with channel', async () => {
    const mockClient = {
      joinChannel: async (ch: string) => `Connected to channel: ${ch}`,
      isConnected: () => true,
      currentChannel: () => 'test-ch',
    };

    const result = await handleConnect(
      { channel: 'test-ch' },
      mockClient as never,
    );

    expect(result.content).toBeDefined();
    expect(result.content[0].text).toContain('test-ch');
  });

  test('handleStatus returns disconnected when no channel', async () => {
    const mockClient = {
      isConnected: () => false,
      currentChannel: () => null,
    };

    const result = await handleStatus(mockClient as never);

    expect(result.content[0].text).toContain('disconnected');
  });

  test('handleStatus returns connected with channel info', async () => {
    const mockClient = {
      isConnected: () => true,
      currentChannel: () => 'my-channel',
    };

    const result = await handleStatus(mockClient as never);
    const text = result.content[0].text;

    expect(text).toContain('connected');
    expect(text).toContain('my-channel');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test test/server/tools/session.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement session tools**

```typescript
// packages/server/src/tools/session.ts

import type { FigmaClient } from '../figma-client';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

const textResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
});

export const handleConnect = async (
  params: { channel: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const { channel } = params;

  try {
    const result = await client.joinChannel(channel);

    return textResult(`Joined channel "${channel}". ${result}`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';

    return textResult(`Failed to connect: ${message}`);
  }
};

export const handleStatus = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  const connected = client.isConnected();
  const channel = client.currentChannel();

  if (!connected || !channel) {
    return textResult(
      'Status: disconnected. Use the connect tool to join a channel.',
    );
  }

  return textResult(
    `Status: connected to channel "${channel}".`,
  );
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/server/tools/session.test.ts
```
Expected: All 3 tests PASS.

- [ ] **Step 5: Implement MCP server entry point**

```typescript
// packages/server/src/index.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createFigmaClient } from './figma-client';
import { handleConnect, handleStatus } from './tools/session';

const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:3055';

const server = new McpServer({
  name: 'figma-agent-bridge',
  version: '0.0.1',
});

const client = createFigmaClient(RELAY_URL);

server.tool(
  'connect',
  'Join a Figma plugin channel. Pairs the MCP server with a running Figma plugin.',
  { channel: z.string().min(1).describe('Channel ID to join') },
  async ({ channel }) => handleConnect({ channel }, client),
);

server.tool(
  'status',
  'Check connection status with the Figma plugin.',
  {},
  async () => handleStatus(client),
);

const main = async () => {
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.log('figma-agent-bridge MCP server started');
};

main().catch(console.error);
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ test/server/tools/
git commit -m "feat(server): MCP server with connect and status tools"
```

### ✅ Checkpoint 6
> **STOP.** Ask human to verify: session tool tests pass, MCP server entry point compiles, `connect` and `status` tools registered. Do not proceed until approved.

---

## Task 7: Figma Plugin Shell

**Files:**
- Create: `packages/figma-plugin/manifest.json`
- Create: `packages/figma-plugin/code.js`
- Create: `packages/figma-plugin/ui.html`

> **⚠️ Design Decision Needed:** The plugin UI currently uses plain HTML/JS for M1 (minimal shell). Before M2+, we should evaluate modern web frameworks for the plugin UI (React, Svelte, or Vue + bundler). Design this before adding more UI complexity. The QuickJS sandbox constraint only applies to `code.js` (main thread), NOT to `ui.html` (iframe — full browser environment).

- [ ] **Step 1: Create plugin manifest**

```json
{
  "name": "Agent Bridge",
  "id": "figma-agent-bridge",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"]
}
```

- [ ] **Step 2: Create plugin code.js**

Plain JS (QuickJS sandbox). Handles `get_document_info` for the `status` flow.

```javascript
// packages/figma-plugin/code.js
// Figma plugin main thread — QuickJS sandbox (no optional chaining, no ??)
// Plain ES5-compatible JavaScript

figma.showUI(__html__, { width: 340, height: 280, title: 'Agent Bridge' });

function handleCommand(command, params) {
  if (command === 'get_document_info') {
    return {
      name: figma.root.name,
      currentPage: {
        id: figma.currentPage.id,
        name: figma.currentPage.name,
      },
    };
  }

  return { error: 'Unknown command: ' + command };
}

figma.ui.onmessage = function (msg) {
  if (msg.type === 'execute-command') {
    var result = handleCommand(msg.command, msg.params);

    figma.ui.postMessage({
      type: 'command-result',
      id: msg.id,
      result: result,
    });
  }
};
```

- [ ] **Step 3: Create plugin UI (ui.html)**

```html
<!-- packages/figma-plugin/ui.html -->
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Inter, sans-serif; padding: 16px; font-size: 13px; }
    .status { padding: 8px; border-radius: 6px; margin: 8px 0; }
    .connected { background: #e6f4ea; color: #137333; }
    .disconnected { background: #fce8e6; color: #c5221f; }
    input, button { padding: 8px 12px; border-radius: 6px; border: 1px solid #ddd; margin: 4px 0; }
    button { background: #0d99ff; color: white; border: none; cursor: pointer; }
    button:hover { background: #0b87e0; }
    #channel-display { font-family: monospace; font-weight: bold; }
  </style>
</head>
<body>
  <h3>Agent Bridge</h3>
  <div id="status" class="status disconnected">Disconnected</div>

  <label>Port</label>
  <input id="port" type="number" value="3055" />
  <button id="connect-btn">Connect</button>

  <div id="channel-info" style="display:none; margin-top: 12px;">
    <p>Channel: <span id="channel-display"></span></p>
  </div>

  <script>
    var ws = null;
    var channel = null;

    function generateChannel() {
      var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      var result = '';
      for (var i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    }

    function setStatus(connected, text) {
      var el = document.getElementById('status');
      el.textContent = text;
      el.className = 'status ' + (connected ? 'connected' : 'disconnected');
    }

    document.getElementById('connect-btn').onclick = function () {
      var port = document.getElementById('port').value;
      channel = generateChannel();

      try {
        ws = new WebSocket('ws://localhost:' + port);
      } catch (e) {
        setStatus(false, 'Failed to connect: ' + e.message);
        return;
      }

      ws.onopen = function () {
        ws.send(JSON.stringify({ type: 'join', channel: channel }));
      };

      ws.onmessage = function (event) {
        var data = JSON.parse(event.data);

        if (data.type === 'system') {
          setStatus(true, 'Connected');
          document.getElementById('channel-info').style.display = 'block';
          document.getElementById('channel-display').textContent = channel;
          return;
        }

        if (data.type === 'broadcast' && data.message && data.message.command) {
          // Forward command to plugin code
          parent.postMessage({
            pluginMessage: {
              type: 'execute-command',
              id: data.message.id,
              command: data.message.command,
              params: data.message.params || {},
            },
          }, '*');
        }
      };

      ws.onclose = function () {
        setStatus(false, 'Disconnected');
      };

      ws.onerror = function () {
        setStatus(false, 'Connection error');
      };
    };

    // Receive results from plugin code, send back over WebSocket
    window.onmessage = function (event) {
      var msg = event.data.pluginMessage;
      if (!msg || msg.type !== 'command-result') return;

      if (ws && channel) {
        ws.send(JSON.stringify({
          type: 'message',
          channel: channel,
          message: {
            id: msg.id,
            result: msg.result,
          },
        }));
      }
    };
  </script>
</body>
</html>
```

- [ ] **Step 4: Commit**

```bash
git add packages/figma-plugin/
git commit -m "feat(plugin): Agent Bridge Figma plugin shell with WebSocket relay client"
```

### ✅ Checkpoint 7
> **STOP.** Ask human to verify: plugin manifest, code.js, ui.html all created. Plugin structure looks correct for Figma import. Do not proceed until approved.

---

## Task 8: Mock Plugin & Integration Test

**Files:**
- Create: `test/mocks/mock-plugin.ts`
- Create: `test/integration/e2e-roundtrip.test.ts`

- [ ] **Step 1: Create mock plugin**

```typescript
// test/mocks/mock-plugin.ts

type MockPluginOptions = {
  relayUrl: string;
  channel: string;
  documentName?: string;
  pageName?: string;
};

export type MockPlugin = {
  start: () => Promise<void>;
  stop: () => void;
};

export const createMockPlugin = (options: MockPluginOptions): MockPlugin => {
  const {
    relayUrl,
    channel,
    documentName = 'Test Design',
    pageName = 'Page 1',
  } = options;

  let ws: WebSocket | null = null;

  const handleCommand = (
    command: string,
    _params: Record<string, unknown>,
  ): unknown => {
    if (command === 'get_document_info') {
      return {
        name: documentName,
        currentPage: { id: '0:1', name: pageName },
      };
    }

    return { error: `Unknown command: ${command}` };
  };

  const start = (): Promise<void> =>
    new Promise((resolve) => {
      ws = new WebSocket(relayUrl);

      ws.onopen = () => {
        ws!.send(JSON.stringify({ type: 'join', channel }));
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(String(event.data));

        if (data.type === 'system') {
          resolve();

          return;
        }

        if (
          data.type === 'broadcast' &&
          data.message &&
          data.message.command
        ) {
          const { id, command, params } = data.message;
          const result = handleCommand(command, params ?? {});

          ws!.send(JSON.stringify({
            type: 'message',
            channel,
            message: { id, result },
          }));
        }
      };
    });

  const stop = () => {
    if (ws) {
      ws.close();
      ws = null;
    }
  };

  return { start, stop };
};
```

- [ ] **Step 2: Write failing integration test**

```typescript
// test/integration/e2e-roundtrip.test.ts

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from 'bun:test';

import { startRelay, stopRelay } from '../../packages/relay/src/relay';
import { createFigmaClient } from '../../packages/server/src/figma-client';
import { handleConnect, handleStatus } from '../../packages/server/src/tools/session';
import { createMockPlugin } from '../mocks/mock-plugin';

const PORT = 3097;
const RELAY_URL = `ws://localhost:${PORT}`;
const CHANNEL = 'e2e-test';

describe('e2e roundtrip', () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let plugin: ReturnType<typeof createMockPlugin>;
  let client: ReturnType<typeof createFigmaClient>;

  beforeAll(async () => {
    relay = await startRelay(PORT);
    plugin = createMockPlugin({
      relayUrl: RELAY_URL,
      channel: CHANNEL,
      documentName: 'My Design File',
      pageName: 'Home',
    });

    await plugin.start();

    client = createFigmaClient(RELAY_URL);
  });

  afterAll(() => {
    client.disconnect();
    plugin.stop();
    stopRelay(relay);
  });

  test('connect tool joins channel', async () => {
    const result = await handleConnect({ channel: CHANNEL }, client);
    const text = result.content[0].text;

    expect(text).toContain(CHANNEL);
  });

  test('status tool returns connected', async () => {
    const result = await handleStatus(client);
    const text = result.content[0].text;

    expect(text).toContain('connected');
    expect(text).toContain(CHANNEL);
  });

  test('server can send command to mock plugin and get response', async () => {
    const result = await client.sendCommand('get_document_info');

    expect(result).toEqual({
      name: 'My Design File',
      currentPage: { id: '0:1', name: 'Home' },
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
bun test test/integration/
```
Expected: All 3 tests PASS.

- [ ] **Step 4: Run all tests**

```bash
bun test
```
Expected: All tests PASS (relay: 3, figma-client: 3, session: 3, e2e: 3 = 12 tests).

- [ ] **Step 5: Run full CI check**

```bash
bun run lint && bun run typecheck && bun test
```
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add test/
git commit -m "test: mock plugin and e2e integration tests for full roundtrip"
```

### ✅ Checkpoint 8
> **STOP.** Ask human to verify: all 12 tests pass (`bun test`), full CI check passes (`bun run lint && bun run typecheck && bun test`), e2e roundtrip proves server↔relay↔mock-plugin works. Do not proceed until approved.

---

## Task 9: Start Script & Documentation

**Files:**
- Create: `scripts/start-mcp.sh`
- Modify: `packages/server/package.json` (add bin)

- [ ] **Step 1: Create start script**

```bash
#!/bin/bash
# scripts/start-mcp.sh
# Starts relay (if not running) then MCP server

RELAY_PORT="${PORT:-3055}"

# Check if relay is already running
if ! lsof -i :"$RELAY_PORT" -sTCP:LISTEN > /dev/null 2>&1; then
  nohup bun run packages/relay/src/index.ts > /dev/null 2>&1 &
  RELAY_PID=$!

  # Wait for relay to be ready (max 5 seconds)
  for i in $(seq 1 50); do
    if lsof -i :"$RELAY_PORT" -sTCP:LISTEN > /dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

exec bun run packages/server/src/index.ts "$@"
```

```bash
chmod +x scripts/start-mcp.sh
```

- [ ] **Step 2: Commit**

```bash
git add scripts/ packages/server/package.json
git commit -m "feat: start-mcp.sh script for relay + server startup"
```

### ✅ Checkpoint 9 (Final)
> **STOP.** Ask human to verify: start-mcp.sh works (starts relay + server), M1 is complete. Do not proceed to M2 until approved.

---

## Summary

After completing all 9 tasks:

- **12+ tests** covering relay, figma-client, session tools, and e2e roundtrip
- **3 packages** with source code: shared, relay, server
- **1 Figma plugin** shell ready for manual testing
- **Full CI pipeline**: `bun run lint && bun run typecheck && bun test`
- **Start script** for easy MCP server launch

**Success criteria met:** Can run the MCP server, connect to a mock Figma plugin via relay, and get `status` returning document info.

**Next milestone:** M2: Read & Parse — add the server-side parsing layer and two-tier read system.
