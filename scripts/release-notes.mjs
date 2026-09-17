import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    tag: { type: 'string' },
    repo: { type: 'string' },
    output: { type: 'string' },
    existing: { type: 'string' }
  }
})
const versionPattern = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
if (
  !versionPattern.test(values.tag ?? '') ||
  !/^[\w.-]+\/[\w.-]+$/.test(values.repo ?? '') ||
  !values.output
)
  throw new Error(
    'Usage: node scripts/release-notes.mjs --tag v1.2.3 --repo owner/repo --output notes.md [--existing body.md]'
  )
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
if (git('rev-parse', '--is-shallow-repository') === 'true')
  throw new Error('Release notes require full Git history (fetch-depth: 0)')
const tag = values.tag
const target = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`)
const parent = git('rev-list', '--parents', '-n', '1', target).split(' ')[1]
const tags = git('tag', '--list')
  .split('\n')
  .filter(
    (name) =>
      name !== tag && versionPattern.test(name) && (tag.includes('-') || !name.includes('-'))
  )
let previous = null
if (parent && tags.length) {
  try {
    previous = git(
      'describe',
      '--tags',
      '--abbrev=0',
      '--first-parent',
      ...tags.flatMap((name) => ['--match', name]),
      parent
    )
  } catch (error) {
    if (error.status !== 128) throw error
    // No eligible version tag is reachable on this branch: this is its first release.
  }
}
const repoUrl = `https://github.com/${values.repo}`
const range = previous ? `${git('rev-parse', `refs/tags/${previous}^{commit}`)}..${target}` : target
const categories = ['新增功能', '问题修复', '其他改进']
const groups = Object.fromEntries(categories.map((name) => [name, []]))
const escape = (text) => text.replace(/[\\`*_{}\[\]<>]/g, '\\$&')
const modules = [
  [/update|mac-install/, '应用升级'],
  [/^\.github\//, '自动构建与发布'],
  [/^scripts\/(prepare-release|release-notes)/, '发布说明与附件'],
  [/protocol|first-token|response-ids/, '协议转换'],
  [/gateway|scheduler|kimi-capabilities/, '账号与网关'],
  [/pricing|quota|usage|request-history/, '用量与费用统计'],
  [/^src\/renderer\//, '桌面界面'],
  [/^src\/(main|preload)\//, '桌面应用服务'],
  [/^tests\/|^scripts\/.*test|^scripts\/smoke/, '自动化测试'],
  [/^README|^docs\//, '项目文档']
]
for (const hash of git('rev-list', '--reverse', '--no-merges', range).split('\n').filter(Boolean)) {
  const message = git('show', '-s', '--format=%B', hash)
  const subject = message.split('\n')[0]
  const match = /^(\w+)(?:\([^)]+\))?!?:\s*(.*)$/.exec(subject)
  const type = match?.[1]?.toLowerCase()
  const category = type === 'feat' ? categories[0] : type === 'fix' ? categories[1] : categories[2]
  const trailer = /^Release-Note-zh:\s*(.+)$/im.exec(message)?.[1]
  const description = trailer || match?.[2] || subject
  let summary = description
  if (!/[\u3400-\u9fff]/u.test(description)) {
    const paths = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', hash).split(
      '\n'
    )
    const names = [
      ...new Set(
        paths.map((path) => modules.find(([pattern]) => pattern.test(path))?.[1]).filter(Boolean)
      )
    ].slice(0, 3)
    const area = names.join('、') || '项目基础配置'
    summary =
      category === '新增功能'
        ? `新增或扩展${area}功能`
        : category === '问题修复'
          ? `修复${area}相关问题`
          : `完善${area}`
  }
  groups[category].push(`- ${escape(summary)}（[${hash.slice(0, 7)}](${repoUrl}/commit/${hash})）`)
}

// Optional reviewed Chinese notes provide more precise release-level wording than commit summaries.
let curated
try {
  curated = await readFile(join('release-notes', `${tag.replace(/^v/, '')}.md`), 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (curated && categories.some((category) => !curated.includes(`## ${category}`)))
  throw new Error('Reviewed release notes must contain 新增功能 / 问题修复 / 其他改进')
const content =
  curated?.trim() ||
  categories
    .map((category) => `## ${category}\n\n${groups[category].join('\n') || '- 本次无相关变更。'}`)
    .join('\n\n')
const scope = previous
  ? `变更范围：\`${previous}\` → \`${tag}\`。`
  : `\`${tag}\` 为首个版本，汇总截至此标签的提交。`
const history = previous
  ? `[查看完整变更](${repoUrl}/compare/${encodeURIComponent(previous)}...${encodeURIComponent(tag)})`
  : `[查看提交记录](${repoUrl}/commits/${encodeURIComponent(tag)})`
const start = '<!-- kimi-release-notes:start -->'
const end = '<!-- kimi-release-notes:end -->'
const block = `${start}\n${scope}\n\n${content}\n\n${history}\n${end}`
const existing = values.existing ? await readFile(values.existing, 'utf8') : ''
const starts = existing.split(start).length - 1
const ends = existing.split(end).length - 1
if (starts !== ends || starts > 1 || (starts && existing.indexOf(end) < existing.indexOf(start)))
  throw new Error('Invalid generated-notes markers; refusing to overwrite release body')
const body = starts
  ? existing.slice(0, existing.indexOf(start)) +
    block +
    existing.slice(existing.indexOf(end) + end.length)
  : `${block}\n${existing.trim() ? `\n${existing}` : ''}`
await writeFile(values.output, body)
console.log(`Generated Chinese notes for ${tag}; previous tag: ${previous ?? '(first release)'}`)
