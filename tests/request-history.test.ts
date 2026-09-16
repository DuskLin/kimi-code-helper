import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestHistory } from '../src/main/services/request-history'

test('请求记录永久落盘超过 100 条，重启可分页读取且新请求不打乱旧页游标', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-history-'))
  let history = new RequestHistory(join(dir, 'requests.sqlite'))
  try {
    for (let i = 0; i < 137; i++)
      history.append({
        id: String(i),
        time: i,
        group: '',
        account: 'account',
        model: 'k3',
        status: 200,
        attempts: 1,
        durationMs: 1234,
        firstTokenMs: 955,
        upstreamRequestId: `request-${i}`
      })
    history.close()
    history = new RequestHistory(join(dir, 'requests.sqlite'))
    const first = history.page()
    assert.equal(first.total, 137)
    assert.equal(first.records.length, 10)
    assert.equal(first.records[0].upstreamRequestId, 'request-136')
    history.append({ ...first.records[0], id: 'new' })
    const all = [...first.records]
    let cursor = first.nextCursor
    while (cursor) {
      const next = history.page(cursor)
      assert.ok(next.records.length <= 10)
      all.push(...next.records)
      cursor = next.nextCursor
    }
    assert.equal(all.at(-1)!.id, '0')
    assert.equal(new Set(all.map((r) => r.id)).size, 137)
    assert.equal(first.records[0].firstTokenMs, 955)
    assert.throws(() => history.page(-1))
    assert.throws(() => history.page(NaN))
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})
