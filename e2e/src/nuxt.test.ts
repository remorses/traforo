import { describe, it, expect, afterAll } from 'vitest'
import { startFramework, fixtureDir, type E2EContext } from './harness.js'

describe('nuxt', () => {
  let ctx: E2EContext

  afterAll(async () => {
    await ctx?.cleanup()
  })

  it('serves through the tunnel', async () => {
    ctx = await startFramework({
      name: 'nuxt',
      command: ['nuxt', 'dev', '--port', '18007'],
      cwd: fixtureDir('nuxt-app'),
      localPort: 18007,
    })
    const res = await fetch(ctx.tunnelUrl)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('hello from nuxt')
  })
})
