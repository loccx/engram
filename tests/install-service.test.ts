import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// drives scripts/install-service.sh in throwaway HOMEs, with launchctl and systemctl
// stubbed on PATH, so the scenarios that decide whether it can damage a real setup are
// covered here and not by hand.
// every stub dir carries a stub for every supervisor binary plus `uname` and `engram`:
// a missing one lets the real binary run, and a real `launchctl bootout` stops the
// machine's actual daemon.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(repoRoot, 'scripts', 'install-service.sh')
const MARKER = 'engram-generated-by-install-service.sh'

const LAUNCHCTL_STUB = `#!/bin/bash
echo "launchctl $*" >> "$STUB_LOG"
case "\${1:-}" in
  bootout|unload) rm -f "$STUB_STATE"; exit 0;;
  bootstrap|load) touch "$STUB_STATE"; exit 0;;
  print)
    if [ -f "$STUB_STATE" ]; then
      echo "gui/501/com.engram.daemon = { path = \${STUB_LOADED_PATH:-$3} }"
      exit 0
    fi
    exit 1;;
esac
exit 0
`
const SYSTEMCTL_STUB = `#!/bin/bash
echo "systemctl $*" >> "$STUB_LOG"
[ "\${1:-}" = "--user" ] && shift
case "\${1:-}" in
  is-active|is-enabled) exit 0;;
esac
exit 0
`
const UNAME_STUB = `#!/bin/bash
echo "\${STUB_UNAME:-Darwin}"
`
const ENGRAM_STUB = `#!/usr/bin/env node
console.log("0.2.0")
`

interface Scenario {
  root: string
  home: string
  binDir: string
  platform: 'Darwin' | 'Linux'
  logPath: string
  statePath: string
  plistPath: string
  unitPath: string
}

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeStub(dir: string, name: string, body: string): void {
  const file = join(dir, name)
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

/** a throwaway HOME plus stubbed supervisors; `platform` pins `uname` */
function scaffold(platform: 'Darwin' | 'Linux' = 'Darwin'): Scenario {
  const root = mkdtempSync(join(tmpdir(), 'engram-service-'))
  roots.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeStub(binDir, 'launchctl', LAUNCHCTL_STUB)
  writeStub(binDir, 'systemctl', SYSTEMCTL_STUB)
  writeStub(binDir, 'uname', UNAME_STUB)
  writeStub(binDir, 'engram', ENGRAM_STUB)
  return {
    root,
    home,
    binDir,
    platform,
    logPath: join(root, 'supervisor.log'),
    statePath: join(root, 'job.state'),
    plistPath: join(home, 'Library/LaunchAgents/com.engram.daemon.plist'),
    unitPath: join(home, '.config/systemd/user/engram.service'),
  }
}

/** a second stub dir with the same stubs, so ENTRY differs and the rendered file changes */
function addStubDir(s: Scenario, name: string): string {
  const dir = join(s.root, name)
  mkdirSync(dir, { recursive: true })
  writeStub(dir, 'launchctl', LAUNCHCTL_STUB)
  writeStub(dir, 'systemctl', SYSTEMCTL_STUB)
  writeStub(dir, 'uname', UNAME_STUB)
  writeStub(dir, 'engram', ENGRAM_STUB)
  return dir
}

/** every spawn goes through here: the stub dir is first on PATH and the platform is
 * pinned, so the real launchctl and systemctl can never run */
function stubEnv(s: Scenario, binDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: s.home,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    STUB_LOG: s.logPath,
    STUB_STATE: s.statePath,
    STUB_UNAME: s.platform,
    ...extra,
  }
}

