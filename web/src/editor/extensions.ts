import { TaskItem, TaskList } from '@tiptap/extension-list'
import StarterKit from '@tiptap/starter-kit'

export function createSchemaExtensions() {
  return [StarterKit.configure({ undoRedo: false }), TaskList, TaskItem.configure({ nested: true })]
}
