// Entry point for the traforo docs website.
// Mounts holocron docs and adds /llms.txt and /gh redirect.

import { Spiceflow } from 'spiceflow'
import { app as holocronApp } from '@holocron.so/vite/app'
export const app = new Spiceflow()
  .get('/gh', ({ request }) => {
    return Response.redirect('https://github.com/remorses/traforo', 302)
  })
  .use(holocronApp)

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
}