function run(
  s: Scenario,
  args: string[] = [],
  extra: NodeJS.ProcessEnv = {}
): { status: number; output: string; calls: string[] } {
  const res = spawnSync('bash', [SCRIPT, ...args], {
    env: stubEnv(s, s.binDir, extra),
    encoding: 'utf8',
  })
  const calls = existsSync(s.logPath)
    ? readFileSync(s.logPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
    : []
  return { status: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}`, calls }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** a file's identity: replacing it changes the inode (and usually the mtime) */
function fileSignature(file: string): string {
  const st = statSync(file)
  return `${st.mtimeMs}:${st.ino}:${st.size}`
}

function verbs(calls: string[]): string[] {
  return calls.map((line) => line.split(' ').slice(0, 2).join(' '))
}

const FOREIGN_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.engram.daemon</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/hand/node</string>
		<string>/opt/hand/src/index.js</string>
		<string>start</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/bin:/bin</string>
		<key>ENGRAM_LLM_BASE_URL</key>
		<string>https://llm.example.internal/v1</string>
		<key>ENGRAM_LLM_MODEL</key>
		<string>internal-model</string>
		<key>ENGRAM_DIGEST_BUDGET_CHARS</key>
		<string>4000</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
`

function writeForeignPlist(s: Scenario): void {
  mkdirSync(dirname(s.plistPath), { recursive: true })
  writeFileSync(s.plistPath, FOREIGN_PLIST)
  writeFileSync(s.statePath, 'loaded') // the hand-written job is loaded and running
}

describe('scripts/install-service.sh safety', () => {
  it('writes an agent that passes plutil -lint, carries the marker, PATH and a throttle', () => {
    const s = scaffold()
    const { status, output, calls } = run(s)

    expect(status).toBe(0)
    expect(existsSync(s.plistPath)).toBe(true)
    // the stub was the launchctl that ran, never the real one
    expect(calls.length).toBeGreaterThan(0)
    expect(verbs(calls)).toContain('launchctl bootstrap')

    const plist = readFileSync(s.plistPath, 'utf8')
    expect(plist).toContain(MARKER)
    expect(plist).toContain('<key>PATH</key>')
    expect(plist).toContain('<key>ThrottleInterval</key>')
    expect(plist).toContain('<integer>15</integer>')
    if (process.platform === 'darwin') {
      const lint = spawnSync('plutil', ['-lint', s.plistPath], { encoding: 'utf8' })
      expect(`${lint.stdout}${lint.stderr}`).toContain('OK')
    }
    expect(output).toContain('Wrote:')
  }, 30_000)

  it('refuses to overwrite a hand-written plist it did not write, and prints what it found', () => {
    const s = scaffold()
    writeForeignPlist(s)
    const before = sha256(s.plistPath)

    const { status, output, calls } = run(s)

    expect(status).not.toBe(0)
    expect(sha256(s.plistPath)).toBe(before)
    // nothing was written and no supervisor was called: the running job is untouched
    expect(calls).toEqual([])
    expect(output).toContain('Found an existing file this script did not write')
    expect(output).toContain('ENGRAM_LLM_BASE_URL')
    expect(output).toContain('ENGRAM_LLM_MODEL')
    expect(output).toContain('ENGRAM_DIGEST_BUDGET_CHARS')
    expect(output).toContain(MARKER)
    expect(output).toContain('--force')
    // no backup was taken, since nothing was replaced
    expect(readdirSync(dirname(s.plistPath)).filter((f) => f.includes('.bak.'))).toEqual([])
  }, 30_000)

  it('--force backs the replaced file up, lists the dropped env keys and prints restore commands', () => {
    const s = scaffold()
    writeForeignPlist(s)

    const { status, output } = run(s, ['--force'])

    expect(status).toBe(0)
    const backups = readdirSync(dirname(s.plistPath)).filter((f) => f.includes('.bak.'))
    expect(backups).toHaveLength(1)
    const backup = join(dirname(s.plistPath), backups[0])
    // the backup is the original hand-written file, byte for byte
    expect(readFileSync(backup, 'utf8')).toBe(FOREIGN_PLIST)
    // the new file is the one this script wrote
    expect(readFileSync(s.plistPath, 'utf8')).toContain(MARKER)
    // the dropped-key report names exactly the keys the new file lacks
    expect(output).toContain('Environment variables dropped by the replacement')
    const droppedSection = output.split('Environment variables dropped by the replacement')[1] ?? ''
    const listed = droppedSection
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2))
    expect(listed.sort()).toEqual(['ENGRAM_DIGEST_BUDGET_CHARS', 'ENGRAM_LLM_BASE_URL', 'ENGRAM_LLM_MODEL'])
    // restore commands, ready to paste
    expect(output).toContain(backup)
    expect(output).toContain(`cp -p "${backup}"`)
    expect(output).toContain('launchctl bootstrap')
    // and it says it is stopping a job it did not start
    expect(output).toContain('--force given')
  }, 30_000)

  it('--force keeps the replaced file\'s mode (a 600 plist stays 600)', () => {
    const s = scaffold()
    writeForeignPlist(s)
    chmodSync(s.plistPath, 0o600)

    const { status } = run(s, ['--force'])

    expect(status).toBe(0)
    expect(statSync(s.plistPath).mode & 0o777).toBe(0o600)
  }, 30_000)

  it('never stops a job this script did not start, even when our own file is installed', () => {
    const s = scaffold()
    expect(run(s).status).toBe(0)
    const otherBin = addStubDir(s, 'bin2')
    writeFileSync(s.logPath, '')

    // the content changes, so a reload is due, but launchd
    // reports the loaded job came from somewhere else.
    const res = spawnSync('bash', [SCRIPT], {
      env: stubEnv(s, otherBin, { STUB_LOADED_PATH: '/opt/other/com.engram.daemon.plist' }),
      encoding: 'utf8',
    })
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
    const calls = readFileSync(s.logPath, 'utf8').split('\n').filter((l) => l.trim() !== '')

    expect(output).toContain('did not start it')
    expect(output).toContain('Not stopping it')
    expect(calls.some((c) => c.startsWith('launchctl print'))).toBe(true)
    expect(calls.some((c) => c.startsWith('launchctl bootout'))).toBe(false)
    expect(calls.some((c) => c.startsWith('launchctl bootstrap'))).toBe(false)
    expect(output).toContain('The file is installed, but the job that is running now was not started by this script.')
  }, 30_000)

  it('makes a byte-identical rerun a true no-op: file untouched, service not reloaded', () => {
    const s = scaffold()
    expect(run(s).status).toBe(0)
    const before = fileSignature(s.plistPath)
    const shaBefore = sha256(s.plistPath)
    writeFileSync(s.logPath, '')

    const { status, output, calls } = run(s)

    expect(status).toBe(0)
    expect(fileSignature(s.plistPath)).toBe(before)
    expect(sha256(s.plistPath)).toBe(shaBefore)
    expect(verbs(calls)).toEqual(['launchctl print'])
    expect(output).toContain('Unchanged:')
    expect(output).toContain('Nothing to do')
  }, 30_000)

  it('--uninstall removes exactly what it wrote and stops that job', () => {
    const s = scaffold()
    expect(run(s).status).toBe(0)
    writeFileSync(s.logPath, '')

    const { status, output, calls } = run(s, ['--uninstall'])

    expect(status).toBe(0)
    expect(existsSync(s.plistPath)).toBe(false)
    expect(calls.some((c) => c.startsWith('launchctl bootout'))).toBe(true)
    expect(output).toContain('Stopped and removed:')
  }, 30_000)

  it('--uninstall refuses a file it did not write, leaving it and its job alone', () => {
    const s = scaffold()
    writeForeignPlist(s)
    const before = sha256(s.plistPath)

    const { status, output, calls } = run(s, ['--uninstall'])

    expect(status).not.toBe(0)
    expect(existsSync(s.plistPath)).toBe(true)
    expect(sha256(s.plistPath)).toBe(before)
    expect(calls).toEqual([])
    expect(output).toContain('Refusing to stop or delete it')
    expect(output).toContain('--force')
  }, 30_000)

  it('renders a systemd unit with the marker and the crash guard', () => {
    const s = scaffold('Linux')

    const { status, calls } = run(s)
    // the stub systemctl ran; the real one never did
    expect(calls.every((c) => c.startsWith('systemctl'))).toBe(true)

    expect(status).toBe(0)
    expect(existsSync(s.unitPath)).toBe(true)
    const unit = readFileSync(s.unitPath, 'utf8')
    expect(unit).toContain(MARKER)
    expect(unit).toContain('StartLimitIntervalSec=60')
    expect(unit).toContain('StartLimitBurst=5')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('Environment=PATH=')
  }, 30_000)

  it('fails with a clear message when it cannot locate its own path (empty $0 and BASH_SOURCE)', () => {
    // fed through stdin, bash reports $0 as "bash" and BASH_SOURCE as empty
    // a naive dirname guard cd's into '.' and produces a misleading SCRIPT_DIR
    const s = scaffold()
    const res = spawnSync('bash', [], {
      input: readFileSync(SCRIPT, 'utf8'),
      env: stubEnv(s, s.binDir),
      encoding: 'utf8',
      cwd: s.root,
    })
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`

    expect(res.status).not.toBe(0)
    expect(output).toContain('does not exist')
    expect(output).toContain('Re-run the script by path')
    expect(existsSync(s.plistPath)).toBe(false)
  }, 30_000)
})
