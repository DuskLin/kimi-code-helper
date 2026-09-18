import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type {
  MigrationProgress,
  MigrationScan,
  MigrationResult
} from '../../shared/session-migration'

/** One bounded job at a time; large SQLite/JSON records never cross the main thread. */
export class SessionMigrationService {
  private busy = false

  async run<T extends 'scan' | 'migrate'>(
    operation: T,
    value: unknown,
    progress: (value: MigrationProgress) => void = () => {}
  ): Promise<T extends 'scan' ? MigrationScan : MigrationResult> {
    if (this.busy) throw new Error('扫描或迁移正在进行，请稍后重试')
    this.busy = true
    try {
      return await new Promise((resolve, reject) => {
        const worker = new Worker(join(__dirname, 'session-migration-worker.js'), {
          workerData: { operation, value }
        })
        let received = false
        worker.on('message', (message) => {
          if (message.progress) {
            progress(message.progress)
            return
          }
          received = true
          if (message.error) reject(new Error(message.error))
          else resolve(message.result)
        })
        worker.on('error', reject)
        worker.on('exit', () => {
          if (!received) reject(new Error('迁移后台线程意外退出，请重试'))
        })
      })
    } finally {
      this.busy = false
    }
  }
}
