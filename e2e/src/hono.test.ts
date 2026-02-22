import { describe, it, expect, afterAll } from 'vitest'
import { startFramework, fixtureDir, type E2EContext } from './harness.js'

describe('hono', () => {
  let ctx: E2EContext

  afterAll(async () => {
    await ctx?.cleanup()
  })

  it('serves through the tunnel', async () => {
    ctx = await startFramework({
      name: 'hono',
      command: ['node', 'server.js'],
      cwd: fixtureDir('hono-app'),
      localPort: 18003,
    })
    const res = await fetch(ctx.tunnelUrl)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('hello from hono')
  })
})
