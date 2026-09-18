import test from 'node:test'
import assert from 'node:assert/strict'
import { DashboardPublicCheck, probeDashboard } from '../src/main/services/dashboard-public-check'

test('public probe verifies the unauthenticated origin without credentials or redirects', async () => {
  const request: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://quota.example.com/api/snapshot')
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.redirect, 'manual')
    return Response.json({ error: '请登录仪表盘' }, { status: 401 })
  }
  assert.equal(
    (await probeDashboard('https://quota.example.com', request, new AbortController().signal))
      .status,
    'reachable'
  )
  for (const response of [
    Response.json({}, { status: 200 }),
    Response.json({ error: 'other' }, { status: 401 }),
    new Response('bad', { status: 502 })
  ]) {
    assert.equal(
      (
        await probeDashboard(
          'https://quota.example.com',
          async () => response,
          new AbortController().signal
        )
      ).status,
      'unreachable'
    )
  }
})

test('public probe distinguishes Access, DNS failure and cancellation', async () => {
  assert.equal(
    (
      await probeDashboard(
        'https://quota.example.com',
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' }
          }),
        new AbortController().signal
      )
    ).status,
    'protected'
  )
  const failure = await probeDashboard(
    'https://quota.example.com',
    async () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED')
    },
    new AbortController().signal
  )
  assert.match(failure.message, /域名/)
  let complete!: (value: Response) => void
  const check = new DashboardPublicCheck(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  check.configure('https://quota.example.com', true)
  const pending = check.check()
  check.close()
  complete(Response.json({ error: '请登录仪表盘' }, { status: 401 }))
  await pending
  assert.equal(check.state.status, 'idle')
})
