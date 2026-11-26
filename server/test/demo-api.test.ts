import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DEMO_BOT, LIMITS } from '@conflux/shared'
import { eq } from 'drizzle-orm'
import { hashToken } from '../src/auth/sessions'
import { sandboxParticipants, sandboxes } from '../src/db/schema'
import { Client, startTestServer, type TestServer } from './helpers'
import { beginDemo, joinAs, makeDemo, rowsOfDemo, sandboxIdOf, visit } from './demo-helpers'

let server: TestServer
before(async () => {
  server = await startTestServer()
})
after(async () => {
  await server.close()
})

const demoCookie = (reply: { setCookies: string[] }) => reply.setCookies.find((line) => /^(__Host-)?conflux_demo=/.test(line))

describe('starting a demo', () => {
  it('tells the sign-in screen whether the demo is offered, and what its limits are', async () => {
    const reply = await new Client(server).get('/api/demo/info')
    assert.equal(reply.status, 200)
    assert.deepEqual(reply.body, { enabled: true, idleMinutes: 30, maxHours: 3 })
  })

  it('needs no account, sets no cookie, and hands out a ticket long enough to be a secret', async () => {
    const reply = await new Client(server).post('/api/demo/sessions', {})
    assert.equal(reply.status, 201)
    assert.match(reply.body.ticket, /^[A-Za-z0-9_-]{43}$/)
    assert.deepEqual(reply.setCookies, [])
    assert.equal(reply.headers.get('cache-control'), 'no-store')
  })

  it('keeps only a hash of the ticket, never the ticket itself', async () => {
    const ticket = await beginDemo(server)
    const stored = await server.db.select().from(sandboxes).where(eq(sandboxes.ticketHash, hashToken(ticket)))
    assert.equal(stored.length, 1)
    assert.ok(!JSON.stringify(stored).includes(ticket))
  })

  it('gives every demo the same three made-up pages, each with its own saved content', async () => {
    const { host } = await makeDemo(server)
    assert.deepEqual(
      host.state.pages.map((page) => page.title),
      ['Welcome to the demo', 'Team notes', 'Ideas board'],
    )
    assert.deepEqual(host.state.pages.map((page) => page.position), [0, 1, 2])
    assert.deepEqual(await rowsOfDemo(server, await sandboxIdOf(server, host)), { demos: 1, people: 1, pages: 3, docs: 3 })
  })

  it('gives separate demos separate pages: nothing is shared between them', async () => {
    const a = await makeDemo(server)
    const b = await makeDemo(server)
    const ids = new Set([...a.host.state.pages, ...b.host.state.pages].map((page) => page.id))
    assert.equal(ids.size, 6)
  })

  it('refuses extra fields and broken JSON', async () => {
    const client = new Client(server)
    assert.equal((await client.post('/api/demo/sessions', { admin: true })).status, 400)
    assert.equal((await client.post('/api/demo/sessions', '{not json')).status, 400)
  })

  it('refuses a start that says it comes from another website', async () => {
    const reply = await new Client(server).post('/api/demo/sessions', {}, { Origin: 'http://evil.example' })
    assert.equal(reply.status, 403)
    assert.equal(reply.body.error.code, 'bad_origin')
  })
})

