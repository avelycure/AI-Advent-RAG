import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import type { ChatController } from '../src/ui/chat-controller';
vi.mock('obsidian', () => ({ ItemView: class {}, Notice: class {}, setIcon: vi.fn() }));
import { ChatView } from '../src/ui/chat-view';

function event(type: string, properties: Record<string, unknown> = {}) {
  const value = new Event(type, { cancelable: true });
  Object.assign(value, { button: 0, clientX: 0, clientY: 0, detail: 1, ...properties });
  return value;
}
function setup() {
  const selectDialog = vi.fn();
  const deleteDialog = vi.fn();
  const view = new ChatView({} as WorkspaceLeaf, { chatController: { selectDialog, deleteDialog } as unknown as ChatController, openSource: async () => {}, insertAnswer: vi.fn() });
  const tab = Object.assign(new EventTarget(), { setAttribute: vi.fn(), ownerDocument: { defaultView: { setTimeout, clearTimeout } } });
  const internal = view as unknown as {
    attachDialogActions(tab: HTMLButtonElement, id: string): void;
    openModelMenu(tab: HTMLButtonElement, id: string): void;
  };
  const open = vi.spyOn(internal, 'openModelMenu').mockImplementation(() => {});
  internal.attachDialogActions(tab as unknown as HTMLButtonElement, 'dialog');
  return { tab, open, selectDialog, deleteDialog };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('dialog long press', () => {
  it('opens settings after holding and suppresses selection and context deletion', () => {
    const { tab, open, selectDialog, deleteDialog } = setup();
    tab.dispatchEvent(event('pointerdown'));
    vi.advanceTimersByTime(550);
    tab.dispatchEvent(event('pointerup'));
    tab.dispatchEvent(event('click'));
    tab.dispatchEvent(event('contextmenu'));
    expect(open).toHaveBeenCalledOnce();
    expect(selectDialog).not.toHaveBeenCalled();
    expect(deleteDialog).not.toHaveBeenCalled();
  });
  it('preserves normal clicks and secondary-click deletion', () => {
    const { tab, open, selectDialog, deleteDialog } = setup();
    tab.dispatchEvent(event('pointerdown'));
    tab.dispatchEvent(event('pointerup'));
    tab.dispatchEvent(event('click'));
    vi.advanceTimersByTime(600);
    expect(open).not.toHaveBeenCalled();
    expect(selectDialog).toHaveBeenCalledWith('dialog');
    tab.dispatchEvent(event('contextmenu'));
    expect(deleteDialog).toHaveBeenCalledWith('dialog');
  });
  it('cancels long press when moving to drag or when the pointer is cancelled', () => {
    const { tab, open } = setup();
    tab.dispatchEvent(event('pointerdown'));
    tab.dispatchEvent(event('pointermove', { clientX: 20 }));
    vi.advanceTimersByTime(600);
    expect(open).not.toHaveBeenCalled();
    tab.dispatchEvent(event('pointerdown'));
    tab.dispatchEvent(event('pointercancel'));
    vi.advanceTimersByTime(600);
    expect(open).not.toHaveBeenCalled();
  });
});
