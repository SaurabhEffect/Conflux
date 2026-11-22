import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { memberships, pages, sessions, users } from '../src/db/schema'
import { Client, PASSWORD, startTestServer, type TestServer } from './helpers'

describe('accounts and sessions', () => {
  let server: TestServer
  before(async () => {
    server = await startTestServer()
  })
  after(async () => {
    await server.close()
  })

  describe('sign up', () => {
    it('creates the account, a private workspace it owns, and a welcome page', async () => {
      const client = new Client(server)
      const reply = await client.post('/api/auth/signup', { email: '  Saru@Example.COM ', password: PASSWORD, displayName: '  Saru  C ' })
      assert.equal(reply.status, 201)
      assert.equal(reply.body.user.email, 'saru@example.com')
      assert.equal(reply.body.user.displayName, 'Saru C')
      assert.equal(reply.body.workspaces.length, 1)
      assert.equal(reply.body.workspaces[0].role, 'owner')

      const rows = await server.db.select().from(memberships).where(eq(memberships.userId, reply.body.user.id))
      assert.deepEqual(rows.map((row) => row.role), ['owner'])
      const welcome = await server.db.select().from(pages).where(eq(pages.id, reply.body.welcomePageId))
      assert.equal(welcome.length, 1)
      assert.equal(welcome[0].workspaceId, reply.body.workspaces[0].id)
    })

    it('never sends the password or its hash back', async () => {
      const client = new Client(server)
      const reply = await client.post('/api/auth/signup', { email: 'leak@example.com', password: PASSWORD, displayName: 'Leak' })
      const text = JSON.stringify(reply.body)
      assert.ok(!text.includes(PASSWORD))
      assert.ok(!/argon2|passwordHash|password_hash/i.test(text))
      const me = await client.get('/api/auth/me')
      assert.ok(!/argon2|passwordHash|password_hash/i.test(JSON.stringify(me.body)))
    })

    it('stores the password as an Argon2id hash with a fresh salt, never as text', async () => {
      const a = await new Client(server).signup('A')
      const b = await new Client(server).signup('B')
      const [rowA] = await server.db.select().from(users).where(eq(users.id, a.user.id))
      const [rowB] = await server.db.select().from(users).where(eq(users.id, b.user.id))
      assert.match(rowA.passwordHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
      assert.ok(!rowA.passwordHash.includes(PASSWORD))
      assert.notEqual(rowA.passwordHash, rowB.passwordHash, 'same password, different salt, different hash')
    })

    it('stores only a hash of the session token', async () => {
      const client = new Client(server)
      const { user } = await client.signup('Hashy')
      const token = client.cookie!.split('=')[1]
      const rows = await server.db.select().from(sessions).where(eq(sessions.userId, user.id))
      assert.equal(rows.length, 1)
      assert.match(rows[0].tokenHash, /^[0-9a-f]{64}$/)
      assert.notEqual(rows[0].tokenHash, token)
      assert.ok(!JSON.stringify(rows).includes(token))
    })

    it('sets a cookie that scripts cannot read and other sites cannot send', async () => {
      const client = new Client(server)
      const reply = await client.post('/api/auth/signup', { email: 'cookie@example.com', password: PASSWORD, displayName: 'Cookie' })
      const line = reply.setCookies.find((cookie) => cookie.startsWith('conflux_session='))
      assert.ok(line, 'session cookie is set')
      assert.match(line, /;\s*HttpOnly/i)
      assert.match(line, /;\s*SameSite=Lax/i)
      assert.match(line, /;\s*Path=\//i)
      assert.match(line, /;\s*Expires=/i)
      assert.ok(!/;\s*Domain=/i.test(line), 'no Domain attribute, so it stays on this exact host')
    })

    it('refuses a second account with the same email, whatever the capitals', async () => {
      await new Client(server).signup('First', 'dupe@example.com')
      const reply = await new Client(server).post('/api/auth/signup', { email: 'DUPE@example.com', password: PASSWORD, displayName: 'Second' })
      assert.equal(reply.status, 409)
      assert.equal(reply.body.error.code, 'email_taken')
    })

    it('lets exactly one of two simultaneous sign-ups with the same email win', async () => {
      const email = 'race@example.com'
      const replies = await Promise.all([
        new Client(server).post('/api/auth/signup', { email, password: PASSWORD, displayName: 'One' }),
        new Client(server).post('/api/auth/signup', { email, password: PASSWORD, displayName: 'Two' }),
      ])
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409])
      const rows = await server.db.select().from(users).where(eq(users.email, email))
      assert.equal(rows.length, 1)
    })

    it('rejects bad input with a clear 400 and creates nothing', async () => {
      const before = (await server.db.select().from(users)).length
      const bad: unknown[] = [
        { email: 'nope', password: PASSWORD, displayName: 'X' },
        { email: 'a@example.com', password: 'short', displayName: 'X' },
        { email: 'a@example.com', password: PASSWORD, displayName: '' },
        { email: 'a@example.com', password: PASSWORD, displayName: 'bell\u0007' },
        { email: 'a@example.com', password: PASSWORD, displayName: 'x'.repeat(33) },
        { email: 'a@example.com', password: 'x'.repeat(129), displayName: 'X' },
        { email: 'a@example.com', password: PASSWORD },
        { email: 'a@example.com', password: PASSWORD, displayName: 'X', role: 'owner' },
        { email: ['a@example.com'], password: PASSWORD, displayName: 'X' },
        { email: 'a@example.com', password: 12345678901, displayName: 'X' },
        [],
        'text',
        null,
      ]
      for (const body of bad) {
        const reply = await new Client(server).post('/api/auth/signup', body)
        assert.equal(reply.status, 400, JSON.stringify(body))
        assert.equal(reply.body.error.code === 'invalid_input' || reply.body.error.code === 'bad_request', true, JSON.stringify(reply.body))
      }
      assert.equal((await server.db.select().from(users)).length, before)
    })

    it('does not treat a "__proto__" key as a way to smuggle fields in', async () => {
      const reply = await new Client(server).post(
        '/api/auth/signup',
        '{"email":"proto@example.com","password":"correct horse battery staple","displayName":"P","__proto__":{"admin":true}}',
      )
      assert.equal(reply.status, 400)
    })
  })

  describe('log in and out', () => {
    it('signs in with the right password and sends back the workspaces', async () => {
      const account = await new Client(server).signup('Login Person')
      const browser = new Client(server)
      const reply = await browser.post('/api/auth/login', { email: account.email.toUpperCase(), password: account.password })
      assert.equal(reply.status, 200)
      assert.equal(reply.body.user.id, account.user.id)
      assert.equal(reply.body.workspaces[0].id, account.workspace.id)
      assert.ok(browser.cookie)
      assert.equal((await browser.get('/api/auth/me')).status, 200)
    })

    it('gives the same answer for a wrong password and for an unknown email', async () => {
      const account = await new Client(server).signup('Quiet')
      const wrongPassword = await new Client(server).post('/api/auth/login', { email: account.email, password: 'definitely not it' })
      const unknownEmail = await new Client(server).post('/api/auth/login', { email: 'nobody-here@example.com', password: 'definitely not it' })
      assert.equal(wrongPassword.status, 401)
      assert.equal(unknownEmail.status, 401)
      assert.deepEqual(wrongPassword.body, unknownEmail.body)
      assert.equal(wrongPassword.setCookies.length, 0)
    })

    it('gives a new session on every sign-in and retires the old one from that browser', async () => {
      const account = await new Client(server).signup('Twice')
      const browser = new Client(server)
      await browser.post('/api/auth/login', { email: account.email, password: account.password })
      const first = browser.cookie
      await browser.post('/api/auth/login', { email: account.email, password: account.password })
      assert.notEqual(browser.cookie, first)
      const stale = new Client(server)
      stale.cookie = first
      assert.equal((await stale.get('/api/auth/me')).status, 401)
      assert.equal((await browser.get('/api/auth/me')).status, 200)
    })

    it('logs out: the cookie is cleared and the old cookie stops working everywhere', async () => {
      const client = new Client(server)
      await client.signup('Bye')
      const stolen = new Client(server)
      stolen.cookie = client.cookie
      const reply = await client.post('/api/auth/logout')
      assert.equal(reply.status, 204)
      assert.ok(reply.setCookies.some((line) => /^conflux_session=;/.test(line)), 'cookie is cleared')
      assert.equal((await stolen.get('/api/auth/me')).status, 401, 'a copy of the cookie is useless after logout')
    })

    it('is harmless to log out when nobody is signed in', async () => {
      assert.equal((await new Client(server).post('/api/auth/logout')).status, 204)
    })

    it('answers 401 without a cookie, with junk, and with the right shape but the wrong secret', async () => {
      assert.equal((await new Client(server).get('/api/auth/me')).status, 401)
      for (const value of ['', 'x', 'a'.repeat(43), 'a'.repeat(500), '../../etc/passwd']) {
        const client = new Client(server)
        client.cookie = `conflux_session=${encodeURIComponent(value)}`
        assert.equal((await client.get('/api/auth/me')).status, 401, value)
      }
    })

    it('stops working when the session has expired', async () => {
      const client = new Client(server)
      const { user } = await client.signup('Expiring')
      await server.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, user.id))
      assert.equal((await client.get('/api/auth/me')).status, 401)
    })

    it('extends an active session, but only about once an hour', async () => {
      const client = new Client(server)
      const { user } = await client.signup('Sliding')
      const soon = new Date(Date.now() + 24 * 3600_000)
      await server.db.update(sessions).set({ expiresAt: soon }).where(eq(sessions.userId, user.id))
      await client.get('/api/auth/me')
      const [untouched] = await server.db.select().from(sessions).where(eq(sessions.userId, user.id))
      assert.equal(untouched.expiresAt.getTime(), soon.getTime(), 'a fresh session is not rewritten on every request')

      await server.db.update(sessions).set({ lastSeenAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(sessions.userId, user.id))
      await client.get('/api/auth/me')
      const [extended] = await server.db.select().from(sessions).where(eq(sessions.userId, user.id))
      assert.ok(extended.expiresAt.getTime() > Date.now() + 29 * 24 * 3600_000)
    })

    it('renews the cookie together with the session, so the browser keeps it as long as the server does', async () => {
      const client = new Client(server)
      const { user } = await client.signup('Renewed')
      assert.equal((await client.get('/api/auth/me')).setCookies.length, 0, 'a fresh session is not re-sent on every request')
      await server.db.update(sessions).set({ lastSeenAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(sessions.userId, user.id))
      const renewed = await client.get('/api/auth/me')
      assert.equal(renewed.setCookies.length, 1)
      const line = renewed.setCookies[0]
      const expires = new Date(/expires=([^;]+)/i.exec(line)?.[1] ?? '').getTime()
      assert.ok(Math.abs(expires - (Date.now() + 30 * 86_400_000)) < 60_000, line)
      assert.match(line, /HttpOnly/i)
      assert.match(line, /SameSite=Lax/i)
      assert.match(line, /Path=\//)
    })

    it('ends a session 90 days after signing in, however often it is used', async () => {
      const client = new Client(server)
      const { user } = await client.signup('Endless')
      const signedInAt = Date.now() - 89 * 86_400_000
      await server.db
        .update(sessions)
        .set({ createdAt: new Date(signedInAt), lastSeenAt: new Date(Date.now() - 2 * 3600_000), expiresAt: new Date(Date.now() + 10 * 86_400_000) })
        .where(eq(sessions.userId, user.id))
      const reply = await client.get('/api/auth/me')
      assert.equal(reply.status, 200)
      const [row] = await server.db.select().from(sessions).where(eq(sessions.userId, user.id))
      const limit = signedInAt + 90 * 86_400_000
      assert.ok(row.expiresAt.getTime() <= limit + 1000, 'not extended past the 90 days')
      assert.ok(row.expiresAt.getTime() > Date.now() + 23 * 3600_000, 'the last day is still there')
      const cookieExpiry = new Date(/expires=([^;]+)/i.exec(reply.setCookies[0] ?? '')?.[1] ?? '').getTime()
      assert.ok(Math.abs(cookieExpiry - limit) < 2000, 'the cookie ends at the same time')
    })

    it('stops working when the account is deleted', async () => {
      const client = new Client(server)
      const { user } = await client.signup('Gone')
      await server.db.delete(users).where(eq(users.id, user.id))
      assert.equal((await client.get('/api/auth/me')).status, 401)
    })
  })

  describe('profile', () => {
    it('changes the display name, with the same rules as sign-up', async () => {
      const client = new Client(server)
      await client.signup('Before')
      const ok = await client.patch('/api/auth/me', { displayName: ' After  Name ' })
      assert.equal(ok.status, 200)
      assert.equal(ok.body.user.displayName, 'After Name')
      assert.equal((await client.get('/api/auth/me')).body.user.displayName, 'After Name')
      assert.equal((await client.patch('/api/auth/me', { displayName: '' })).status, 400)
      assert.equal((await client.patch('/api/auth/me', { displayName: 'evil‮eman' })).status, 400)
    })

    it('does not let the email, id or password be changed this way', async () => {
      const client = new Client(server)
      const account = await client.signup('Fixed')
      for (const body of [{ email: 'new@example.com' }, { id: account.user.id }, { password: 'a new password!' }, { displayName: 'X', email: 'x@example.com' }]) {
        assert.equal((await client.patch('/api/auth/me', body)).status, 400, JSON.stringify(body))
      }
      assert.equal((await client.get('/api/auth/me')).body.user.email, account.user.email)
    })

    it('needs a session', async () => {
      assert.equal((await new Client(server).patch('/api/auth/me', { displayName: 'Nope' })).status, 401)
    })
  })
})

describe('cookie settings behind HTTPS', () => {
  it('uses the __Host- prefix, Secure, and HSTS when cookies are secure', async () => {
    const server = await startTestServer({ env: { CONFLUX_COOKIE_SECURE: 'true' } })
    try {
      const client = new Client(server)
      const reply = await client.post('/api/auth/signup', { email: 'secure@example.com', password: PASSWORD, displayName: 'Secure' })
      const line = reply.setCookies[0]
      assert.match(line, /^__Host-conflux_session=/)
      assert.match(line, /;\s*Secure/i)
      assert.match(line, /;\s*HttpOnly/i)
      assert.match(line, /;\s*SameSite=Lax/i)
      assert.match(line, /;\s*Path=\//i)
      assert.ok(!/;\s*Domain=/i.test(line), '__Host- cookies must not have a Domain')
      assert.match(reply.headers.get('strict-transport-security') ?? '', /max-age=\d+/)
      assert.equal((await client.get('/api/auth/me')).status, 200)
      const out = await client.post('/api/auth/logout')
      assert.match(out.setCookies[0], /^__Host-conflux_session=;/)
      assert.match(out.setCookies[0], /;\s*Secure/i)
    } finally {
      await server.close()
    }
  })

  it('does not send HSTS over plain HTTP (local development)', async () => {
    const server = await startTestServer()
    try {
      assert.equal((await new Client(server).get('/api/health')).headers.get('strict-transport-security'), null)
    } finally {
      await server.close()
    }
  })
})

describe('limits on sign-in attempts', () => {
  let server: TestServer
  before(async () => {
    server = await startTestServer({ env: { CONFLUX_RATE_LIMIT_SCALE: '1' } })
  })
  after(async () => {
    await server.close()
  })

  it('locks guessing against one account after 6 tries, but only for that address and account', async () => {
    const victim = await new Client(server).signup('Victim')
    const attacker = new Client(server)
    for (let i = 0; i < 6; i++) {
      const reply = await attacker.post('/api/auth/login', { email: victim.email, password: `wrong guess number ${i}` })
      assert.equal(reply.status, 401)
    }
    const blocked = await attacker.post('/api/auth/login', { email: victim.email, password: victim.password })
    assert.equal(blocked.status, 429, 'even the right password is refused during the lock')
    assert.equal(blocked.body.error.code, 'rate_limited')
    assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/)

    const other = await attacker.post('/api/auth/login', { email: 'someone-else@example.com', password: 'whatever it is' })
    assert.equal(other.status, 401, 'a different account is not locked by this')
  })

  it('limits one address trying many accounts', async () => {
    const attacker = new Client(server)
    let limitedAt = -1
    for (let i = 0; i < 40; i++) {
      const reply = await attacker.post('/api/auth/login', { email: `spray${i}@example.com`, password: 'password spraying' })
      if (reply.status === 429) {
        limitedAt = i
        break
      }
      assert.equal(reply.status, 401)
    }
    assert.ok(limitedAt > 0 && limitedAt <= 20, `limited after ${limitedAt} tries`)
  })
})

describe('limits on sign-ups', () => {
  it('allows 10 an hour from one address, then answers 429 with Retry-After', async () => {
    const server = await startTestServer({ env: { CONFLUX_RATE_LIMIT_SCALE: '1' } })
    try {
      for (let i = 0; i < 10; i++) await new Client(server).signup(`Person ${i}`)
      const reply = await new Client(server).post('/api/auth/signup', { email: 'eleven@example.com', password: PASSWORD, displayName: 'Eleven' })
      assert.equal(reply.status, 429)
      assert.match(reply.headers.get('retry-after') ?? '', /^\d+$/)
      assert.equal((await server.db.select().from(users).where(eq(users.email, 'eleven@example.com'))).length, 0)
    } finally {
      await server.close()
    }
  })

  it('sheds load instead of hashing without limit when too many hashes start at once', async () => {
    const server = await startTestServer({ patch: (config) => ({ ...config, limits: { ...config.limits, hashesPerSecond: 1 } }) })
    try {
      const replies = await Promise.all(
        Array.from({ length: 6 }, (_, i) => new Client(server).post('/api/auth/signup', { email: `burst${i}@example.com`, password: PASSWORD, displayName: `B${i}` })),
      )
      const statuses = replies.map((reply) => reply.status)
      assert.equal(statuses.filter((status) => status === 201).length, 2, 'a burst of two is allowed')
      assert.equal(statuses.filter((status) => status === 503).length, 4)
      const busy = replies.find((reply) => reply.status === 503)!
      assert.equal(busy.body.error.code, 'busy')
      assert.ok(busy.headers.get('retry-after'))
    } finally {
      await server.close()
    }
  })
})
