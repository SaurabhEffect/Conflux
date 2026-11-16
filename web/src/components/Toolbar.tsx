import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icons'

type ButtonProps = {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}

function ToolButton({ label, active = false, disabled = false, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      className={`tb-btn${active ? ' is-active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // Keep the text selection in the editor when the button is pressed.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      h1: editor.isActive('heading', { level: 1 }),
      h2: editor.isActive('heading', { level: 2 }),
      h3: editor.isActive('heading', { level: 3 }),
      bullet: editor.isActive('bulletList'),
      ordered: editor.isActive('orderedList'),
      task: editor.isActive('taskList'),
      quote: editor.isActive('blockquote'),
      codeBlock: editor.isActive('codeBlock'),
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
    }),
  })

  const run = () => editor.chain().focus()
  const icon = (name: IconName) => <Icon name={name} size={17} />
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <ToolButton label="Undo" disabled={!s.canUndo} onClick={() => run().undo().run()}>
        {icon('undo')}
      </ToolButton>
      <ToolButton label="Redo" disabled={!s.canRedo} onClick={() => run().redo().run()}>
        {icon('redo')}
      </ToolButton>
      <span className="tb-sep" aria-hidden="true" />
      <ToolButton label="Bold" active={s.bold} onClick={() => run().toggleBold().run()}>
        {icon('bold')}
      </ToolButton>
      <ToolButton label="Italic" active={s.italic} onClick={() => run().toggleItalic().run()}>
        {icon('italic')}
      </ToolButton>
      <ToolButton label="Strikethrough" active={s.strike} onClick={() => run().toggleStrike().run()}>
        {icon('strike')}
      </ToolButton>
      <ToolButton label="Inline code" active={s.code} onClick={() => run().toggleCode().run()}>
        {icon('code')}
      </ToolButton>
      <span className="tb-sep" aria-hidden="true" />
      <ToolButton label="Heading 1" active={s.h1} onClick={() => run().toggleHeading({ level: 1 }).run()}>
        <span className="tb-text">H1</span>
      </ToolButton>
      <ToolButton label="Heading 2" active={s.h2} onClick={() => run().toggleHeading({ level: 2 }).run()}>
        <span className="tb-text">H2</span>
      </ToolButton>
      <ToolButton label="Heading 3" active={s.h3} onClick={() => run().toggleHeading({ level: 3 }).run()}>
        <span className="tb-text">H3</span>
      </ToolButton>
      <span className="tb-sep" aria-hidden="true" />
      <ToolButton label="Bulleted list" active={s.bullet} onClick={() => run().toggleBulletList().run()}>
        {icon('list')}
      </ToolButton>
      <ToolButton label="Numbered list" active={s.ordered} onClick={() => run().toggleOrderedList().run()}>
        {icon('listOrdered')}
      </ToolButton>
      <ToolButton label="To-do list" active={s.task} onClick={() => run().toggleTaskList().run()}>
        {icon('listTodo')}
      </ToolButton>
      <span className="tb-sep" aria-hidden="true" />
      <ToolButton label="Quote" active={s.quote} onClick={() => run().toggleBlockquote().run()}>
        {icon('quote')}
      </ToolButton>
      <ToolButton label="Code block" active={s.codeBlock} onClick={() => run().toggleCodeBlock().run()}>
        {icon('codeBlock')}
      </ToolButton>
      <ToolButton label="Divider" onClick={() => run().setHorizontalRule().run()}>
        {icon('rule')}
      </ToolButton>
    </div>
  )
}
