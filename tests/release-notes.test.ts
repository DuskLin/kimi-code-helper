import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

const script = resolve('scripts/release-notes.mjs')
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'kimi-notes-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim()
  git('init', '-q')
  git('config', 'user.email', 'tests@example.invalid')
  git('config', 'user.name', 'Release Tests')
  const commit = (subject: string, file = 'src/renderer/App.tsx') => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true })
    writeFileSync(join(cwd, file), subject)
    git('add', '--', file)
    git('commit', '-qm', subject)
    return git('rev-parse', 'HEAD')
  }
  const generate = (tag: string, existing?: string) => {
    if (existing !== undefined) writeFileSync(join(cwd, 'existing.md'), existing)
    execFileSync(
      process.execPath,
      [
        script,
        '--tag',
        tag,
        '--repo',
        'owner/repo',
        '--output',
        'notes.md',
        ...(existing !== undefined ? ['--existing', 'existing.md'] : [])
      ],
      { cwd, stdio: 'pipe' }
    )
    return readFileSync(join(cwd, 'notes.md'), 'utf8')
  }
  return {
    cwd,
    git,
    commit,
    generate,
    cleanup: () => rmSync(cwd, { recursive: true, force: true })
  }
}

test('Chinese release notes cover only the target range, classify commits and preserve manual text', () => {
  const f = fixture()
  try {
    f.commit('feat: 旧版功能')
    f.git('tag', 'v0.1.0')
    const feature = f.commit('feat(ui): 新增主题设置')
    f.git('tag', 'v0.2.0-beta.1')
    f.commit('fix: fix loading\n\nRelease-Note-zh: 修复加载失败')
    f.commit('docs: add usage guide', 'docs/guide.md')
    f.git('tag', 'v0.2.0')
    f.commit('feat: 尚未发布的功能')
    const notes = f.generate('v0.2.0', '手写安装说明\n')
    assert.match(notes, /`v0.1.0` → `v0.2.0`/)
    assert.match(notes, /## 新增功能\n\n- 新增主题设置/)
    assert.match(notes, /## 问题修复\n\n- 修复加载失败/)
    assert.match(notes, /## 其他改进\n\n- 完善项目文档/)
    assert.ok(notes.includes(feature))
    assert.ok(notes.endsWith('手写安装说明\n'))
    assert.doesNotMatch(notes, /旧版功能|尚未发布的功能/)
    assert.equal(f.generate('v0.2.0', notes), notes)
    assert.throws(() => f.generate('v0.2.0', '<!-- kimi-release-notes:start -->broken'))
  } finally {
    f.cleanup()
  }
})

test('first release includes root commits and supports reviewed Chinese summaries', () => {
  const f = fixture()
  try {
    f.commit('feat: add updater', 'src/main/services/updates.ts')
    f.git('tag', 'v0.1.0')
    const notes = f.generate('v0.1.0')
    assert.match(notes, /首个版本/)
    assert.match(notes, /新增或扩展应用升级功能/)
    assert.match(notes, /## 问题修复\n\n- 本次无相关变更。/)
    mkdirSync(join(f.cwd, 'release-notes'))
    writeFileSync(
      join(f.cwd, 'release-notes/0.1.0.md'),
      '## 新增功能\n\n- 中文精确摘要。\n\n## 问题修复\n\n- 无。\n\n## 其他改进\n\n- 无。'
    )
    assert.match(f.generate('v0.1.0'), /中文精确摘要/)
    assert.throws(() => f.generate('v9.9.9'))
  } finally {
    f.cleanup()
  }
})
