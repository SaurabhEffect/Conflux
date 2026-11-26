import * as Y from 'yjs'
import { createInviteLink, expect, pageIdOf, pageText, test, typeAtEnd } from './helpers'
import { scriptedPerson } from './scripted'

test.describe('content from a script', () => {
  async function pageWithScriptedEditor(app: Parameters<Parameters<typeof test>[2]>[0]['app'], baseURL: string) {
    const ana = await app.signUp('Ana')
    const errors: string[] = []
    ana.page.on('pageerror', (error) => errors.push(error.message))
    const token = (await createInviteLink(ana, 'editor')).split('#/join/')[1]
    const editor = await scriptedPerson(baseURL, token, `page.${pageIdOf(ana.page)}`)
    await expect.poll(() => editor.text.length).toBeGreaterThan(0)
    return { ana, errors, editor }
  }

  test('a javascript: link becomes a harmless link on everyone\'s screen', async ({ app, baseURL }) => {
    const { ana, errors, editor } = await pageWithScriptedEditor(app, baseURL!)
    try {
      const paragraph = new Y.XmlElement('paragraph')
      const words = new Y.XmlText()
      words.insert(0, 'click me', { link: { href: 'javascript:window.__pwned=true', target: '_blank', rel: 'noopener noreferrer', class: null } })
      paragraph.insert(0, [words])
      editor.text.insert(editor.text.length, [paragraph])

      await expect.poll(() => pageText(ana.page)).toContain('click me')
      const link = ana.page.locator('.doc a', { hasText: /^click me$/ })
      await expect(link).toHaveCount(1)
      const href = (await link.getAttribute('href')) ?? ''
      expect(href.toLowerCase().replace(/\s/g, ''), `the link points at: ${href}`).not.toMatch(/^(javascript|data|vbscript):/)
      expect(await ana.page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined()
      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      editor.close()
    }
  })

  test('content that breaks the editor\'s rules cannot inject markup or stop the page working', async ({ app, baseURL }) => {
    const { ana, errors, editor } = await pageWithScriptedEditor(app, baseURL!)
    try {
      const element = (name: string, attributes: Record<string, string> = {}, ...children: Array<Y.XmlElement | Y.XmlText>) => {
        const made = new Y.XmlElement(name)
        for (const [key, value] of Object.entries(attributes)) made.setAttribute(key, value)
        if (children.length) made.insert(0, children)
        return made
      }
      let nested: Y.XmlElement = element('paragraph')
      for (let i = 0; i < 300; i++) nested = element('bulletList', {}, element('listItem', {}, nested))
      const hostile: Array<[string, Y.XmlElement]> = [
        ['an element the editor does not know', element('script', { src: 'https://evil.example/x.js' }, new Y.XmlText('alert(1)'))],
        ['a document inside a paragraph', element('paragraph', {}, element('doc'))],
        ['a heading with markup as its level', element('heading', { level: '"><img src=x onerror=alert(1)>' }, new Y.XmlText('Strange heading'))],
        ['a code block with an attribute as its language', element('codeBlock', { language: '" onmouseover="alert(1)' }, new Y.XmlText('some code'))],
        ['a list nested 300 deep', nested],
      ]
      for (const [label, node] of hostile) {
        editor.text.insert(editor.text.length, [node])
        await ana.page.waitForTimeout(400)
        const before = (await pageText(ana.page)).length
        await typeAtEnd(ana.page, 'ok')
        await expect.poll(async () => (await pageText(ana.page)).length, { message: `typing works after ${label}` }).toBeGreaterThan(before)
      }

      const dangerous = await ana.page.evaluate(() => {
        const found: string[] = []
        for (const element of document.querySelectorAll('.doc, .doc *')) {
          const helper = element.matches('img.ProseMirror-separator') // the editor's own
          if (!helper && /^(script|img|iframe|object|embed|style|link|svg|form|textarea|button|select)$/i.test(element.tagName)) found.push(element.outerHTML.slice(0, 80))
          for (const attribute of Array.from(element.attributes)) if (/^on/i.test(attribute.name)) found.push(`${element.tagName}[${attribute.name}]`)
        }
        return found
      })
      expect(dangerous).toEqual([])
      await expect(ana.page.locator('.doc')).toHaveAttribute('contenteditable', 'true')
      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      editor.close()
    }
  })
})
