import { randomInt } from 'node:crypto'
import { CURSOR_COLORS } from '@conflux/shared'

const ADJECTIVES = ['Curious', 'Brisk', 'Calm', 'Clever', 'Gentle', 'Jolly', 'Keen', 'Lucky', 'Mellow', 'Nimble', 'Plucky', 'Quiet', 'Rapid', 'Sunny', 'Witty', 'Zesty']
const ANIMALS = ['Otter', 'Heron', 'Lynx', 'Panda', 'Falcon', 'Gecko', 'Koala', 'Marmot', 'Narwhal', 'Osprey', 'Quokka', 'Raven', 'Seal', 'Toucan', 'Walrus', 'Yak']

export function guestName(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${ANIMALS[randomInt(ANIMALS.length)]}`
    if (!taken.has(name)) return name
  }
  return `Guest ${randomInt(1000, 10_000)}`
}

export function guestColor(taken: ReadonlySet<string>): string {
  return CURSOR_COLORS.find((color) => !taken.has(color)) ?? CURSOR_COLORS[randomInt(CURSOR_COLORS.length)]
}
