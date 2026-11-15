// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScoreLibraryPanel, useScoreLibrary } from '../src/library/ScoreLibraryPanel';
import { MemoryDirectoryHandle, MemoryFileHandle } from './file-system-fixture';

const bookmarks = vi.hoisted(() => ({ load: vi.fn(), remember: vi.fn(), picker: vi.fn() }));
vi.mock('../src/library/browser-library', async importOriginal => ({
    ...(await importOriginal<typeof import('../src/library/browser-library')>()),
    loadRememberedDirectory: bookmarks.load,
    rememberDirectory: bookmarks.remember
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];

async function mount() {
    let current!: ReturnType<typeof useScoreLibrary>;
    const open = vi.fn(async (_handle: FileSystemFileHandle) => {});
    const beforeChange = vi.fn();
    function Probe() {
        current = useScoreLibrary();
        return <ScoreLibraryPanel library={current} onOpenFile={open} onBeforeChange={beforeChange} />;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<Probe />));
    return { current: () => current, container, open, beforeChange };
}

beforeEach(() => {
    bookmarks.load.mockResolvedValue(null);
    bookmarks.remember.mockResolvedValue(undefined);
    vi.stubGlobal('showDirectoryPicker', bookmarks.picker);
});

afterEach(async () => {
    await act(async () => {
        for (const root of roots.splice(0)) {
            root.unmount();
        }
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('score library controls', () => {
    it('connects the selected folder, remembers the handle and opens a chosen score', async () => {
        const folder = new MemoryDirectoryHandle();
        const file = new MemoryFileHandle('existing.gp');
        folder.children.set(file.name, file);
        folder.children.set('not-a-score.pdf', new MemoryFileHandle('not-a-score.pdf'));
        bookmarks.picker.mockResolvedValue(folder);
        const page = await mount();
        expect(bookmarks.picker).not.toHaveBeenCalled();
        await act(async () => page.current().choose());
        expect(bookmarks.picker).toHaveBeenCalledWith(expect.objectContaining({ mode: 'readwrite', startIn: 'music' }));
        expect(bookmarks.remember).toHaveBeenCalledWith(folder);
        expect(page.current().files.map(entry => entry.name)).toEqual(['existing.gp']);
        await act(async () => page.current().setSelectedName('existing.gp'));
        const button = [...page.container.querySelectorAll('button')].find(item => item.textContent === 'Open');
        if (!button) {
            throw new Error('The library Open button is missing.');
        }
        await act(async () => button.click());
        expect(page.open).toHaveBeenCalledWith(file);
    });

    it('restores a handle without requesting permission until the user reconnects', async () => {
        const folder = new MemoryDirectoryHandle();
        folder.permission = 'prompt';
        folder.children.set('existing.gp', new MemoryFileHandle('existing.gp'));
        bookmarks.load.mockResolvedValue(folder);
        const page = await mount();
        expect(folder.permissionRequests).toBe(0);
        expect(page.current().ready).toBe(false);
        expect(page.container.textContent).toContain('Reconnect');
        await act(async () => page.current().reconnect());
        expect(folder.permissionRequests).toBe(1);
        expect(page.current().ready).toBe(true);
        expect(page.current().files).toHaveLength(1);
    });

    it('refreshes newly added files without changing or deleting scores', async () => {
        const folder = new MemoryDirectoryHandle();
        folder.children.set('first.gp', new MemoryFileHandle('first.gp'));
        bookmarks.load.mockResolvedValue(folder);
        const page = await mount();
        folder.children.set('second.GPX', new MemoryFileHandle('second.GPX'));
        await act(async () => page.current().refresh('second.GPX'));
        expect(page.current().files.map(file => file.name)).toEqual(['first.gp', 'second.GPX']);
        expect(page.current().selectedName).toBe('second.GPX');
        await act(async () => page.current().disconnect());
        expect(bookmarks.remember).toHaveBeenCalledWith(null);
        expect(page.current().name).toBeNull();
        expect(folder.children.size).toBe(2);
        expect(folder.removed).toEqual([]);
    });

    it('makes a persistence failure visible while keeping the newly granted folder usable', async () => {
        const folder = new MemoryDirectoryHandle();
        folder.children.set('existing.gp', new MemoryFileHandle('existing.gp'));
        bookmarks.picker.mockResolvedValue(folder);
        bookmarks.remember.mockRejectedValue(new Error('Storage unavailable.'));
        const page = await mount();
        await act(async () => page.current().choose());
        expect(page.current().ready).toBe(true);
        expect(page.container.querySelector('[role="alert"]')?.textContent).toContain('could not be remembered');
    });

    it('reports unsupported folder access rather than pretending to scan the computer', async () => {
        vi.stubGlobal('showDirectoryPicker', undefined);
        const page = await mount();
        expect(page.current().supported).toBe(false);
        expect(page.container.textContent).toContain('Open File and drag-and-drop remain available');
        expect(bookmarks.load).not.toHaveBeenCalled();
    });
});
