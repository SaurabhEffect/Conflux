import { randomBytes } from 'node:crypto'
import { argon2Verify, argon2id } from 'hash-wasm'

const MEMORY_KIB = 19_456
const ITERATIONS = 2
const PARALLELISM = 1

export function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_KIB,
    hashLength: 32,
    outputType: 'encoded',
  })
}

export async function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encodedHash })
  } catch {
    return false
  }
}

const dummyHash: Promise<string> = hashPassword(randomBytes(16).toString('hex'))
dummyHash.catch(() => undefined)

export async function verifyAgainstDummy(password: string): Promise<void> {
  await verifyPassword(await dummyHash, password)
}
