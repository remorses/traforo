#!/usr/bin/env node
import { goke } from 'goke'
import { createRequire } from 'node:module'
import { CLI_NAME, runTunnel, parseCommandFromArgv } from './run-tunnel.ts'
import { licenseServer, readLicense, saveLicense } from './license.ts'

const CONFIG_TIMEOUT_MS = 5_000
const packageJson = createRequire(import.meta.url)('../package.json') as { version: string }

const { command, argv } = parseCommandFromArgv(process.argv)

const cli = goke(CLI_NAME)

cli
  .command('', 'Expose a local port via tunnel')
  .option('-p, --port <port>', 'Local port to expose (optional when using -- command)')
  .option(
    '-t, --tunnel-id [id]',
    'Custom tunnel ID (only for services safe to expose publicly; prefer random default)',
  )
  .option('-h, --host [host]', 'Local host (default: localhost)')
  .option('-s, --server [url]', 'Tunnel server URL')
  .option(
    '-c, --cache [key]',
    'Enable edge caching for static assets (optional key for cache partitioning, default: "default")',
  )
  .option(
    '--password <password>',
    'Protect the tunnel with a password (visitors must enter it to access)',
  )
  .option(
    '-k, --kill',
    'Kill any existing process on the port before starting',
  )
  .example(`${CLI_NAME} -p 3000`)
  .example(`${CLI_NAME} -- next start`)
  .example(`${CLI_NAME} -- pnpm dev`)
  .example(`${CLI_NAME} -p 3000 -- next start`)
  .example(`${CLI_NAME} -p 5173 -t my-app -- vite`)
  .example(`${CLI_NAME} -p 3000 --cache`)
  .example(`${CLI_NAME} -p 3000 --cache v2`)
  .action(async (options) => {
    if (!options.port && command.length === 0) {
      console.error('Error: --port is required unless a command is provided after --')
      console.error(`\nUsage: ${CLI_NAME} [-p <port>] [-- command]`)
      process.exit(1)
    }

    if (options.kill && !options.port) {
      console.error('Error: --kill requires --port')
      process.exit(1)
    }

    let port: number | undefined
    if (options.port) {
      port = parseInt(options.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Error: Invalid port number: ${options.port}`)
        process.exit(1)
      }
    }

    // --cache bare (`''`) → 'default', --cache v2 → 'v2', omitted → undefined
    const cacheKey = options.cache === '' ? 'default' : options.cache || undefined

    const server = licenseServer(options.server)
    if (server instanceof Error) {
      console.error(server.message)
      process.exitCode = 1
      return
    }
    const licenseKey = process.env.TRAFORO_LICENSE_KEY || await readLicense({
      server,
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    })
    if (licenseKey instanceof Error) {
      console.error(licenseKey.message)
      process.exitCode = 1
      return
    }

    await runTunnel({
      port,
      tunnelId: options.tunnelId || undefined,
      localHost: options.host || undefined,
      serverUrl: options.server || undefined,
      command: command.length > 0 ? command : undefined,
      cacheKey,
      password: options.password,
      licenseKey: licenseKey || undefined,
      kill: options.kill,
    })
  })

cli
  .command('login <key>', 'Save your license key once for future tunnels. Buy one at https://traforo.dev/license')
  .option('-s, --server [url]', 'Tunnel server URL (must match the tunnel command)')
  .example('traforo login <key>')
  .action(async (key, options) => {
    const server = licenseServer(options.server)
    if (server instanceof Error) {
      console.error(server.message)
      process.exitCode = 1
      return
    }
    const result = await saveLicense({ server, key, signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) })
    if (result instanceof Error) {
      console.error(result.message)
      process.exitCode = 1
      return
    }
    console.log('License saved. Future tunnels use it automatically.')
  })

cli.help()
cli.completions()
cli.version(packageJson.version)

// Parse the modified argv (without the command after --)
await cli.parse(argv)
