import { describe, expect, test } from 'vitest'
import {
  appendQueryParamPreservingFormatting,
  extractTunnelId,
  removeQueryParamPreservingFormatting,
} from './tunnel.js'

describe('extractTunnelId', () => {
  test.each([
    ['abc.tunnel.shuv.bot', 'abc'],
    ['abc-tunnel.shuv.bot', 'abc'],
    ['abc-tunnel.kimaki.dev', 'abc'],
    ['abc-tunnel-preview.traforo.dev', 'abc'],
  ])('extracts %s', (host, expected) => {
    expect(extractTunnelId(host)).toBe(expected)
  })

  test.each(['tunnel.shuv.bot', 'abc.shuv.bot', 'abc.tunnel.', 'example.com'])(
    'rejects %s',
    (host) => {
      expect(extractTunnelId(host)).toBeNull()
    },
  )
})

describe('query string preservation', () => {
  test('appends internal params without rewriting bare flags', () => {
    const url =
      'https://example.com/@fs/Users/morse/file.ttf?import&url&inline'

    expect(
      appendQueryParamPreservingFormatting(url, '_tunnelId', 'abc123'),
    ).toBe(
      'https://example.com/@fs/Users/morse/file.ttf?import&url&inline&_tunnelId=abc123',
    )
  })

  test('removes internal params without rewriting bare flags', () => {
    const url =
      'https://example.com/@fs/Users/morse/file.ttf?import&url&inline&_tunnelId=abc123'

    expect(removeQueryParamPreservingFormatting(url, '_tunnelId')).toBe(
      'https://example.com/@fs/Users/morse/file.ttf?import&url&inline',
    )
  })

  test('removes the internal param cleanly when it is the only query param', () => {
    expect(
      removeQueryParamPreservingFormatting(
        'https://example.com/path?_tunnelId=abc123',
        '_tunnelId',
      ),
    ).toBe('https://example.com/path')
  })

  test('removeQueryParamPreservingFormatting preserves unrelated query params', () => {
    expect(
      removeQueryParamPreservingFormatting(
        'https://example.com/path?foo=1&_tunnelId=abc123&bar=2',
        '_tunnelId',
      ),
    ).toMatchInlineSnapshot(
      '"https://example.com/path?foo=1&bar=2"',
    )
  })

  test('removeQueryParamPreservingFormatting removes bare flag form', () => {
    expect(
      removeQueryParamPreservingFormatting(
        'https://example.com/path?import&_tunnelId&inline',
        '_tunnelId',
      ),
    ).toMatchInlineSnapshot('"https://example.com/path?import&inline"')
  })

  test('removeQueryParamPreservingFormatting removes duplicate params', () => {
    expect(
      removeQueryParamPreservingFormatting(
        'https://example.com/path?_tunnelId=first&foo=1&_tunnelId=second',
        '_tunnelId',
      ),
    ).toMatchInlineSnapshot('"https://example.com/path?foo=1"')
  })

  test('removeQueryParamPreservingFormatting leaves similar param names intact', () => {
    expect(
      removeQueryParamPreservingFormatting(
        'https://example.com/path?_tunnelIdExtra=keep&_tunnelId=drop',
        '_tunnelId',
      ),
    ).toMatchInlineSnapshot('"https://example.com/path?_tunnelIdExtra=keep"')
  })

  test('removeQueryParamPreservingFormatting preserves hash fragments', () => {
    expect(
      removeQueryParamPreservingFormatting(
        'https://example.com/path?foo=1&_tunnelId=abc123#section-2',
        '_tunnelId',
      ),
    ).toMatchInlineSnapshot('"https://example.com/path?foo=1#section-2"')
  })

  test('removeQueryParamPreservingFormatting leaves URLs without the param unchanged', () => {
    expect(
      removeQueryParamPreservingFormatting(
        'https://example.com/path?foo=1&bar=2',
        '_tunnelId',
      ),
    ).toMatchInlineSnapshot('"https://example.com/path?foo=1&bar=2"')
  })

  test('removeQueryParamPreservingFormatting leaves URLs without a query string unchanged', () => {
    expect(
      removeQueryParamPreservingFormatting('https://example.com/path', '_tunnelId'),
    ).toMatchInlineSnapshot('"https://example.com/path"')
  })
})
