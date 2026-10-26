import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import * as errore from 'errore'
import { getLockfileDir } from './lockfile.ts'

const LICENSE_FILE_MODE = 0o600
const LICENSE_DIR_MODE = 0o700

class LicenseConfigError extends errore.createTaggedError({
  name: 'LicenseConfigError',
  message: '$reason. Run traforo login <key> to save your license.',
}) {}

type LicenseConfig = Record<string, { licenseKey: string }>

export function licenseServer(server?: string) {
  return errore.try({
    try: () => new URL(server || `wss://${process.env.TRAFORO_BASE_DOMAIN || 'traforo.dev'}`).toString().replace(/\/$/, ''),
    catch: cause => new LicenseConfigError({ reason: 'Invalid tunnel server URL', cause }),
  })
}

async function readConfig({ signal }: { signal: AbortSignal }): Promise<LicenseConfig | LicenseConfigError> {
  const raw = await fs.readFile(path.join(getLockfileDir(), 'config.json'), { encoding: 'utf8', signal }).catch(cause => {
    if (cause.code === 'ENOENT') return null
    return new LicenseConfigError({ reason: 'Cannot read saved licenses; check file permissions', cause })
  })
  if (raw instanceof Error) return raw
  if (raw === null) return {}

  const config = errore.try({
    try: () => JSON.parse(raw) as object | null,
    catch: cause => new LicenseConfigError({ reason: 'Saved licenses contain invalid JSON; remove the damaged config first', cause }),
  })
  if (config instanceof Error) return config
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return new LicenseConfigError({ reason: 'Saved licenses have an invalid format; remove the damaged config first' })
  }
  const licenses: LicenseConfig = {}
  for (const [server, entry] of Object.entries(config)) {
    if (!entry || typeof entry !== 'object' || typeof entry.licenseKey !== 'string' || !/^[\x21-\x7e]+$/.test(entry.licenseKey)) {
      return new LicenseConfigError({ reason: 'Saved licenses have an invalid key; remove the damaged config first' })
    }
    licenses[server] = { licenseKey: entry.licenseKey }
  }
  return licenses
}

export async function readLicense({ server, signal }: { server: string; signal: AbortSignal }) {
  const config = await readConfig({ signal })
  if (config instanceof Error) return config
  return config[server]?.licenseKey ?? null
}

export async function saveLicense({ server, key, signal }: { server: string; key: string; signal: AbortSignal }) {
  const licenseKey = key.trim()
  if (!/^[\x21-\x7e]+$/.test(licenseKey)) {
    return new LicenseConfigError({ reason: 'License key must be non-empty and contain no spaces or control characters' })
  }
  const config = await readConfig({ signal })
  if (config instanceof Error) return config

  const directory = getLockfileDir()
  const created = await fs.mkdir(directory, { recursive: true, mode: LICENSE_DIR_MODE }).catch(
    cause => new LicenseConfigError({ reason: 'Cannot create license directory; check file permissions', cause }),
  )
  if (created instanceof Error) return created

  const temporary = path.join(directory, `config-${crypto.randomUUID()}.tmp`)
  const contents = JSON.stringify({ ...config, [server]: { licenseKey } }, null, 2) + '\n'
  const written = await fs.writeFile(temporary, contents, { mode: LICENSE_FILE_MODE, flag: 'wx', signal }).catch(
    cause => new LicenseConfigError({ reason: 'Cannot save license; check file permissions', cause }),
  )
  const result = written instanceof Error ? written : await fs.rename(temporary, path.join(directory, 'config.json')).catch(
    cause => new LicenseConfigError({ reason: 'Cannot replace saved license; check file permissions', cause }),
  )
  if (result instanceof Error) {
    await fs.rm(temporary, { force: true }).catch(() => console.error('Could not remove temporary license config.'))
    return result
  }
  return null
}
