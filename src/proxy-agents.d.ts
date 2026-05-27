/**
 * Minimal module declarations for proxy agent packages used by traforo.
 */

declare module 'https-proxy-agent' {
  import http from 'node:http'

  export class HttpsProxyAgent<Uri extends string = string> extends http.Agent {
    constructor(proxy: Uri)
  }
}

declare module 'socks-proxy-agent' {
  import http from 'node:http'

  export class SocksProxyAgent extends http.Agent {
    constructor(proxy: string)
  }
}
