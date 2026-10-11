import type { Editor } from 'obsidian';
import type { ActiveNoteContext } from '../types';

export function selectionContext(
  editor: Pick<Editor, 'getSelection' | 'getCursor'>,
  note: Pick<ActiveNoteContext, 'path' | 'title' | 'mtime'>,
): ActiveNoteContext | undefined {
  const content = editor.getSelection();
  if (!content.trim()) return undefined;
  return { ...note, content, isSelection: true, lineStart: editor.getCursor('from').line + 1 };
}
