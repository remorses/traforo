import { describe, expect, test, afterEach, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  createRandomTunnelId,
  detectPortFromText,
  parseCommandFromArgv,
} from './run-tunnel.js'
import {
  writeLockfile,
  readLockfile,
  removeLockfile,
  isLockfileStale,
  getLockfileDir,
  type LockfileData,
} from './lockfile.js'

const execFilePromise = promisify(execFile)

async function listenOnRandomPort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP server address'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

async function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function getTsxPath(): string {
  return path.resolve(
    process.platform === 'win32' ? 'node_modules/.bin/tsx.cmd' : 'node_modules/.bin/tsx',
  )
}

describe('run-tunnel security defaults', () => {
  test('generates a non-guessable default tunnel id with port suffix', () => {
    const ids = new Set(
      Array.from({ length: 32 }, () => {
        return createRandomTunnelId({ port: 3000 })
      }),
    )

    expect(ids.size).toBe(32)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{20}-3000$/)
    }
  })

  test('generates a non-guessable default tunnel id without port suffix when port is omitted', () => {
    const ids = new Set(
      Array.from({ length: 32 }, () => {
        return createRandomTunnelId()
      }),
    )

    expect(ids.size).toBe(32)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{20}$/)
    }
  })

  test('parses commands after dash dash without touching leading args', () => {
    const parsed = parseCommandFromArgv([
      'node',
      'traforo',
      '-p',
      '3000',
      '--',
      'pnpm',
      'dev',
    ])

    expect(parsed).toEqual({
      command: ['pnpm', 'dev'],
      argv: ['node', 'traforo', '-p', '3000'],
    })
  })

  test('detects a local port from common dev server output', () => {
    expect(detectPortFromText('Local: http://localhost:5173/')).toBe(5173)
    expect(detectPortFromText('ready on http://127.0.0.1:3000')).toBe(3000)
    expect(detectPortFromText('Server running at 0.0.0.0:4321')).toBe(4321)
  })

  test('ignores invalid or unrelated port-like output', () => {
    expect(detectPortFromText('listening on localhost:70000')).toBeNull()
    expect(detectPortFromText('some random log line')).toBeNull()
  })

  test('ignores Node.js inspector port lines', () => {
    expect(detectPortFromText('Default inspector port 9229 not available, using 9234 instead')).toBeNull()
    expect(detectPortFromText('Debugger listening on ws://127.0.0.1:9229')).toBeNull()
    expect(detectPortFromText('Debugger attached.')).toBeNull()
  })

  test('detects correct port when inspector noise appears before the real URL', () => {
    const output = [
      'Default inspector port 9229 not available, using 9234 instead',
      '',
      '  VITE v8.0.13  ready in 4535 ms',
      '',
      '  ➜  Local:   http://localhost:4173/',
    ].join('\n')
    expect(detectPortFromText(output)).toBe(4173)
  })

  test('ignores devtools and cpu-prof lines', () => {
    expect(detectPortFromText('DevTools listening on ws://127.0.0.1:9222')).toBeNull()
    expect(detectPortFromText('cpu-prof output saved to port 8080')).toBeNull()
  })

  test('ignores "port in use" lines and detects the actual port', () => {
    expect(detectPortFromText('Port 5173 is in use, trying another one...')).toBeNull()
    expect(detectPortFromText('Port 5174 is in use, trying another one...')).toBeNull()

    const viteOutput = [
      'Port 5173 is in use, trying another one...',
      'Port 5174 is in use, trying another one...',
      'Port 5175 is in use, trying another one...',
      '',
      '  VITE v8.0.11  ready in 814 ms',
      '',
      '  ➜  Local:   http://localhost:5176/',
    ].join('\n')
    expect(detectPortFromText(viteOutput)).toBe(5176)
  })
})

