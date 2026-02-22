import { describe, it, expect, afterAll } from 'vitest'
import { startFramework, fixtureDir, type E2EContext } from './harness.js'

describe('vite', () => {
  let ctx: E2EContext

  afterAll(async () => {
    await ctx?.cleanup()
  })

  it('serves through the tunnel', async () => {
    ctx = await startFramework({
      name: 'vite',
      command: ['vite', '--port', '18001'],
      cwd: fixtureDir('vite-app'),
      localPort: 18001,
    })
    const res = await fetch(ctx.tunnelUrl)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('hello from vite')
  })
})
