import crypto from 'node:crypto'
import { exec, spawn, type ChildProcess } from 'node:child_process'
// NOTE: We intentionally use spawn (not spawnSync) for child processes and
// forward SIGINT/SIGTERM/SIGHUP to the child, waiting for it to exit before
// calling process.exit(). This prevents orphan processes.
import net from 'node:net'
import { promisify } from 'node:util'
import { TunnelClient } from './client.js'
import {
  writeLockfile,
  readLockfile,
  removeLockfile,
  isLockfileStale,
} from './lockfile.js'

const execPromise = promisify(exec)

export const CLI_NAME = 'traforo'

/**
 * Shell-quote an argument array so the suggested command is copy-pasteable.
 * Wraps args in single quotes if they contain shell-special characters.
 */
function shellQuote(args: string[]): string {
  return args
    .map((arg) => {
      if (arg === '') return "''"
      // Safe chars that don't need quoting
      if (/^[a-zA-Z0-9._\-/:=@]+$/.test(arg)) return arg
      // Wrap in single quotes, escaping any inner single quotes
      return "'" + arg.replace(/'/g, "'\\''") + "'"
    })
    .join(' ')
}

const DEFAULT_TUNNEL_ID_BYTES = 10

export function createRandomTunnelId({ port }: { port?: number } = {}): string {
  const randomId = crypto.randomBytes(DEFAULT_TUNNEL_ID_BYTES).toString('hex')
  if (!port) {
    return randomId
  }
  return `${randomId}-${port}`
}

export type RunTunnelOptions = {
  port?: number
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

const LOCAL_PORT_PATTERNS = [
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{1,5})/i,
  /\blistening(?:\s+at|\s+on)?\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{1,5})/i,
  /\bport\s+(\d{1,5})\b/i,
]

// Lines matching these patterns are noise from debug/inspector/profiler
// output, not dev server "ready" messages. Skip them to avoid detecting
// the wrong port (e.g. "Default inspector port 9229 not available").
// Patterns are intentionally specific to avoid false negatives on
// legitimate lines like "Debug server listening on http://localhost:4173".
const IGNORED_LINE_PATTERNS = [
  /\binspector\b.*\bport\b/i,
  /\bdebugger (?:listening|attached)\b/i,
  /\bdevtools listening\b/i,
  /\bcpu[- ]?prof\b/i,
]

export function detectPortFromText(text: string): number | null {
  // Process line by line so we can skip noisy lines before pattern-matching.
  const lines = text.split('\n')
  for (const line of lines) {
    if (IGNORED_LINE_PATTERNS.some((p) => p.test(line))) continue
    for (const pattern of LOCAL_PORT_PATTERNS) {
      const match = line.match(pattern)
      const port = Number(match?.[1])
      if (port >= 1 && port <= 65535) {
        return port
      }
    }
  }
  return null
}

/**
 * Wait for a port to be available (accepting connections).
 * Used when spawning a child process to wait for the server to start.
 */
