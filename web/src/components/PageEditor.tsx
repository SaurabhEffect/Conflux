import { PAGE_TEXT_FIELD } from '@conflux/shared'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { Collaboration } from '@tiptap/extension-collaboration'
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect } from 'react'
import type * as Y from 'yjs'
import { createSchemaExtensions } from '../editor/extensions'
import { pendingSeeds } from '../session'
import { Toolbar } from './Toolbar'

type Props = {
  pageId: string
  doc: Y.Doc
  provider: HocuspocusProvider
  user: { name: string; color: string }
  editable: boolean
}

export function PageEditor({ pageId, doc, provider, user, editable }: Props) {
  const editor = useEditor({
    editable,
    extensions: [
      ...createSchemaExtensions(),
      Placeholder.configure({ placeholder: editable ? 'Start writing…' : 'This page is empty.' }),
      Collaboration.configure({ document: doc, field: PAGE_TEXT_FIELD }),
      CollaborationCaret.configure({ provider, user }),
    ],
    editorProps: {
      attributes: { class: 'doc', 'aria-label': 'Page content', 'aria-readonly': String(!editable), spellcheck: 'true' },
    },
  })

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (!editor || !editable) return
    const seed = pendingSeeds.get(pageId)
    if (!seed) return
    pendingSeeds.delete(pageId)
    if (editor.isEmpty) editor.commands.setContent(seed)
  }, [editor, pageId, editable])

  if (!editor) return null
  return (
    <>
      {editable && <Toolbar editor={editor} />}
      <div className="page-scroll">
        <div className="doc-wrap">
          <EditorContent editor={editor} />
        </div>
      </div>
    </>
  )
}
