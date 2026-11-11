// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { Settings } from '@coderline/alphatab';
import type { ScoreDocumentState } from '@coderline/alphatab-ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertSongsterr } from '../src/songsterr/convert';
import { IMPORT_META_NAME, IMPORT_PATH } from '../src/songsterr/shared';
import { SongsterrImportPanel, useSongsterrImport } from '../src/songsterr/SongsterrImportPanel';
import { originalRevision } from './songsterr-fixture';
import { MemoryDirectoryHandle, MemoryFileHandle } from './file-system-fixture';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@coderline/alphatab-react', () => ({ useAlphaTabApi: () => mocks.api() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];

function documentState() {
    return {
        document: null,
        text: '',
        setText: vi.fn(),
        texResult: null,
        loadError: null,
        openSample: vi.fn(),
        openFile: vi.fn(async (_file: File) => {}),
        openTex: vi.fn(),
        reload: vi.fn(),
        buildShareUrl: vi.fn(async () => null)
    } satisfies ScoreDocumentState;
}

async function mount(doc: ScoreDocumentState, enabled = true, library?: Parameters<typeof useSongsterrImport>[1]) {
    if (enabled) {
        const meta = document.createElement('meta');
        meta.name = IMPORT_META_NAME;
        meta.content = 'enabled';
        document.head.appendChild(meta);
    }
    let current!: ReturnType<typeof useSongsterrImport>;
    function Probe() {
        current = useSongsterrImport(doc, library);
        return <SongsterrImportPanel importer={current} />;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<Probe />));
    return { current: () => current, container };
}

async function ready(page: Awaited<ReturnType<typeof mount>>) {
    await act(async () => {
        page.current().setUrl(originalRevision().url);
        page.current().setAuthorized(true);
    });
}

beforeEach(() => {
    mocks.api.mockReturnValue({ settings: new Settings() });
    vi.stubGlobal('crypto', webcrypto);
});

