import * as Y from 'yjs'
import { createInviteLink, expect, pageIdOf, pageText, test, typeAtEnd, type Person } from './helpers'
import { scriptedPerson } from './scripted'

const inviteToken = async (owner: Person, role: 'editor' | 'viewer') => (await createInviteLink(owner, role)).split('#/join/')[1]

test.describe('presence from a script', () => {
  test('a viewer who sends malformed cursors cannot break the editors on the page', async ({ app, baseURL }) => {
    const ana = await app.signUp('Ana')
    const errors: string[] = []
    ana.page.on('pageerror', (error) => errors.push(error.message))
    const viewer = await scriptedPerson(baseURL!, await inviteToken(ana, 'viewer'), `page.${pageIdOf(ana.page)}`)
    try {
      await typeAtEnd(ana.page, ' first')
      await expect.poll(() => pageText(ana.page)).toContain('first')

      const hostile: unknown[] = [
        { anchor: null, head: null },
        {},
        [],
        { anchor: 5, head: 'x' },
        { anchor: { type: { client: 'a', clock: 'b' } }, head: { type: null } },
        { anchor: { type: null, tname: null, item: null, assoc: 0 }, head: { tname: 'content' } },
        { anchor: { tname: 'not-the-text' }, head: { tname: 'not-the-text' } },
      ]
      for (const cursor of hostile) {
        viewer.provider.awareness!.setLocalStateField('cursor', cursor)
        await ana.page.waitForTimeout(300)
        const before = (await pageText(ana.page)).length
        await ana.page.keyboard.type('x')
        await expect
          .poll(async () => (await pageText(ana.page)).length, { message: `typing still works after ${JSON.stringify(cursor)}` })
          .toBeGreaterThan(before)
      }
      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      viewer.close()
    }
  })

  test('a real cursor from a script still shows up, so the checks are not just hiding everything', async ({ app, baseURL }) => {
    const ana = await app.signUp('Ana')
    const errors: string[] = []
    ana.page.on('pageerror', (error) => errors.push(error.message))
    const viewer = await scriptedPerson(baseURL!, await inviteToken(ana, 'viewer'), `page.${pageIdOf(ana.page)}`)
    try {
      await expect.poll(() => viewer.text.length).toBeGreaterThan(0)
      const anchor = Y.createRelativePositionFromTypeIndex(viewer.text, 1)
      const head = Y.createRelativePositionFromTypeIndex(viewer.text, 2)
      viewer.provider.awareness!.setLocalStateField('cursor', { anchor, head })
      await expect(ana.page.locator('.doc .collaboration-carets__caret')).toContainText('Script')
      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      viewer.close()
    }
  })
})
