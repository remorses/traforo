/**
 * E2E test harness for framework integration tests.
 *
 * Spawns a framework dev server as a child process, waits for its port,
 * connects a TunnelClient to the preview deployment, and returns a context
 * for making requests through the tunnel. Adapted from portless e2e harness
 * but uses traforo's TunnelClient instead of a local proxy.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Import TunnelClient from the parent traforo package via relative path.
// The e2e package is not published, so we reference the source directly.
import { TunnelClient } from '../../src/client.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const E2E_NODE_MODULES = path.resolve(__dirname, '../node_modules')

export type E2EContext = {
  tunnelUrl: string
  tunnelId: string
  localPort: number
  child: ChildProcess
  tunnelClient: TunnelClient
  stdout: string
  stderr: string
  cleanup: () => Promise<void>
}

export type StartFrameworkOptions = {
  /** Framework name (used for logging) */
  name: string
  /** Command to start the dev server, e.g. ["vite", "--port", "18001"] */
  command: string[]
  /** Working directory (fixture path) */
  cwd: string
  /** Local port the dev server will listen on */
  localPort: number
  /** Timeout for the dev server to become ready */
  timeoutMs?: number
  /** Extra env vars for the child process */
  env?: Record<string, string>
}

/** Resolve the absolute path to a fixture directory. */
export function fixtureDir(name: string): string {
  return path.resolve(__dirname, '../fixtures', name)
}

/**
 * Resolve binary path for a framework command inside traforo's node_modules.
 * Falls back to the command as-is if not found.
 */
function resolveBin(command: string, cwd: string): string {
  const local = path.join(cwd, 'node_modules', '.bin', command)
  if (fs.existsSync(local)) {
    return local
  }

  const e2eBin = path.join(E2E_NODE_MODULES, '.bin', command)
  if (fs.existsSync(e2eBin)) {
    return e2eBin
  }

  return command
}

/** Kill any process listening on the given TCP port (skips our own PID). */
function killPort(port: number): void {
  try {
    const pids = execSync(`lsof -ti tcp:${port}`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    if (pids) {
      const myPid = process.pid
      for (const raw of pids.split('\n')) {
        const pid = parseInt(raw, 10)
        if (isNaN(pid) || pid === myPid) {
          continue
        }
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // already dead
        }
      }
    }
  } catch {
    // no process on port
  }
}

/** Wait for a TCP port to accept connections. */
async function waitForPort(
  port: number,
  host = 'localhost',
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now()
  const checkInterval = 500

  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for port ${port} to be available`))
        return
      }

      const socket = new net.Socket()

      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })

      socket.once('error', () => {
        socket.destroy()
        setTimeout(check, checkInterval)
      })

      socket.connect(port, host)
    }

    check()
  })
}

/** Generate a unique tunnel ID for each test. */
export function getTunnelId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Start a framework dev server, connect a tunnel, and return a context
 * for making requests through the tunnel URL.
 */
export async function startFramework(
  opts: StartFrameworkOptions,
): Promise<E2EContext> {
  const {
    name,
    command,
    cwd,
    localPort,
    timeoutMs = 60_000,
    env: extraEnv,
  } = opts

  // Kill stale processes on the port from previous test runs
  killPort(localPort)

  const resolvedCmd = [resolveBin(command[0], cwd), ...command.slice(1)]

  const child = spawn(resolvedCmd[0], resolvedCmd.slice(1), {
    cwd,
    env: {
      ...process.env,
      PORT: String(localPort),
      NODE_PATH: E2E_NODE_MODULES,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      NEXT_TELEMETRY_DISABLED: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const tunnelId = getTunnelId()
  const tunnelUrl = `https://${tunnelId}-tunnel-preview.traforo.dev`
  const serverUrl = `wss://${tunnelId}-tunnel-preview.traforo.dev`

  const tunnelClient = new TunnelClient({
    localPort,
    tunnelId,
    serverUrl,
    autoReconnect: false,
  })

  const cleanup = async () => {
    tunnelClient.close()

    if (!child.killed) {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5000)
        child.on('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }

    killPort(localPort)
  }

  try {
    // Wait for the dev server to be ready
    await waitForPort(localPort, 'localhost', timeoutMs)

    // Connect the tunnel
    await tunnelClient.connect()

    // Let connection stabilize
    await new Promise((r) => {
      setTimeout(r, 500)
    })
  } catch (err) {
    await cleanup()
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `[${name}] ${msg}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    )
  }

  return {
    tunnelUrl,
    tunnelId,
    localPort,
    child,
    tunnelClient,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    cleanup,
  }
}
