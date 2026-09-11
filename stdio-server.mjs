#!/usr/bin/env node
// engram → MCP stdio shim.
//
// The engram daemon is an HTTP MCP server that scopes memory by `?project=`.
// This shim speaks MCP over stdio (the transport every local coding tool
// launches with the *project directory as cwd*), resolves that cwd to its git
// root, and forwards to the daemon with the right ?project=. Result: configure
// it once globally, drop into any directory, and that directory gets its own
// fresh memory namespace automatically.
//
// Configure in your tool's MCP settings (e.g. ~/.claude/settings.json):
//   { "mcpServers": { "engram": {
//       "command": "/Users/locc/.nvm/versions/node/v24.19.0/bin/node",
//       "args": ["/Users/locc/git/research/engram/stdio-server.mjs"] } } }

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DAEMON = process.env.ENGRAM_DAEMON_URL ?? 'http://localhost:8888';

function findProjectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    // .git may be a directory (normal) or a file (worktree)
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

const project = findProjectRoot(process.cwd());
process.stderr.write(`[engram-stdio] project=${project}\n`);

async function forward(msg) {
  const url = `${DAEMON}/mcp?project=${encodeURIComponent(project)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    });
    return await res.json();
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id: msg && msg.id !== undefined ? msg.id : null,
      error: {
        code: -32603,
        message:
          `engram daemon unreachable at ${DAEMON}: ${e.message}. ` +
          'It should auto-start via launchd (com.engram.daemon). Check `launchctl list | grep engram`.',
      },
    };
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const s = (line ?? '').trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return; // ignore unparseable lines
  }

  // Notifications are fire-and-forget; never respond to them.
  if (msg && msg.method && String(msg.method).startsWith('notifications/')) return;

  forward(msg)
    .then((out) => {
      if (out && (msg.id !== undefined || out.id !== undefined)) {
        process.stdout.write(JSON.stringify(out) + '\n');
      }
    })
    .catch((e) => {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id !== undefined ? msg.id : null,
          error: { code: -32603, message: String(e) },
        }) + '\n',
      );
    });
});
