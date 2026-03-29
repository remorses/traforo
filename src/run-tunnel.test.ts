import { describe, expect, test } from 'vitest'
import { createRandomTunnelId, parseCommandFromArgv } from './run-tunnel.js'

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
