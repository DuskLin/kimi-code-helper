import { parentPort, workerData } from 'node:worker_threads'
import { SessionMigration } from './session-migration'

async function run() {
  let lastProgress = 0
  const migration = new SessionMigration((progress) => {
    const now = Date.now()
    if (
      progress.completed === 0 ||
      progress.completed === progress.total ||
      now - lastProgress >= 250
    ) {
      parentPort?.postMessage({ progress })
      lastProgress = now
    }
  })
  try {
    const result =
      workerData.operation === 'scan'
        ? await migration.scan(workerData.value)
        : await migration.importRequest(workerData.value)
    parentPort?.postMessage({ result })
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    parentPort?.close()
  }
}
void run()
