import crypto from 'node:crypto'
import { exec, spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { TunnelClient } from './client.js'

const execPromise = promisify(exec)

export const CLI_NAME = 'traforo'
const DEFAULT_TUNNEL_ID_BYTES = 16

export function createRandomTunnelId(): string {
  return crypto.randomBytes(DEFAULT_TUNNEL_ID_BYTES).toString('hex')
}

export type RunTunnelOptions = {
  port: number
  tunnelId?: string
  localHost?: string
  baseDomain?: string
  serverUrl?: string
  command?: string[]
  /** Enable edge caching with optional partition key */
  cacheKey?: string
  /** Password to protect the tunnel */
  password?: string
  /** Kill any existing process on the port before starting */
  kill?: boolean
}

/**
 * Wait for a port to be available (accepting connections).
 * Used when spawning a child process to wait for the server to start.
 */
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

/**
 * Check if a port is currently in use (something is listening).
 */
async function isPortInUse(port: number, host = 'localhost'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, host)
  })
}

/**
 * Kill any process listening on the given port.
 * Cross-platform: uses lsof on macOS/Linux, netstat+taskkill on Windows.
 * Never throws — silently succeeds if no process is found or kill fails.
 */
async function killProcessOnPort(port: number): Promise<void> {
  try {
    const inUse = await isPortInUse(port)
    if (!inUse) {
      return
    }

    console.log(`Killing process on port ${port}...`)

    if (process.platform === 'win32') {
      // Windows: parse netstat output to find PIDs listening on the port
      const { stdout } = await execPromise(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
      )
      const pids = new Set<number>()
      for (const line of stdout.trim().split('\n')) {
        const parts = line.trim().split(/\s+/)
        const pid = parseInt(parts[parts.length - 1]!, 10)
        if (!isNaN(pid) && pid > 0) {
          pids.add(pid)
        }
      }
      for (const pid of pids) {
        try {
          await execPromise(`taskkill /PID ${pid} /F`)
        } catch {}
      }
    } else {
      // macOS / Linux: lsof returns PIDs listening on tcp port
      const { stdout } = await execPromise(`lsof -ti tcp:${port}`)
      const pids = stdout
        .trim()
        .split('\n')
        .map((s) => {
          return parseInt(s, 10)
        })
        .filter((n) => {
          return !isNaN(n) && n > 0
        })
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {}
      }
    }

    // Brief wait for the port to actually free up
    const maxWait = 3_000
    const start = Date.now()
    while (Date.now() - start < maxWait) {
      const stillInUse = await isPortInUse(port)
      if (!stillInUse) {
        console.log(`Port ${port} is now free`)
        return
      }
      await new Promise((r) => {
        return setTimeout(r, 200)
      })
    }

    // If SIGTERM didn't work on POSIX, try SIGKILL as last resort
    if (process.platform !== 'win32') {
      try {
        const { stdout } = await execPromise(`lsof -ti tcp:${port}`)
        const pids = stdout
          .trim()
          .split('\n')
          .map((s) => {
            return parseInt(s, 10)
          })
          .filter((n) => {
            return !isNaN(n) && n > 0
          })
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      } catch {}
    }
  } catch {
    // Never crash — if anything fails, just continue and let the
    // child process or port-wait logic surface the actual error
  }
}

/**
 * Parse argv to extract command after `--` separator.
 * Returns the command array and remaining argv without the command.
 */
export function parseCommandFromArgv(argv: string[]): {
  command: string[]
  argv: string[]
} {
  const dashDashIndex = argv.indexOf('--')

  if (dashDashIndex === -1) {
    return { command: [], argv }
  }

  return {
    command: argv.slice(dashDashIndex + 1),
    argv: argv.slice(0, dashDashIndex),
  }
}

/**
 * Run the tunnel, optionally spawning a child process first.
 */
export async function runTunnel(options: RunTunnelOptions): Promise<void> {
  const tunnelId = options.tunnelId || createRandomTunnelId()
  const localHost = options.localHost || 'localhost'
  const port = options.port

  // Kill existing process on port if requested
  if (options.kill) {
    await killProcessOnPort(port)
  }

  let child: ChildProcess | null = null

  // If command provided, spawn child process with PORT env
  if (options.command && options.command.length > 0) {
    const cmd = options.command[0]!
    const args = options.command.slice(1)

    console.log(`Starting: ${options.command.join(' ')}`)
    console.log(`PORT=${port}\n`)

    const spawnedChild = spawn(cmd, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(port),
        // Disable clear/animations for common tools without lying about CI
        FORCE_COLOR: '1',
        VITE_CLS: 'false',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    })
    child = spawnedChild

    spawnedChild.on('error', (err) => {
      console.error(`Failed to start command: ${err.message}`)
      process.exit(1)
    })

    spawnedChild.on('exit', (code) => {
      console.log(`\nCommand exited with code ${code}`)
      process.exit(code || 0)
    })

    // Wait for port to be available before connecting tunnel
    console.log(`Waiting for port ${port}...`)
    try {
      await waitForPort(port, localHost)
      console.log(`Port ${port} is ready!\n`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      spawnedChild.kill()
      process.exit(1)
    }
  }

  const client = new TunnelClient({
    localPort: port,
    tunnelId,
    localHost,
    ...(options.baseDomain && { baseDomain: options.baseDomain }),
    ...(options.serverUrl && { serverUrl: options.serverUrl }),
    ...(options.cacheKey && { cacheKey: options.cacheKey }),
    ...(options.password && { password: options.password }),
  })

  if (options.cacheKey) {
    console.log(
      `Edge caching enabled (key: ${options.cacheKey})`,
    )
  }

  if (options.password) {
    console.log(`Password protection enabled`)
  }

  // Handle shutdown
  const cleanup = () => {
    console.log('\nShutting down...')
    client.close()
    if (child) {
      child.kill()
    }
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  try {
    await client.connect()
  } catch (err) {
    console.error(
      'Failed to connect:',
      err instanceof Error ? err.message : String(err),
    )
    if (child) {
      child.kill()
    }
    process.exit(1)
  }
}