afterEach(async () => {
    await act(async () => {
        for (const root of roots.splice(0)) {
            root.unmount();
        }
    });
    document.body.replaceChildren();
    document.head.querySelectorAll(`meta[name="${IMPORT_META_NAME}"]`).forEach(meta => {
        meta.remove();
    });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('Control player Songsterr import', () => {
    it('saves a real GP copy and opens that file rather than an unsaved JSON document', async () => {
        const folder = new MemoryDirectoryHandle();
        const existing = new MemoryFileHandle('keep.gp', new Uint8Array([9, 8, 7]));
        folder.children.set(existing.name, existing);
        const library = {
            supported: true,
            name: folder.name,
            authorize: vi.fn(async () => folder),
            refresh: vi.fn(async () => {})
        };
        const source = originalRevision();
        const fetcher = vi.fn(async () => new Response(convertSongsterr(source, true)));
        vi.stubGlobal('fetch', fetcher);
        const doc = documentState();
        const page = await mount(doc, true, library);
        await ready(page);
        await act(async () => page.current().submit());
        expect(library.authorize).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledWith(
            IMPORT_PATH,
            expect.objectContaining({
                body: JSON.stringify({ url: source.url, authorized: true, exportGuitarPro: true })
            })
        );
        expect(doc.openSample).not.toHaveBeenCalled();
        expect(doc.openFile).toHaveBeenCalledOnce();
        const file = doc.openFile.mock.calls[0][0];
        expect(file.name.endsWith('.gp')).toBe(true);
        expect([...new Uint8Array(await file.arrayBuffer()).slice(0, 4)]).toEqual([80, 75, 3, 4]);
        expect(page.container.textContent).toContain('Saved a .gp copy in Guitar Pro Tabs');
        expect([...existing.bytes]).toEqual([9, 8, 7]);
        expect(existing.writeCount).toBe(0);
        expect(library.refresh).toHaveBeenCalled();
    });

    it('does not contact Songsterr when saving is selected but no folder is connected', async () => {
        const library = {
            supported: true,
            name: null,
            authorize: vi.fn(async (): Promise<MemoryDirectoryHandle> => {
                throw new Error('Choose a folder first.');
            }),
            refresh: vi.fn(async () => {})
        };
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const doc = documentState();
        const page = await mount(doc, true, library);
        await ready(page);
        await act(async () => page.current().submit());
        expect(fetcher).not.toHaveBeenCalled();
        expect(doc.openSample).not.toHaveBeenCalled();
        expect(page.container.querySelector('[role="alert"]')?.textContent).toContain('Choose a folder');
    });

    it('keeps the previous document when a disk write fails', async () => {
        const folder = new MemoryDirectoryHandle();
        folder.prepareNewFile = file => {
            file.failWrite = true;
        };
        const library = {
            supported: true,
            name: folder.name,
            authorize: vi.fn(async () => folder),
            refresh: vi.fn(async () => {})
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(convertSongsterr(originalRevision(), true)))
        );
        const doc = documentState();
        const page = await mount(doc, true, library);
        await ready(page);
        await act(async () => page.current().submit());
        expect(doc.openFile).not.toHaveBeenCalled();
        expect(doc.openSample).not.toHaveBeenCalled();
        expect(page.container.querySelector('[role="alert"]')?.textContent).toContain('disk write failure');
        expect(folder.children.size).toBe(0);
    });

    it('keeps URL acquisition disabled in ordinary mode while retaining file opening', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const doc = documentState();
        const page = await mount(doc, false);
        expect(page.container.textContent).toContain('npm run dev:imports');
        expect(page.container.querySelector('form')).toBeNull();
        await ready(page);
        await act(async () => page.current().submit());
        expect(fetcher).not.toHaveBeenCalled();
        const file = new File(['original'], 'original.gp');
        await act(async () => page.current().openFile(file));
        expect(doc.openFile).toHaveBeenCalledWith(file, expect.objectContaining({ aborted: false }));
    });

    it('requires permission before making any upstream acquisition request', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const page = await mount(documentState());
        await act(async () => page.current().setUrl(originalRevision().url));
        await act(async () => page.current().submit());
        expect(fetcher).not.toHaveBeenCalled();
        expect(page.container.querySelector('[role="alert"]')?.textContent).toContain('permission');
    });

    it('opens the returned model through the document hook and displays provenance and limitations', async () => {
        const source = originalRevision();
        Object.assign(source.tracks[0].revision.measures[0].voices[0].beats[0], { futureEffect: true });
        const body = convertSongsterr(source);
        const fetcher = vi.fn(async () => new Response(body));
        vi.stubGlobal('fetch', fetcher);
        const doc = documentState();
        const page = await mount(doc);
        await ready(page);
        await act(async () => page.current().submit());
        expect(fetcher).toHaveBeenCalledWith(
            IMPORT_PATH,
            expect.objectContaining({
                method: 'POST',
                credentials: 'omit',
                body: JSON.stringify({ url: source.url, authorized: true })
            })
        );
        expect(doc.openSample).toHaveBeenCalledWith(
            expect.objectContaining({
                fileName: 'Original import study.json',
                source: expect.objectContaining({ json: expect.any(String) })
            })
        );
        expect(page.container.textContent).toContain('Imported 3 tracks');
        expect(page.container.textContent).toContain('Unsupported beat field "futureEffect"');
        expect(page.container.querySelector('a')?.href).toBe(source.url);
        expect(page.current().busy).toBe(false);
    });

    it('preserves the current document on acquisition and malformed-response errors', async () => {
        const doc = documentState();
        const page = await mount(doc);
        await ready(page);
        const fetcher = vi.fn(async () =>
            Response.json({ error: 'Access denied; no tracks were imported.' }, { status: 502 })
        );
        vi.stubGlobal('fetch', fetcher);
        await act(async () => page.current().submit());
        expect(doc.openSample).not.toHaveBeenCalled();
        expect(page.container.querySelector('[role="alert"]')?.textContent).toContain('Access denied');
        fetcher.mockImplementation(async () => new Response('<html>Not the API</html>'));
        await act(async () => page.current().submit());
        expect(doc.openSample).not.toHaveBeenCalled();
        expect(page.container.querySelector('[role="alert"]')?.textContent).toContain('invalid response');
    });

    it.each(['cancel', 'file'] as const)('discards a late response after %s supersedes the request', async action => {
        let respond!: (response: Response) => void;
        const response = new Promise<Response>(resolve => {
            respond = resolve;
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(() => response)
        );
        const doc = documentState();
        const page = await mount(doc);
        await ready(page);
        let pending!: Promise<void>;
        await act(async () => {
            pending = page.current().submit();
        });
        expect(page.current().busy).toBe(true);
        await act(async () => {
            if (action === 'cancel') {
                page.current().cancel();
            } else {
                page.current().openFile(new File(['original'], 'local.gp'));
            }
        });
        await act(async () => {
            respond(new Response(convertSongsterr(originalRevision())));
            await pending;
        });
        expect(doc.openSample).not.toHaveBeenCalled();
        expect(page.current().busy).toBe(false);
        if (action === 'file') {
            expect(doc.openFile).toHaveBeenCalledOnce();
        } else {
            expect(page.container.textContent).toContain('Import canceled');
        }
    });

    it('surfaces local read failures without sending the file to the server', async () => {
        const doc = documentState();
        doc.openFile.mockRejectedValue(new Error('File could not be read.'));
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const page = await mount(doc);
        await act(async () => page.current().openFile(new File(['original'], 'local.gp')));
        expect(fetcher).not.toHaveBeenCalled();
        expect(page.container.querySelector('[role="alert"]')?.textContent).toContain('File could not be read');
    });
});
