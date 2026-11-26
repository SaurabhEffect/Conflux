import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ACTIONS, can, isRole, parseDocName, pageDocName, workspaceDocName, type Action, type Role } from '../src/index'

const EXPECTED: Record<Action, Role[]> = {
  'workspace:read': ['owner', 'editor', 'viewer'],
  'workspace:leave': ['owner', 'editor', 'viewer'],
  'members:read': ['owner', 'editor', 'viewer'],
  'page:read': ['owner', 'editor', 'viewer'],
  'page:edit': ['owner', 'editor'],
  'page:create': ['owner', 'editor'],
  'page:move': ['owner', 'editor'],
  'page:delete': ['owner', 'editor'],
  'workspace:rename': ['owner'],
  'workspace:delete': ['owner'],
  'members:manage': ['owner'],
}

describe('can()', () => {
  for (const action of ACTIONS) {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      it(`${role} ${EXPECTED[action].includes(role) ? 'may' : 'may not'} ${action}`, () => {
        assert.equal(can(role, action), EXPECTED[action].includes(role))
      })
    }
    it(`a non-member may not ${action}`, () => {
      assert.equal(can(null, action), false)
      assert.equal(can(undefined, action), false)
    })
  }

  it('has a rule for every action', () => {
    assert.deepEqual([...ACTIONS].sort(), Object.keys(EXPECTED).sort())
  })

  it('treats unknown roles as no access', () => {
    assert.equal(can('admin' as Role, 'page:read'), false)
  })

  it('recognises valid roles only', () => {
    assert.equal(isRole('owner'), true)
    assert.equal(isRole('superuser'), false)
    assert.equal(isRole(undefined), false)
  })
})

describe('document names', () => {
  const id = '4f8f8d3e-2d0a-4d5c-9a43-0b8e3e1f6a10'

  it('round-trips page and workspace names', () => {
    assert.deepEqual(parseDocName(pageDocName(id)), { kind: 'page', id })
    assert.deepEqual(parseDocName(workspaceDocName(id)), { kind: 'workspace', id })
  })

  it('rejects anything that is not exactly kind.uuid', () => {
    const bad = [
      '',
      'page',
      'page.',
      `page:${id}`,
      `page.${id.toUpperCase()}`,
      `page.${id}.extra`,
      ` page.${id}`,
      `page.${id}\n`,
      `Page.${id}`,
      `admin.${id}`,
      `page.${id.slice(1)}`,
      'page.../../etc/passwd',
      "page.'; drop table pages;--",
      'workspace',
    ]
    for (const name of bad) assert.equal(parseDocName(name), null, JSON.stringify(name))
  })
})
