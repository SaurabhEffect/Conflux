import type { HocuspocusProvider } from '@hocuspocus/provider'
import { Collaboration } from '@tiptap/extension-collaboration'
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import type * as Y from 'yjs'
import type { Identity } from '../identity'
import { pendingSeeds } from '../session'
import { Toolbar } from './Toolbar'

type Props = {
  pageId: string
  doc: Y.Doc
  provider: HocuspocusProvider
  user: Identity
}

export function PageEditor({ pageId, doc, provider, user }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Collaboration.configure({ document: doc, field: 'content' }),
      CollaborationCaret.configure({ provider, user: { name: user.name, color: user.color } }),
    ],
    editorProps: {
      attributes: { class: 'doc', 'aria-label': 'Page content', spellcheck: 'true' },
    },
  })

  useEffect(() => {
    if (!editor) return
    const seed = pendingSeeds.get(pageId)
    if (!seed) return
    pendingSeeds.delete(pageId)
    if (editor.isEmpty) editor.commands.setContent(seed)
  }, [editor, pageId])

  if (!editor) return null
  return (
    <>
      <Toolbar editor={editor} />
      <div className="page-scroll">
        <div className="doc-wrap">
          <EditorContent editor={editor} />
        </div>
      </div>
    </>
  )
}
