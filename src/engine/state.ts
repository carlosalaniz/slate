import { readJsonOr, writeJsonAtomic, isFile } from "../util/fs.ts"
import type { JobState } from "./types.ts"

/**
 * Owns state.json. Every mutation goes through `update`, which serializes writers and checkpoints
 * atomically after each change. Readers in other processes (status, inbox) only ever read.
 */
export class StateStore {
  private queue: Promise<void> = Promise.resolve()
  private constructor(public readonly path: string, private state: JobState) {}

  static async open(path: string): Promise<StateStore | undefined> {
    if (!(await isFile(path))) return undefined
    const state = await readJsonOr<JobState | undefined>(path, undefined)
    if (!state || state.version !== 1) return undefined
    return new StateStore(path, state)
  }

  static async create(path: string, state: JobState): Promise<StateStore> {
    await writeJsonAtomic(path, state)
    return new StateStore(path, state)
  }

  static async read(path: string): Promise<JobState | undefined> {
    if (!(await isFile(path))) return undefined
    const s = await readJsonOr<JobState | undefined>(path, undefined)
    return s && s.version === 1 ? s : undefined
  }

  get(): JobState {
    return this.state
  }

  /** Applies a mutation and checkpoints. Mutations run one at a time in call order. */
  update<T>(fn: (s: JobState) => T): Promise<T> {
    let result!: T
    const run = this.queue.then(async () => {
      result = fn(this.state)
      this.state.updated = new Date().toISOString()
      await writeJsonAtomic(this.path, this.state)
    })
    this.queue = run.catch(() => undefined)
    return run.then(() => result)
  }

  /** Re-reads the file (used after another process may have touched it). */
  async reload(): Promise<JobState> {
    const s = await readJsonOr<JobState | undefined>(this.path, undefined)
    if (s && s.version === 1) this.state = s
    return this.state
  }

  async flush(): Promise<void> {
    await this.queue
  }
}
