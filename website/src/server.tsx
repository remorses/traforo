// Entry point for the traforo docs website.
// Mounts holocron docs and adds /llms.txt, /gh and /license redirects.

import { Spiceflow } from 'spiceflow'
import { app as holocronApp } from '@holocron.so/vite/app'

// Clients print https://traforo.dev/license, so the checkout can change here.
const LICENSE_CHECKOUT_URL =
  'https://buy.polar.sh/polar_cl_EwKDFzNR8gzVhPX3Fni99sLJnFzLqsV3iaPtG0Pk1Ck'

export const app = new Spiceflow()
  .get('/gh', ({ request }) => {
    return Response.redirect('https://github.com/remorses/traforo', 302)
  })
  .get('/license', () => {
    return Response.redirect(LICENSE_CHECKOUT_URL, 302)
  })
  .use(holocronApp)

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
}
