import { describe, it, expect, afterAll } from 'vitest'
import { startFramework, fixtureDir, type E2EContext } from './harness.js'

describe('remix (react-router v7)', () => {
  let ctx: E2EContext

  afterAll(async () => {
    await ctx?.cleanup()
  })

  it('serves through the tunnel', async () => {
    ctx = await startFramework({
      name: 'remix',
      command: ['react-router', 'dev', '--port', '18008'],
      cwd: fixtureDir('remix-app'),
      localPort: 18008,
    })
    const res = await fetch(ctx.tunnelUrl)
    expect(res.status).toBe(200)
    const body = await res.text()
    // react-router injects __reactRouterContext into the page
    expect(body).toContain('__reactRouterContext')
  })
})