describe('opening a demo link', () => {
  it('lets the first visitor in as the host, with a throw-away name and colour', async () => {
    const ticket = await beginDemo(server)
    const reply = await new Client(server).post('/api/demo/join', { ticket })
    assert.equal(reply.status, 200)
    const state = reply.body
    assert.equal(state.me.isHost, true)
    assert.match(state.me.displayName, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
    assert.match(state.me.cursorColor, /^#[0-9a-f]{6}$/i)
    assert.equal(state.participants, 1)
    assert.deepEqual(state.bot, { name: DEMO_BOT.name, color: DEMO_BOT.color })
    assert.equal(state.idleSeconds, 30 * 60)
    const left = new Date(state.endsAt).getTime() - Date.now()
    assert.ok(left > 3 * 3600_000 - 60_000 && left <= 3 * 3600_000, `ends in ${left} ms`)
  })

  it('remembers the visitor in a cookie that scripts cannot read and that ends with the demo', async () => {
    const ticket = await beginDemo(server)
    const reply = await new Client(server).post('/api/demo/join', { ticket })
    const line = demoCookie(reply)
    assert.ok(line, 'a cookie was set')
    assert.match(line, /HttpOnly/i)
    assert.match(line, /SameSite=Lax/i)
    assert.match(line, /Path=\//)
    assert.doesNotMatch(line, /Domain=/i)
    const expires = new Date(/Expires=([^;]+)/i.exec(line)![1]).getTime()
    assert.ok(Math.abs(expires - new Date(reply.body.endsAt).getTime()) < 2000, 'the cookie ends when the demo does')
  })

  it('never puts the ticket or any secret in the answer', async () => {
    const ticket = await beginDemo(server)
    const reply = await new Client(server).post('/api/demo/join', { ticket })
    const text = JSON.stringify(reply.body)
    assert.ok(!text.includes(ticket))
    assert.doesNotMatch(text, /token|hash|secret|ticket/i)
    assert.equal(reply.headers.get('cache-control'), 'no-store')
  })

  it('gives the second person a different identity, and not the host role', async () => {
    const ticket = await beginDemo(server)
    const first = await visit(server, ticket)
    const second = await joinAs(server, ticket)
    assert.equal(second.state.me.isHost, false)
    assert.notEqual(second.state.me.id, first.state.me.id)
    assert.notEqual(second.state.me.displayName, first.state.me.displayName)
    assert.notEqual(second.state.me.cursorColor, first.state.me.cursorColor)
    assert.equal(second.state.participants, 2)
    assert.deepEqual(second.state.pages, first.state.pages, 'they share the same pages')
  })

  it('recognises a browser that comes back (a refresh): same identity, no second visitor, no new cookie', async () => {
    const ticket = await beginDemo(server)
    const first = await visit(server, ticket)
    const again = await first.client.post('/api/demo/join', { ticket })
    assert.equal(again.status, 200)
    assert.equal(again.body.me.id, first.state.me.id)
    assert.equal(again.body.me.isHost, true)
    assert.equal(again.body.participants, 1)
    assert.equal(demoCookie(again), undefined)
    assert.equal((await rowsOfDemo(server, await sandboxIdOf(server, first))).people, 1)
  })

  it('gives six visitors six different names and colours, and none of them looks like the bot', async () => {
    const ticket = await beginDemo(server)
    const people = []
    for (let i = 0; i < LIMITS.demoMaxParticipants; i += 1) people.push(await joinAs(server, ticket))
    assert.equal(new Set(people.map((p) => p.state.me.displayName)).size, 6)
    assert.equal(new Set(people.map((p) => p.state.me.cursorColor)).size, 6)
    assert.ok(people.every((p) => p.state.me.cursorColor.toLowerCase() !== DEMO_BOT.color.toLowerCase()))
    assert.equal(people.filter((p) => p.state.me.isHost).length, 1, 'exactly one host')
  })

  it('has room for six people, refuses the seventh, and has room again when somebody leaves', async () => {
    const ticket = await beginDemo(server)
    const people = [await visit(server, ticket)]
    for (let i = 1; i < LIMITS.demoMaxParticipants; i += 1) people.push(await joinAs(server, ticket))
    const seventh = await new Client(server).post('/api/demo/join', { ticket })
    assert.equal(seventh.status, 409)
    assert.equal(seventh.body.error.code, 'demo_full')
    assert.equal(demoCookie(seventh), undefined, 'a refused visitor gets no cookie')
    assert.equal((await people[3].client.post('/api/demo/leave')).status, 204)
    assert.equal((await new Client(server).post('/api/demo/join', { ticket })).status, 200)
  })

  it('never lets more than six in, even when they all arrive in the same instant', async () => {
    const ticket = await beginDemo(server)
    await visit(server, ticket)
    const replies = await Promise.all(Array.from({ length: 12 }, () => new Client(server).post('/api/demo/join', { ticket })))
    const statuses = replies.map((reply) => reply.status).sort()
    assert.equal(statuses.filter((status) => status === 200).length, LIMITS.demoMaxParticipants - 1)
    assert.equal(statuses.filter((status) => status === 409).length, 12 - (LIMITS.demoMaxParticipants - 1))
    const [row] = await server.db.select({ sandboxId: sandboxParticipants.sandboxId }).from(sandboxParticipants).limit(1)
    assert.ok(row)
    const hosts = await server.db.select().from(sandboxParticipants).where(eq(sandboxParticipants.isHost, true))
    const perDemo = new Map<string, number>()
    for (const host of hosts) perDemo.set(host.sandboxId, (perDemo.get(host.sandboxId) ?? 0) + 1)
    assert.ok([...perDemo.values()].every((n) => n === 1), 'the database allows one host per demo')
  })

  it('says "ended" for a ticket that belongs to no demo', async () => {
    const reply = await new Client(server).post('/api/demo/join', { ticket: 'A'.repeat(43) })
    assert.equal(reply.status, 404)
    assert.equal(reply.body.error.code, 'demo_ended')
    assert.equal(demoCookie(reply), undefined)
  })

  it('refuses malformed tickets, extra fields, and a ticket put in the address instead of the body', async () => {
    const ticket = await beginDemo(server)
    const client = new Client(server)
    for (const body of [{}, { ticket: 'short' }, { ticket: `${ticket}x` }, { ticket: 7 }, { ticket, extra: 1 }, { ticket: `${'a'.repeat(42)}!` }, null, '[]']) {
      const reply = await client.post('/api/demo/join', body)
      assert.equal(reply.status, 400, JSON.stringify(body))
    }
    assert.equal((await client.post(`/api/demo/join?ticket=${ticket}`, {})).status, 400)
  })
})

describe('leaving and ending', () => {
  it('lets only the host end the demo', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const refused = await guest.client.post('/api/demo/end')
    assert.equal(refused.status, 403)
    assert.equal((await host.client.post('/api/demo/join', { ticket })).status, 200, 'the demo is still there')
  })

  it('does not let the host walk out and leave a demo nobody is in charge of', async () => {
    const { host } = await makeDemo(server)
    const reply = await host.client.post('/api/demo/leave')
    assert.equal(reply.status, 409)
    assert.equal(reply.body.error.code, 'host_cannot_leave')
  })

  it('lets everybody else leave: the visitor and their cookie are gone', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const left = await guest.client.post('/api/demo/leave')
    assert.equal(left.status, 204)
    assert.ok(left.setCookies.some((line) => /conflux_demo=;|conflux_demo=\s*;/i.test(line) || /Expires=Thu, 01 Jan 1970/i.test(line)), 'the cookie is cleared')
    assert.equal((await rowsOfDemo(server, await sandboxIdOf(server, host))).people, 1)
    const after = await guest.client.post('/api/demo/sync-token', { doc: `demo.${host.state.pages[0].id}` })
    assert.equal(after.status, 401)
  })

  it('deletes everything when the host ends the demo, and the link stops working for everybody', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const sandboxId = await sandboxIdOf(server, host)
    assert.deepEqual(await rowsOfDemo(server, sandboxId), { demos: 1, people: 2, pages: 3, docs: 3 })

    const ended = await host.client.post('/api/demo/end')
    assert.equal(ended.status, 204)
    assert.ok(ended.setCookies.length > 0, 'the host cookie is cleared')
    assert.deepEqual(await rowsOfDemo(server, sandboxId), { demos: 0, people: 0, pages: 0, docs: 0 })

    const link = await new Client(server).post('/api/demo/join', { ticket })
    assert.equal(link.status, 404)
    assert.equal(link.body.error.code, 'demo_ended')
    assert.equal((await guest.client.post('/api/demo/sync-token', { doc: `demo.${guest.state.pages[0].id}` })).status, 401)
    assert.equal((await host.client.post('/api/demo/end')).status, 401, 'ending twice is refused, not an error')
  })

  it('leaves other demos alone', async () => {
    const one = await makeDemo(server)
    const two = await makeDemo(server)
    assert.equal((await one.host.client.post('/api/demo/end')).status, 204)
    assert.deepEqual(await rowsOfDemo(server, await sandboxIdOf(server, two.host)), { demos: 1, people: 1, pages: 3, docs: 3 })
    assert.equal((await two.host.client.post('/api/demo/join', { ticket: two.ticket })).status, 200)
  })
})

