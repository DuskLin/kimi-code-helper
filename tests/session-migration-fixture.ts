export const imageBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5QAAAABJRU5ErkJggg=='
export function nativeFixture(workspacePath: string) {
  return {
    meta: { taskId: 'task', title: '测试迁移', workspacePath, createdAt: 1000, updatedAt: 5000 },
    messages: [
      {
        role: 'user',
        content: '检查项目',
        timestamp: 1000,
        attachments: [
          { kind: 'image', filename: 'image.png', mimeType: 'image/png', dataBase64: imageBase64 }
        ]
      },
      {
        role: 'assistant',
        content: '先检查。检查完成。',
        thought: '先分析问题。',
        timestamp: 3000,
        durationMs: 2000,
        tools: [
          {
            title: 'echo hello',
            kind: 'execute',
            status: 'completed',
            input: { command: 'echo hello' },
            output: { formatted_output: 'hello', exit_code: 0 },
            raw: { toolCallId: 'call_shell', _meta: { claudeCode: { toolName: 'Bash' } } }
          },
          {
            title: 'Edit example.txt',
            kind: 'edit',
            status: 'failed',
            input: { file_path: '/work/example.txt', old_string: 'old', new_string: 'new' },
            output: 'Permission denied',
            raw: { toolCallId: 'call_edit', _meta: { claudeCode: { toolName: 'Edit' } } }
          },
          {
            title: 'Read child.txt',
            kind: 'read',
            status: 'completed',
            input: { file_path: '/work/child.txt' },
            output: 'child contents',
            raw: {
              toolCallId: 'call_child',
              _meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'call_agent' } }
            }
          },
          {
            title: 'Explore project',
            kind: 'think',
            status: 'completed',
            input: {
              description: 'Explore project',
              subagent_type: 'Explore',
              prompt: 'Read child.txt'
            },
            output: [{ type: 'text', text: 'Child summary' }],
            raw: { toolCallId: 'call_agent', _meta: { claudeCode: { toolName: 'Agent' } } }
          }
        ],
        parts: [
          { type: 'thought', content: '先分析问题。' },
          { type: 'content', content: '先检查。' },
          { type: 'tool-call', toolIndex: 0 },
          { type: 'tool-call', toolIndex: 1 },
          { type: 'tool-call', toolIndex: 2 },
          { type: 'tool-call', toolIndex: 3 },
          { type: 'content', content: '检查完成。' }
        ]
      },
      { role: 'user', content: '继续检查', timestamp: 4000 },
      {
        role: 'assistant',
        content: '已中断',
        timestamp: 5000,
        interrupted: true,
        tools: [
          {
            title: 'Bash',
            status: 'in_progress',
            input: { command: 'sleep 100' },
            raw: { toolCallId: 'call_pending' }
          }
        ],
        parts: [
          { type: 'tool-call', toolIndex: 0 },
          { type: 'content', content: '已中断' }
        ]
      }
    ]
  }
}
