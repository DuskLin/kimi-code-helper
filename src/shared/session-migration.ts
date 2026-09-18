export interface MigrationPaths {
  source: string
  target: string
}
export interface MigrationSession {
  key: string
  fingerprint: string
  title: string
  workspace: string
  updatedAt: number
  messageCount: number
  imported: boolean
  legacyImported: boolean
  warnings: string[]
  counts: {
    messages: number
    tools: number
    thinking: number
    attachments: number
    subagents: number
  }
}
export interface MigrationScan {
  coverage?: { indexed: number; matched: number; sources: string[] }
  paths: MigrationPaths
  sessions: MigrationSession[]
  errors: string[]
}
export interface MigrationProgress {
  phase: 'scan' | 'migrate'
  completed: number
  total: number
}
export interface MigrationResult {
  completedKeys: string[]
  warnings: string[]
  imported: number
  skipped: number
  errors: string[]
}
