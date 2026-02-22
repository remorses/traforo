import { describe, it, expect, afterAll } from 'vitest'
import { startFramework, fixtureDir, type E2EContext } from './harness.js'

describe('next', () => {
  let ctx: E2EContext

  afterAll(async () => {
    await ctx?.cleanup()
  })

  it('serves through the tunnel', async () => {
    ctx = await startFramework({
      name: 'next',
      command: ['next', 'dev', '--port', '18004'],
      cwd: fixtureDir('next-app'),
      localPort: 18004,
    })
    const res = await fetch(ctx.tunnelUrl)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('hello from next')
  })
})
