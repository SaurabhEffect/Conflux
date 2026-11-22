import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LIMITS,
  createInviteBody,
  createPageBody,
  displayNameSchema,
  emailSchema,
  inviteTokenSchema,
  loginBody,
  passwordSchema,
  signupBody,
  updateMemberBody,
} from '../src/index'

describe('signup input', () => {
  const good = { email: '  Saru@Example.COM ', password: 'correct horse battery', displayName: '  Saru   C  ' }

  it('cleans up email and name', () => {
    const parsed = signupBody.parse(good)
    assert.equal(parsed.email, 'saru@example.com')
    assert.equal(parsed.displayName, 'Saru C')
    assert.equal(parsed.password, good.password)
  })

  it('rejects unknown fields (no sneaking in a role or an id)', () => {
    assert.equal(signupBody.safeParse({ ...good, role: 'owner' }).success, false)
    assert.equal(signupBody.safeParse({ ...good, id: '1' }).success, false)
  })

  it('rejects bad emails', () => {
    for (const email of ['', 'nope', 'a@', '@b.com', 'a b@c.com', `${'a'.repeat(250)}@x.com`]) {
      assert.equal(emailSchema.safeParse(email).success, false, email)
    }
  })

  it('enforces password length and never trims it', () => {
    assert.equal(passwordSchema.safeParse('short').success, false)
    assert.equal(passwordSchema.safeParse('x'.repeat(LIMITS.passwordMax + 1)).success, false)
    assert.equal(passwordSchema.parse('  spaces are fine  '), '  spaces are fine  ')
  })

  it('refuses names with hidden or control characters', () => {
    assert.equal(displayNameSchema.safeParse('Evil‮eman').success, false)
    assert.equal(displayNameSchema.safeParse('bell\u0007').success, false)
    assert.equal(displayNameSchema.safeParse('line\nbreak').success, true) // folded into one space
    assert.equal(displayNameSchema.parse('line\nbreak'), 'line break')
    assert.equal(displayNameSchema.safeParse('   ').success, false)
    assert.equal(displayNameSchema.safeParse('x'.repeat(LIMITS.displayNameMax + 1)).success, false)
  })

  it('keeps emoji and non-latin names working', () => {
    assert.equal(displayNameSchema.parse('सरु'), 'सरु')
    assert.equal(displayNameSchema.parse('Sam 👩‍💻'), 'Sam 👩‍💻')
  })
})

describe('other bodies', () => {
  it('login does not apply the signup password rules', () => {
    assert.equal(loginBody.safeParse({ email: 'a@b.co', password: 'x' }).success, true)
  })

  it('invites cannot grant owner and have sane defaults', () => {
    assert.equal(createInviteBody.safeParse({ role: 'owner' }).success, false)
    const parsed = createInviteBody.parse({ role: 'viewer' })
    assert.equal(parsed.expiresInHours, LIMITS.inviteDefaultHours)
    assert.equal(parsed.maxUses, LIMITS.inviteDefaultUses)
    assert.equal(createInviteBody.safeParse({ role: 'viewer', maxUses: 0 }).success, false)
    assert.equal(createInviteBody.safeParse({ role: 'viewer', maxUses: 1.5 }).success, false)
    assert.equal(createInviteBody.safeParse({ role: 'viewer', expiresInHours: LIMITS.inviteMaxHours + 1 }).success, false)
  })

  it('member updates accept only the three roles', () => {
    assert.equal(updateMemberBody.safeParse({ role: 'editor' }).success, true)
    assert.equal(updateMemberBody.safeParse({ role: 'admin' }).success, false)
  })

  it('invite tokens must look like 32 random bytes in base64url', () => {
    assert.equal(inviteTokenSchema.safeParse('A'.repeat(43)).success, true)
    assert.equal(inviteTokenSchema.safeParse('A'.repeat(42)).success, false)
    assert.equal(inviteTokenSchema.safeParse('A'.repeat(42) + '+').success, false)
  })

  it('page titles may be empty but not hidden-character tricks', () => {
    assert.equal(createPageBody.parse({}).title, '')
    assert.equal(createPageBody.safeParse({ title: 'ok‮' }).success, false)
    assert.equal(createPageBody.safeParse({ title: 'x'.repeat(LIMITS.pageTitleMax + 1) }).success, false)
  })
})
