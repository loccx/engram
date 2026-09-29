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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const DAEMON = process.env.ENGRAM_DAEMON_URL ?? 'http://localhost:8888';

/**
 * a daemon bound with ENGRAM_ALLOW_NONLOCAL=1 requires a bearer token on every request,
 * and this shim is a client of it: read the env var, else the token file the cli writes
 */
function dataDir() {
  const override = process.env.ENGRAM_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'engram-nodejs');
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'engram-nodejs', 'Data');
  }
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'engram-nodejs');
}

function readToken() {
  const fromEnv = process.env.ENGRAM_AUTH_TOKEN;
  if (fromEnv !== undefined) return fromEnv.trim();
  const path = process.env.ENGRAM_AUTH_TOKEN_FILE?.trim() || join(dataDir(), 'auth.token');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

const TOKEN = readToken();

/** mcp 2026-07-28 mirrors the body's protocol fields into headers; a value that is not
 *  plain ascii travels base64-encoded in the spec's sentinel form */
function headerValue(value) {
  if (/^[\x20-\x7e]*$/.test(value) && !/^=\?base64\?.*\?=$/.test(value)) return value;
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function requestHeaders(msg) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const meta = msg?.params?._meta;
  const version = meta?.['io.modelcontextprotocol/protocolVersion'];
  if (typeof version !== 'string') return headers;
  headers['mcp-protocol-version'] = version;
  headers['mcp-method'] = String(msg.method ?? '');
  const name = msg?.params?.name ?? msg?.params?.uri;
  if (typeof name === 'string') headers['mcp-name'] = headerValue(name);
  return headers;
}

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
      headers: requestHeaders(msg),
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