describe('limits and switches', () => {
  it('limits how many demos one address can start per hour, and how often it can open links', async () => {
    const strict = await startTestServer({ env: { CONFLUX_RATE_LIMIT_SCALE: '1' } })
    try {
      const client = new Client(strict)
      const replies = []
      for (let i = 0; i < 6; i += 1) replies.push(await client.post('/api/demo/sessions', {}))
      assert.deepEqual(replies.map((reply) => reply.status), [201, 201, 201, 201, 201, 429])
      assert.ok(Number(replies[5].headers.get('retry-after')) > 0, 'it says when to try again')

      const ticket = replies[0].body.ticket as string
      const statuses = []
      for (let i = 0; i < 62; i += 1) statuses.push((await client.post('/api/demo/join', { ticket })).status)
      assert.equal(statuses.filter((status) => status === 200).length, 60)
      assert.deepEqual(statuses.slice(60), [429, 429])
    } finally {
      await strict.close()
    }
  })

  it('limits how many demos are alive at once, and has room again when one ends (even under a burst)', async () => {
    const small = await startTestServer({ env: { CONFLUX_DEMO_MAX_ACTIVE: '3' } })
    try {
      const burst = await Promise.all(Array.from({ length: 8 }, () => new Client(small).post('/api/demo/sessions', {})))
      const made = burst.filter((reply) => reply.status === 201)
      const refused = burst.filter((reply) => reply.status === 503)
      assert.equal(made.length, 3)
      assert.equal(refused.length, 5)
      assert.equal(refused[0].body.error.code, 'demo_full')
      assert.ok(refused[0].headers.get('retry-after'))

      const host = await visit(small, made[0].body.ticket)
      assert.equal((await host.client.post('/api/demo/end')).status, 204)
      assert.equal((await new Client(small).post('/api/demo/sessions', {})).status, 201)
    } finally {
      await small.close()
    }
  })

  it('can be switched off: nothing is offered, and nothing can be started or joined', async () => {
    const off = await startTestServer({ env: { CONFLUX_DEMO: 'false' } })
    try {
      const client = new Client(off)
      assert.equal((await client.get('/api/demo/info')).body.enabled, false)
      assert.equal((await client.post('/api/demo/sessions', {})).status, 404)
      assert.equal((await client.post('/api/demo/join', { ticket: 'A'.repeat(43) })).status, 404)
    } finally {
      await off.close()
    }
  })

  it('uses the __Host- prefix and Secure on a secure deployment', async () => {
    const secure = await startTestServer({ env: { CONFLUX_COOKIE_SECURE: 'true' } })
    try {
      const ticket = await beginDemo(secure)
      const reply = await new Client(secure).post('/api/demo/join', { ticket })
      const line = reply.setCookies.find((entry) => entry.startsWith('__Host-conflux_demo='))
      assert.ok(line, reply.setCookies.join(' | '))
      assert.match(line, /; Secure/i)
      assert.match(line, /HttpOnly/i)
      assert.match(line, /Path=\//)
      assert.doesNotMatch(line, /Domain=/i)
    } finally {
      await secure.close()
    }
  })
})
