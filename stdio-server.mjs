#!/usr/bin/env node
// engram → mcp stdio shim.
//
// the daemon is an http mcp server scoped by `?project=`, while a local coding tool
// launches a server with the project directory as cwd. this shim speaks mcp over
// stdio, resolves that cwd to its git root and forwards the scope, so configuring it
// once gives every directory its own namespace.
//
// point your host's mcp config at it:
//   { "mcpServers": { "engram": {
//       "command": "node",
//       "args": ["/path/to/engram/stdio-server.mjs"] } } }

import { createInterface } from 'node:readline';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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

/**
 * a worktree's `.git` is a file pointing into the primary repo, so scoping to the worktree
 * path would give every branch an empty namespace exactly when the convention is to work
 * in worktrees. canonicalize back to the primary working tree.
 */
function canonicalWorkspace(root) {
  try {
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return root;
    const commonDir = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!commonDir) return root;
    // `--git-common-dir` is the primary repo's .git directory; its parent is the
    // working tree whose namespace already holds this project's memories.
    const primary = dirname(resolve(root, commonDir));
    return primary && existsSync(join(primary, '.git')) ? primary : root;
  } catch {
    return root; // git unavailable: fall back to the resolved cwd
  }
}

const project = canonicalWorkspace(findProjectRoot(process.cwd()));
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

  // notifications are fire-and-forget: never respond to them
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
