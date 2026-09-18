import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedRendererUrl } from '../src/main/services/renderer-trust'

test('Windows renderer accepts equivalent file URL encoding in short paths and spaced install directories', () => {
  const file = String.raw`C:\Users\RUNNER~1\installed app\resources\app.asar\out\renderer\index.html`
  const url = 'file:///C:/Users/RUNNER~1/installed%20app/resources/app.asar/out/renderer/index.html'
  assert.equal(isTrustedRendererUrl(url, file, undefined, true), true)
  assert.equal(
    isTrustedRendererUrl(url.replace('~', '%7E') + '#settings', file, undefined, true),
    true
  )
  for (const untrusted of [
    url.replace('index.html', 'other.html'),
    url + '?untrusted=1',
    url.replace('file:///', 'https://example.com/'),
    url.replace('RUNNER~1', 'RUNNER%2F1'),
    'file://remote/C:/Users/RUNNER~1/installed%20app/resources/app.asar/out/renderer/index.html',
    'not a URL'
  ])
    assert.equal(isTrustedRendererUrl(untrusted, file, undefined, true), false, untrusted)
})

test('POSIX renderer remains restricted to its exact file and development to its origin', () => {
  const file = '/Applications/Navo ~ test/app.asar/out/renderer/index.html'
  const url = 'file:///Applications/Navo%20~%20test/app.asar/out/renderer/index.html'
  assert.equal(isTrustedRendererUrl(url + '#settings', file, undefined, false), true)
  assert.equal(
    isTrustedRendererUrl(url.replace('index.html', 'other.html'), file, undefined, false),
    false
  )
  assert.equal(
    isTrustedRendererUrl('http://localhost:5173/settings', file, 'http://localhost:5173'),
    true
  )
  assert.equal(isTrustedRendererUrl('http://localhost:5174/', file, 'http://localhost:5173'), false)
})
