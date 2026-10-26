import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { WebSocketServer } from 'ws'
import { readLicense, saveLicense } from './license.ts'

const execFileAsync = promisify(execFile)
const signal = AbortSignal.timeout(10_000)
const originalHome = process.env.TRAFORO_HOME
const directories: string[] = []

afterEach(async () => {
  if (originalHome === undefined) delete process.env.TRAFORO_HOME
  else process.env.TRAFORO_HOME = originalHome
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

test('saved licenses survive reload, stay private, and are isolated by server', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'traforo-license-'))
  directories.push(home)
  process.env.TRAFORO_HOME = home
  const server = 'wss://traforo.dev'
  const customServer = 'ws://127.0.0.1:45678'

  expect(await readLicense({ server, signal })).toBeNull()
  expect(await saveLicense({ server, key: 'traforo_first', signal })).not.toBeInstanceOf(Error)
  expect(await saveLicense({ server: customServer, key: 'custom_key', signal })).not.toBeInstanceOf(Error)
  expect(await saveLicense({ server, key: 'traforo_replacement', signal })).not.toBeInstanceOf(Error)
  expect(await readLicense({ server, signal })).toBe('traforo_replacement')
  expect(await readLicense({ server: customServer, signal })).toBe('custom_key')
  expect(await readLicense({ server: 'wss://other.example', signal })).toBeNull()
  expect(await saveLicense({ server, key: '\n ', signal })).toBeInstanceOf(Error)
  expect(await readLicense({ server, signal })).toBe('traforo_replacement')

  const configPath = path.join(home, 'config.json')
  expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
  expect(await fs.readdir(home)).toEqual(['config.json'])
  await fs.writeFile(configPath, '{invalid json')
  expect(await readLicense({ server, signal })).toBeInstanceOf(Error)
})

test('login saves once, later CLI processes send the key, env overrides it, and --license is gone', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'traforo-login-'))
  directories.push(home)
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected local WebSocket address')
  const serverUrl = `ws://127.0.0.1:${address.port}`
  const seenKeys: unknown[] = []
  server.on('connection', (socket, request) => {
    seenKeys.push(request.headers['x-traforo-license'])
    socket.close(4402, 'Test server ends connection after recording the key')
  })
  const env = { ...process.env, TRAFORO_HOME: home, TRAFORO_LICENSE_KEY: '', NO_PROXY: '*', TRAFORO_BASE_DOMAIN: 'traforo.dev' }
  const run = (args: string[], license = '') => execFileAsync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args],
    { env: { ...env, TRAFORO_LICENSE_KEY: license }, timeout: 10_000 },
  ).then(
    result => ({ ...result, code: 0 }),
    (error: Error & { stdout: string; stderr: string; code: number }) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
  )

  try {
    const login = await run(['login', 'traforo_saved_test_key', '--server', serverUrl])
    expect(login.code).toBe(0)
    expect(login.stdout + login.stderr).not.toContain('traforo_saved_test_key')
    const first = await run(['-p', '3000', '--server', serverUrl])
    expect(first.code).toBe(1)
    expect(first.stderr).toContain('traforo login <key>')
    await run(['-p', '3000', '--server', serverUrl], 'traforo_env_override')
    await run(['-p', '3000', '--server', serverUrl.replace('127.0.0.1', 'localhost')])
    const removedFlag = await run(['-p', '3000', '--license', 'old_key'])
    expect(removedFlag.code).not.toBe(0)
    expect(seenKeys).toEqual(['traforo_saved_test_key', 'traforo_env_override', undefined])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
