import { describe, expect, test, afterEach } from 'vitest'
import { createRandomTunnelId, parseCommandFromArgv } from './run-tunnel.js'
import {
  writeLockfile,
  readLockfile,
  removeLockfile,
  isLockfileStale,
  type LockfileData,
} from './lockfile.js'

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
})

describe('lockfile', () => {
  // Use a high port unlikely to collide with real tunnels
  const TEST_PORT = 59_999

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
})
