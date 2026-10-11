import { describe, expect, it, vi } from 'vitest';
import { selectionContext } from '../src/ui/selection-context';

describe('selected note context', () => {
  it('preserves the exact selection and its original line number', () => {
    const editor = { getSelection: () => '  Текст\nВторая строка  ', getCursor: vi.fn(() => ({ line: 6, ch: 2 })) };
    expect(selectionContext(editor, { path: 'Note.md', title: 'Note', mtime: 1 })).toEqual({
      path: 'Note.md', title: 'Note', mtime: 1, content: '  Текст\nВторая строка  ', isSelection: true, lineStart: 7,
    });
    expect(editor.getCursor).toHaveBeenCalledWith('from');
  });
  it('ignores an empty or whitespace-only selection', () => {
    const editor = { getSelection: () => ' \n ', getCursor: vi.fn(() => ({ line: 0, ch: 0 })) };
    expect(selectionContext(editor, { path: 'Note.md', title: 'Note', mtime: 1 })).toBeUndefined();
    expect(editor.getCursor).not.toHaveBeenCalled();
  });
});
