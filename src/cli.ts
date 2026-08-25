#!/usr/bin/env node
import { goke } from 'goke'
import { CLI_NAME, runTunnel, parseCommandFromArgv } from './run-tunnel.js'

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
  .option('--url-template [template]', 'Public URL template containing one {id} placeholder')
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

    await runTunnel({
      port,
      tunnelId: options.tunnelId || undefined,
      localHost: options.host || undefined,
      serverUrl: options.server || undefined,
      urlTemplate: options.urlTemplate || undefined,
      command: command.length > 0 ? command : undefined,
      cacheKey,
      password: options.password,
      kill: options.kill,
    })
  })

cli.help()
cli.version('0.0.1')

// Parse the modified argv (without the command after --)
cli.parse(argv)
