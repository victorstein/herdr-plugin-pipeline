import { mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    return (await file.json()) as T
  } catch {
    return null
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}
