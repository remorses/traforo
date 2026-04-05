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
  pid: number
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

export function removeLockfile(port: number): void {
  try {
    fs.unlinkSync(lockfilePath(port))
  } catch {
    // Already gone or never existed
  }
}

/**
 * Check if the PID in a lockfile is still alive.
 * Returns false (stale) if the process no longer exists.
 */
export function isLockfileStale(lock: LockfileData): boolean {
  try {
    // signal 0 doesn't kill — just checks if process exists
    process.kill(lock.pid, 0)
    return false
  } catch {
    return true
  }
}