describe('lockfile', () => {
  const TEST_PORT = 59_999
  const testDir = path.resolve('tmp/test-traforo-lockfiles')

  const sampleLock: LockfileData = {
    tunnelId: 'abc123-59999',
    tunnelUrl: 'https://abc123-59999-tunnel.traforo.dev',
    port: TEST_PORT,
    tunnelPid: process.pid,
    serverPid: process.pid + 1,
    command: ['pnpm', 'dev'],
    cwd: '/tmp/test-project',
    startedAt: new Date().toISOString(),
  }

  beforeAll(() => {
    // Redirect lockfiles to a local tmp dir so tests don't touch ~/.traforo
    process.env.TRAFORO_HOME = testDir
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    delete process.env.TRAFORO_HOME
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    removeLockfile(TEST_PORT)
  })

  test('write then read round-trips lockfile data', () => {
    writeLockfile(TEST_PORT, sampleLock)
    const read = readLockfile(TEST_PORT)
    expect(read).toEqual(sampleLock)
  })

  test('readLockfile returns null for missing port', () => {
    const read = readLockfile(58_888)
    expect(read).toBeNull()
  })

  test('removeLockfile deletes the file', () => {
    writeLockfile(TEST_PORT, sampleLock)
    expect(readLockfile(TEST_PORT)).not.toBeNull()
    removeLockfile(TEST_PORT)
    expect(readLockfile(TEST_PORT)).toBeNull()
  })

  test('removeLockfile with matching tunnelPid deletes the file', () => {
    writeLockfile(TEST_PORT, sampleLock)
    removeLockfile(TEST_PORT, sampleLock.tunnelPid)
    expect(readLockfile(TEST_PORT)).toBeNull()
  })

  test('removeLockfile with wrong tunnelPid leaves the file', () => {
    writeLockfile(TEST_PORT, sampleLock)
    removeLockfile(TEST_PORT, 999_999) // not our PID
    expect(readLockfile(TEST_PORT)).not.toBeNull()
  })

  test('isLockfileStale returns false when tunnelPid is alive', () => {
    // Use current process PID which is guaranteed alive
    const lock = { ...sampleLock, tunnelPid: process.pid }
    expect(isLockfileStale(lock)).toBe(false)
  })

  test('isLockfileStale returns true when tunnelPid is dead', () => {
    // PID 2_000_000 is almost certainly not running
    const lock = { ...sampleLock, tunnelPid: 2_000_000 }
    expect(isLockfileStale(lock)).toBe(true)
  })

  test('TRAFORO_HOME env var overrides lockfile directory', () => {
    expect(getLockfileDir()).toBe(testDir)
    writeLockfile(TEST_PORT, sampleLock)
    // File should exist inside testDir, not ~/.traforo
    expect(fs.existsSync(path.join(testDir, `${TEST_PORT}.json`))).toBe(true)
  })

  test('occupied port guidance includes a restart command that preserves the tunnel id', async () => {
    const { server, port } = await listenOnRandomPort()
    const tunnelId = `existing-${port}`

    try {
      writeLockfile(port, {
        ...sampleLock,
        port,
        tunnelId,
        tunnelUrl: `https://${tunnelId}-tunnel.traforo.dev`,
        tunnelPid: process.pid,
        cwd: process.cwd(),
        startedAt: '2026-04-08T00:00:00.000Z',
      })

      const stderr = await execFilePromise(getTsxPath(), ['src/cli.ts', '-p', String(port), '--', 'pnpm', 'dev'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TRAFORO_HOME: testDir,
        },
      })
        .then(() => {
          throw new Error('Expected CLI to exit with a port conflict')
        })
        .catch((error: Error & { stderr?: string }) => {
          return error.stderr ?? ''
        })

      expect(stderr).toContain('The same command in the same directory is already tunneled.')
      expect(stderr).toContain(
        'If you want to restart it without changing the tunnel URL for existing consumers, run:',
      )
      expect(stderr).toContain(
        `traforo -p ${port} -t ${tunnelId} --kill -- pnpm dev`,
      )
    } finally {
      removeLockfile(port)
      await closeServer(server)
    }
  })
})
