import assert from 'node:assert/strict'
import { PAGE_TEXT_FIELD } from '@conflux/shared'
import { getSchema } from '@tiptap/core'
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { createSchemaExtensions } from '../../web/src/editor/extensions'
export const editorSchema = getSchema(createSchemaExtensions())
export function editorView(doc: Y.Doc) {
  const before = Y.encodeStateAsUpdate(doc)
  const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(PAGE_TEXT_FIELD), editorSchema)
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before, 'the editor had to throw part of the page away')
  root.check() // throws if some node's content is not what the schema allows
  return root
}
