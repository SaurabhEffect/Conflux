import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CURSOR_COLORS,
  DEMO_BOT,
  DEMO_BOT_COMMANDS,
  DEMO_BOT_MENTION,
  LIMITS,
  cursorColorFor,
  demoDocName,
  demoTicketBody,
  pageDocName,
  parseDemoDocName,
  parseDocName,
  workspaceDocName,
} from '../src/index'

const ID = '0b6c1f3e-4d2a-4f6e-9a1b-7c8d9e0f1a2b'

describe('names of demo documents', () => {
  it('a demo page name reads back as the page id', () => {
    assert.equal(demoDocName(ID), `demo.${ID}`)
    assert.equal(parseDemoDocName(demoDocName(ID)), ID)
  })

  it('only the exact shape is accepted', () => {
    for (const name of [
      '',
      'demo.',
      `demo.${ID.toUpperCase()}`,
      `demo.${ID}.`,
      `demo.${ID}\n`,
      ` demo.${ID}`,
      `demo.${ID}/../x`,
      `Demo.${ID}`,
      `demo.${ID.replaceAll('-', '')}`,
      `demo.${ID}x`,
      `page.${ID}`,
      `workspace.${ID}`,
      `demo:${ID}`,
    ]) {
      assert.equal(parseDemoDocName(name), null, JSON.stringify(name))
    }
  })

  it('account documents and demo documents can never be mistaken for each other', () => {
    assert.equal(parseDocName(demoDocName(ID)), null, 'an account token cannot be used for a demo page')
    assert.equal(parseDemoDocName(pageDocName(ID)), null)
    assert.equal(parseDemoDocName(workspaceDocName(ID)), null)
  })
})

describe('the secret in a demo link', () => {
  const ticket = 'ggIS4QaRp4Vw2v9zjQdG7yR-eLDYT3wpKl7bdTmaao4'

  it('is 43 characters of base64url', () => {
    assert.equal(ticket.length, 43)
    assert.equal(demoTicketBody.parse({ ticket }).ticket, ticket)
    assert.equal(demoTicketBody.parse({ ticket: 'A'.repeat(43) }).ticket, 'A'.repeat(43))
    assert.equal(demoTicketBody.parse({ ticket: `${'_-'.repeat(21)}x` }).ticket.length, 43)
  })

  it('refuses everything else, with a message that gives nothing away', () => {
    for (const bad of ['', 'short', ticket.slice(1), `${ticket}A`, `${ticket.slice(1)}+`, `${ticket.slice(1)}/`, `${ticket.slice(1)}=`, ` ${ticket.slice(1)}`, `${ticket.slice(1)}\n`, 'é'.repeat(43)]) {
      const result = demoTicketBody.safeParse({ ticket: bad })
      assert.equal(result.success, false, JSON.stringify(bad))
      if (!result.success) assert.equal(result.error.issues[0].message, 'Invalid demo link')
    }
    assert.equal(demoTicketBody.safeParse({}).success, false)
    assert.equal(demoTicketBody.safeParse({ ticket: 5 }).success, false)
  })

  it('takes nothing besides the secret', () => {
    assert.equal(demoTicketBody.safeParse({ ticket, role: 'host' }).success, false)
    assert.equal(demoTicketBody.safeParse({ ticket, sandboxId: ID }).success, false)
  })
})

describe('demo limits', () => {
  it('are whole, positive numbers', () => {
    for (const key of ['demoMaxParticipants', 'demoPageMaxBytes', 'demoMessageMaxBytes', 'demoSocketsPerParticipant'] as const) {
      assert.ok(Number.isInteger(LIMITS[key]) && LIMITS[key] > 0, key)
    }
  })

  it('a message that carries a whole page is allowed: the message limit is above the page limit', () => {
    assert.ok(LIMITS.demoMessageMaxBytes > LIMITS.demoPageMaxBytes)
  })

  it('every visitor can have a few tabs open, but not an unlimited number', () => {
    assert.ok(LIMITS.demoSocketsPerParticipant >= 2 && LIMITS.demoSocketsPerParticipant <= 10)
  })
})

describe('the bot', () => {
  it('has a colour no visitor can have, so nobody can look like the bot', () => {
    assert.ok(!(CURSOR_COLORS as readonly string[]).includes(DEMO_BOT.color))
    for (const seed of ['a', 'b', 'Conflux Bot', '', DEMO_BOT.name, ID]) assert.notEqual(cursorColorFor(seed), DEMO_BOT.color)
  })

  it('is asked for with one word: the commands are lower-case, distinct, and contain no spaces', () => {
    assert.ok(DEMO_BOT_MENTION.startsWith('@'))
    assert.equal(new Set(DEMO_BOT_COMMANDS).size, DEMO_BOT_COMMANDS.length)
    for (const command of DEMO_BOT_COMMANDS) assert.match(command, /^[a-z]+$/)
    assert.ok(DEMO_BOT_COMMANDS.includes('help'), 'a bare "@bot" means help')
  })
})
