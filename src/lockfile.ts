/**
 * Port lockfile management for traforo tunnels.
 *
 * Stores one JSON file per active tunnel port in ~/.traforo/{port}.json.
 * Used to detect port conflicts, show tunnel info in error messages,
 * and let agents reuse existing tunnels instead of killing them.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LOCKFILE_DIR = path.join(os.homedir(), '.traforo')

export type LockfileData = {
  tunnelId: string
  tunnelUrl: string
  port: number
  /** PID of the traforo tunnel process (used for liveness checks) */
  tunnelPid: number
  /** PID of the child server process, if any */
  serverPid?: number
  command: string[] | undefined
  cwd: string
  startedAt: string
}

function lockfilePath(port: number): string {
  return path.join(LOCKFILE_DIR, `${port}.json`)
}

export function writeLockfile(port: number, data: LockfileData): void {
  try {
    fs.mkdirSync(LOCKFILE_DIR, { recursive: true })
    fs.writeFileSync(lockfilePath(port), JSON.stringify(data, null, 2) + '\n')
  } catch {
    // Non-critical — don't crash if we can't write the lockfile
  }
}

export function readLockfile(port: number): LockfileData | null {
  try {
    const raw = fs.readFileSync(lockfilePath(port), 'utf-8')
    return JSON.parse(raw) as LockfileData
  } catch {
    return null
  }
}

/**
 * Remove lockfile only if it belongs to this traforo instance.
 * Prevents a late-exiting old process from deleting a newer instance's lockfile.
 */
export function removeLockfile(
  port: number,
  expectedTunnelPid?: number,
): void {
  try {
    if (expectedTunnelPid != null) {
      const lock = readLockfile(port)
      if (lock && lock.tunnelPid !== expectedTunnelPid) {
        return // not ours — leave it alone
      }
    }
    fs.unlinkSync(lockfilePath(port))
  } catch {
    // Already gone or never existed
  }
}

/**
 * Check if the tunnel process in a lockfile is still alive.
 * Uses tunnelPid (the traforo process) not serverPid, because
 * the tunnel URL is only valid while the traforo process is running.
 * Returns true (stale) if the tunnel process no longer exists.
 */
export function isLockfileStale(lock: LockfileData): boolean {
  try {
    // signal 0 doesn't kill — just checks if process exists
    process.kill(lock.tunnelPid, 0)
    return false
  } catch {
    return true
  }
}
