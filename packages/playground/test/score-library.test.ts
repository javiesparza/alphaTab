import { importer } from '@coderline/alphatab';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    authorizeLibrary,
    guitarProFileName,
    listLibraryScores,
    saveGuitarProFile
} from '../src/library/browser-library';
import { convertSongsterr } from '../src/songsterr/convert';
import { readImportedScore } from '../src/songsterr/shared';
import { MemoryDirectoryHandle, MemoryFileHandle } from './file-system-fixture';
import { originalRevision } from './songsterr-fixture';

function guitarProBytes(): Uint8Array<ArrayBuffer> {
    const bytes = readImportedScore(JSON.parse(convertSongsterr(originalRevision(), true))).guitarPro;
    if (!bytes) {
        throw new Error('The original GP fixture was not exported.');
    }
    return bytes;
}

afterEach(() => vi.restoreAllMocks());

describe('browser score library', () => {
    it('lists the same score types as Open File, without reading files or walking subfolders', async () => {
        const folder = new MemoryDirectoryHandle();
        for (const name of ['Track 10.GP', 'Track 2.gp5', 'study.musicxml', 'notes.atex', 'ignore.pdf']) {
            const file = new MemoryFileHandle(name);
            file.readError = new Error('Listing must not read file contents.');
            folder.children.set(name, file);
        }
        folder.children.set('nested', new MemoryDirectoryHandle('nested'));
        const files = await listLibraryScores(folder);
        expect(files.map(file => file.name)).toEqual(['notes.atex', 'study.musicxml', 'Track 2.gp5', 'Track 10.GP']);
    });

    it('requires an explicit grant and refuses writes after permission expires', async () => {
        const folder = new MemoryDirectoryHandle();
        folder.permission = 'prompt';
        await authorizeLibrary(folder);
        expect(folder.permissionRequests).toBe(1);
        folder.permission = 'denied';
        folder.grantOnRequest = false;
        await expect(authorizeLibrary(folder)).rejects.toThrow('not granted');
        await expect(
            saveGuitarProFile(folder, guitarProBytes(), 'Original study', new AbortController().signal)
        ).rejects.toThrow('permission expired');
        expect(folder.children.size).toBe(0);
    });

    it('writes and verifies a real GP file while preserving every existing byte', async () => {
        const folder = new MemoryDirectoryHandle();
        const existing = new MemoryFileHandle('existing.gp', new Uint8Array([7, 8, 9]));
        folder.children.set(existing.name, existing);
        const bytes = guitarProBytes();
        const file = await saveGuitarProFile(folder, bytes, 'Original study', new AbortController().signal);
        expect(file.name).toMatch(/^Original study - [\da-f-]+\.gp$/);
        expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...bytes]);
        const score = importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(await file.arrayBuffer()));
        expect(score.title).toBe('Original import study');
        expect(score.tracks).toHaveLength(3);
        expect([...existing.bytes]).toEqual([7, 8, 9]);
        expect(existing.writeCount).toBe(0);
        expect(folder.removed).toEqual([]);
        const saved = folder.children.get(file.name);
        if (!(saved instanceof MemoryFileHandle)) {
            throw new Error('The saved entry is not a file.');
        }
        expect(saved.options).toMatchObject({ keepExistingData: false, mode: 'exclusive' });
    });

    it('chooses a different name rather than replacing an existing collision', async () => {
        const first = '00000000-0000-4000-8000-000000000001';
        const second = '00000000-0000-4000-8000-000000000002';
        vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(first).mockReturnValueOnce(second);
        const folder = new MemoryDirectoryHandle();
        const existing = new MemoryFileHandle(`Study - ${first}.gp`, new Uint8Array([1, 2, 3]));
        folder.children.set(existing.name, existing);
        const file = await saveGuitarProFile(folder, guitarProBytes(), 'Study', new AbortController().signal);
        expect(file.name).toBe(`Study - ${second}.gp`);
        expect(existing.writeCount).toBe(0);
        expect([...existing.bytes]).toEqual([1, 2, 3]);
    });

    it('does not replace a colliding empty file or directory', async () => {
        const ids = [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000003'
        ] as const;
        vi.spyOn(crypto, 'randomUUID')
            .mockReturnValueOnce(ids[0])
            .mockReturnValueOnce(ids[1])
            .mockReturnValueOnce(ids[2]);
        const folder = new MemoryDirectoryHandle();
        const empty = new MemoryFileHandle(`Study - ${ids[0]}.gp`);
        folder.children.set(empty.name, empty);
        folder.children.set(`Study - ${ids[1]}.gp`, new MemoryDirectoryHandle(`Study - ${ids[1]}.gp`));
        const file = await saveGuitarProFile(folder, guitarProBytes(), 'Study', new AbortController().signal);
        expect(file.name).toBe(`Study - ${ids[2]}.gp`);
        expect(empty.writeCount).toBe(0);
        expect(folder.removed).toEqual([]);
    });

    it('cleans up only its own empty placeholder when writing fails', async () => {
        const folder = new MemoryDirectoryHandle();
        const existing = new MemoryFileHandle('keep.gp', new Uint8Array([4, 5]));
        folder.children.set(existing.name, existing);
        folder.prepareNewFile = file => {
            file.failWrite = true;
        };
        await expect(
            saveGuitarProFile(folder, guitarProBytes(), 'Failing study', new AbortController().signal)
        ).rejects.toThrow('Simulated disk write failure');
        expect([...folder.children.keys()]).toEqual(['keep.gp']);
        expect(folder.removed).toHaveLength(1);
        expect(folder.removed[0]).toMatch(/^Failing study - .*\.gp$/);
        expect([...existing.bytes]).toEqual([4, 5]);
    });

    it('aborts a pending write without committing or replacing another file', async () => {
        const folder = new MemoryDirectoryHandle();
        let started!: () => void;
        let release!: () => void;
        const writing = new Promise<void>(resolve => {
            started = resolve;
        });
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        folder.prepareNewFile = file => {
            file.beforeWrite = async () => {
                started();
                await gate;
            };
        };
        const controller = new AbortController();
        const saving = saveGuitarProFile(folder, guitarProBytes(), 'Canceled study', controller.signal);
        const assertion = expect(saving).rejects.toMatchObject({ name: 'AbortError' });
        await writing;
        controller.abort();
        release();
        await assertion;
        expect(folder.children.size).toBe(0);
        expect(folder.removed).toHaveLength(1);
    });

    it('does not erase a file changed by another writer during a failure', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const folder = new MemoryDirectoryHandle();
        folder.prepareNewFile = file => {
            file.beforeWrite = async () => {
                file.bytes = new Uint8Array([9, 8, 7]);
                file.lastModified++;
                file.failWrite = true;
            };
        };
        await expect(
            saveGuitarProFile(folder, guitarProBytes(), 'Changed study', new AbortController().signal)
        ).rejects.toThrow('may remain');
        expect(folder.children.size).toBe(1);
        expect(folder.removed).toEqual([]);
        expect(console.error).toHaveBeenCalled();
    });

    it('keeps names portable and rejects data that is not a GP archive', async () => {
        const name = guitarProFileName(`CON: ../${'音'.repeat(200)}`);
        expect(name).not.toMatch(/[<>:"/\\|?*]/);
        expect(new TextEncoder().encode(name).length).toBeLessThan(255);
        expect(name.endsWith('.gp')).toBe(true);
        const folder = new MemoryDirectoryHandle();
        await expect(
            saveGuitarProFile(folder, new TextEncoder().encode('{}'), 'Not a GP', new AbortController().signal)
        ).rejects.toThrow('Nothing was saved');
        expect(folder.children.size).toBe(0);
    });
});