async function waitForPort(
  port: number,
  host = 'localhost',
  timeoutMs = 120_000,
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

async function detectPortFromProcessOutput(
  child: ChildProcess,
  timeoutMs = 120_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false
    let outputBuffer = ''

    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', handleExit)
      child.off('error', handleError)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
    }

    const finish = (value: number) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const scanChunk = (chunk: Buffer | string) => {
      outputBuffer += chunk.toString()
      if (outputBuffer.length > 8_000) {
        outputBuffer = outputBuffer.slice(-8_000)
      }
      const detectedPort = detectPortFromText(outputBuffer)
      if (detectedPort) {
        finish(detectedPort)
      }
    }

    const handleExit = (code: number | null) => {
      fail(new Error(`Command exited with code ${code} before a local port was detected`))
    }

    const handleError = (error: Error) => {
      fail(error)
    }

    const onStdout = (chunk: Buffer | string) => {
      scanChunk(chunk)
    }

    const onStderr = (chunk: Buffer | string) => {
      scanChunk(chunk)
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)

    const timeout = setTimeout(() => {
      fail(new Error('Timeout waiting for command output to reveal a local port'))
    }, timeoutMs)

    child.on('exit', handleExit)
    child.on('error', handleError)
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
  const localHost = options.localHost || 'localhost'
  if (!options.port && !options.command?.length) {
    console.error('Error: --port is required unless a command is provided after --')
    process.exit(1)
  }

  if (options.kill && !options.port) {
    console.error('Error: --kill requires --port')
    process.exit(1)
  }

  let port = options.port
  const tunnelId = options.tunnelId || createRandomTunnelId({ port })

  // Kill existing process on port if requested
  if (options.kill && port) {
    await killProcessOnPort(port)

    // Verify the port actually freed up before removing the lockfile
    if (await isPortInUse(port, localHost)) {
      console.error(`Error: Port ${port} is still in use after --kill.`)
      console.error(`The process may require elevated permissions to terminate.`)
      process.exit(1)
    }

    removeLockfile(port) // no ownership check — --kill is intentional
  }

  // Pre-flight: detect port conflict before spawning the child process
  if (port && options.command && options.command.length > 0 && !options.kill) {
    const portBusy = await isPortInUse(port, localHost)
    if (portBusy) {
      const lock = readLockfile(port)
      if (lock && !isLockfileStale(lock)) {
        const currentCwd = process.cwd()
        const currentCmd = options.command
        const restartCommand = `${CLI_NAME} -p ${port} -t ${lock.tunnelId} --kill -- ${shellQuote(currentCmd)}`
        const sameCwd = lock.cwd === currentCwd
        const sameCmd =
          lock.command &&
          lock.command.length === currentCmd.length &&
          lock.command.every((arg, i) => arg === currentCmd[i])

        if (sameCwd && sameCmd) {
          // Same command in same directory — tell agent to reuse the tunnel
          console.error(`Error: Port ${port} is already in use\n`)
          console.error(`  Tunnel:  ${lock.tunnelUrl}`)
          console.error(`  ID:      ${lock.tunnelId}`)
          console.error(`  Command: ${lock.command ? shellQuote(lock.command) : 'unknown'}`)
          console.error(`  Dir:     ${lock.cwd}`)
          console.error(`  PID:     ${lock.tunnelPid}`)
          console.error(`  Started: ${lock.startedAt}\n`)
          console.error(
            `The same command in the same directory is already tunneled.`,
          )
          console.error(`Reuse the tunnel URL above instead of creating a new one.`)
          console.error(
            `If you want to restart it without changing the tunnel URL for existing consumers, run:`,
          )
          console.error(`  ${restartCommand}`)
          process.exit(1)
        } else {
          // Different command or directory — suggest --kill or reuse
          console.error(`Error: Port ${port} is already in use\n`)
          console.error(`  Tunnel:  ${lock.tunnelUrl}`)
          console.error(`  ID:      ${lock.tunnelId}`)
          console.error(`  Command: ${lock.command ? shellQuote(lock.command) : 'unknown'}`)
          console.error(`  Dir:     ${lock.cwd}`)
          console.error(`  PID:     ${lock.tunnelPid}`)
          console.error(`  Started: ${lock.startedAt}\n`)
          console.error(
            `Use --kill to terminate the existing process and reuse the tunnel URL:`,
          )
          console.error(`  ${restartCommand}`)
          process.exit(1)
        }
      } else {
        // Port busy but no lockfile or stale lockfile — unknown process
        if (lock) removeLockfile(port)
        console.error(`Error: Port ${port} is already in use by another process.\n`)
        console.error(`Use --kill to terminate it before starting:`)
        console.error(`  traforo -p ${port} --kill -- ${shellQuote(options.command)}`)
        process.exit(1)
      }
    }
  }

  let child: ChildProcess | null = null

  /**
   * Send a signal to the child process and wait for it to exit.
   * Falls back to SIGKILL after 5 seconds if the child doesn't exit gracefully.
   */
  function killChild(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!child || child.killed) return Promise.resolve()
    const c = child
    return new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (!c.killed) c.kill('SIGKILL')
        resolve()
      }, 5_000)
      forceKillTimer.unref()
      c.on('exit', () => {
        clearTimeout(forceKillTimer)
        resolve()
      })
      c.kill(signal)
    })
  }

  // Compute tunnel URL early so it can be injected into the child env
  const baseDomain = options.baseDomain || 'traforo.dev'
  const tunnelUrl = `https://${tunnelId}-tunnel.${baseDomain}`

  // If command provided, spawn child process with PORT env
  if (options.command && options.command.length > 0) {
    const cmd = options.command[0]!
    const args = options.command.slice(1)

    console.log(`Starting: ${shellQuote(options.command)}`)
    if (port) {
      console.log(`PORT=${port}`)
    } else {
      console.log('Waiting for command output to reveal the local port...')
    }
    console.log('')

    const spawnedChild = spawn(cmd, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(port ? { PORT: String(port) } : {}),
        TRAFORO_URL: tunnelUrl,
        // Let wrangler dev pass parent env vars (including TRAFORO_URL) as
        // worker bindings so process.env.TRAFORO_URL works inside workerd.
        // Only effective when no .dev.vars file exists.
        CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
        // Disable clear/animations for common tools without lying about CI
        FORCE_COLOR: '1',
        VITE_CLS: 'false',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    })
    child = spawnedChild

    spawnedChild.stdout?.pipe(process.stdout)
    spawnedChild.stderr?.pipe(process.stderr)

    spawnedChild.on('error', (err) => {
      console.error(`Failed to start command: ${err.message}`)
      process.exit(1)
    })

    spawnedChild.on('exit', (code) => {
      console.log(`\nCommand exited with code ${code}`)
      if (port) {
        removeLockfile(port, process.pid)
      }
      process.exit(code || 0)
    })

    try {
      if (!port) {
        port = await detectPortFromProcessOutput(spawnedChild)
        console.log(`\nDetected local port ${port}`)
      }

      if (!port) {
        throw new Error('Failed to determine local port')
      }

      console.log(`Waiting for port ${port}...`)
      await waitForPort(port, localHost)
      console.log(`Port ${port} is ready!\n`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      await killChild()
      process.exit(1)
    }
  }

  if (!port) {
    console.error('Error: Failed to determine local port')
    process.exit(1)
  }

  const client = new TunnelClient({
    localPort: port,
    tunnelId,
    localHost,
    ...(options.baseDomain && { baseDomain: options.baseDomain }),
    ...(options.serverUrl && { serverUrl: options.serverUrl }),
    ...(options.cacheKey && { cacheKey: options.cacheKey }),
    ...(options.password && { password: options.password }),
    onFatalError: (err) => {
      console.error(`\nError: ${err.message}`)
      killChild().then(() => process.exit(1))
    },
  })

  if (options.cacheKey) {
    console.log(
      `Edge caching enabled (key: ${options.cacheKey})`,
    )
  }

  if (options.password) {
    console.log(`Password protection enabled`)
  }

  // Handle shutdown — forward signal to child process and wait for it to exit
  // before exiting ourselves, so we never leave orphan processes.
  let cleaningUp = false
  const cleanup = (signal: NodeJS.Signals) => {
    if (cleaningUp) return
    cleaningUp = true

    console.log('\nShutting down...')
    removeLockfile(port, process.pid)
    client.close()
    killChild(signal).then(() => process.exit(0))
  }

  process.on('SIGINT', () => cleanup('SIGINT'))
  process.on('SIGTERM', () => cleanup('SIGTERM'))
  process.on('SIGHUP', () => cleanup('SIGHUP'))

  try {
    await client.connect()

    // Write lockfile so other traforo instances can detect this tunnel
    writeLockfile(port, {
      tunnelId,
      tunnelUrl: client.url,
      port,
      tunnelPid: process.pid,
      serverPid: child?.pid,
      command: options.command,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error(
      'Failed to connect:',
      err instanceof Error ? err.message : String(err),
    )
    await killChild()
    process.exit(1)
  }
}
