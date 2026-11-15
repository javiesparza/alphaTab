import type { LibraryDirectoryHandle } from '../src/library/browser-library';

class MemoryWritableStream extends WritableStream<FileSystemWriteChunkType> implements FileSystemWritableFileStream {
    async write(data: FileSystemWriteChunkType): Promise<void> {
        const writer = this.getWriter();
        try {
            await writer.write(data);
        } finally {
            writer.releaseLock();
        }
    }

    async seek(_position: number): Promise<void> {
        throw new Error('Seek is not used by the library writer.');
    }

    async truncate(_size: number): Promise<void> {
        throw new Error('Truncate is not used by the library writer.');
    }
}

export class MemoryFileHandle implements FileSystemFileHandle {
    readonly kind = 'file';
    bytes: Uint8Array<ArrayBuffer>;
    lastModified = 1;
    writeCount = 0;
    abortCount = 0;
    failWrite = false;
    failClose = false;
    readError: Error | null = null;
    beforeWrite?: () => Promise<void>;
    options?: FileSystemCreateWritableOptions;

    constructor(
        public readonly name: string,
        bytes = new Uint8Array()
    ) {
        this.bytes = new Uint8Array(bytes);
    }

    async getFile(): Promise<File> {
        if (this.readError) {
            throw this.readError;
        }
        const snapshot = new Uint8Array(this.bytes);
        const file = new File([snapshot], this.name, { lastModified: this.lastModified });
        Object.defineProperty(file, 'arrayBuffer', { value: async () => snapshot.buffer.slice(0) });
        return file;
    }

    async isSameEntry(other: FileSystemHandle): Promise<boolean> {
        return this === other;
    }

    async createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
        throw new Error('Synchronous origin-private access is not used by the library.');
    }

    async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
        this.options = options;
        this.writeCount++;
        let staged = new Uint8Array();
        return new MemoryWritableStream({
            write: async chunk => {
                await this.beforeWrite?.();
                if (this.failWrite) {
                    throw new Error('Simulated disk write failure.');
                }
                if (!(chunk instanceof Uint8Array)) {
                    throw new Error('The library must write the original byte array.');
                }
                staged = new Uint8Array(chunk);
            },
            close: () => {
                if (this.failClose) {
                    throw new Error('Simulated close failure.');
                }
                this.bytes = staged;
                this.lastModified++;
            },
            abort: () => {
                this.abortCount++;
            }
        });
    }
}

type Entry = MemoryDirectoryHandle | MemoryFileHandle;

export class MemoryDirectoryHandle implements LibraryDirectoryHandle {
    readonly kind = 'directory';
    readonly children = new Map<string, Entry>();
    readonly removed: string[] = [];
    permission: PermissionState = 'granted';
    grantOnRequest = true;
    permissionRequests = 0;
    prepareNewFile?: (file: MemoryFileHandle) => void;

    constructor(public readonly name = 'Guitar Pro Tabs') {}

    async queryPermission(): Promise<PermissionState> {
        return this.permission;
    }

    async requestPermission(): Promise<PermissionState> {
        this.permissionRequests++;
        this.permission = this.grantOnRequest ? 'granted' : 'denied';
        return this.permission;
    }

    private requirePermission(): void {
        if (this.permission !== 'granted') {
            throw new DOMException('Folder access is not granted.', 'NotAllowedError');
        }
    }

    async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
        this.requirePermission();
        const existing = this.children.get(name);
        if (existing?.kind === 'directory') {
            throw new DOMException('This entry is a directory.', 'TypeMismatchError');
        }
        if (existing) {
            return existing;
        }
        if (!options?.create) {
            throw new DOMException('This file does not exist.', 'NotFoundError');
        }
        const file = new MemoryFileHandle(name);
        this.prepareNewFile?.(file);
        this.children.set(name, file);
        return file;
    }

    async getDirectoryHandle(
        name: string,
        options?: FileSystemGetDirectoryOptions
    ): Promise<FileSystemDirectoryHandle> {
        this.requirePermission();
        const existing = this.children.get(name);
        if (existing?.kind === 'file') {
            throw new DOMException('This entry is a file.', 'TypeMismatchError');
        }
        if (existing) {
            return existing;
        }
        if (!options?.create) {
            throw new DOMException('This directory does not exist.', 'NotFoundError');
        }
        const directory = new MemoryDirectoryHandle(name);
        this.children.set(name, directory);
        return directory;
    }

    async removeEntry(name: string): Promise<void> {
        this.requirePermission();
        if (!this.children.has(name)) {
            throw new DOMException('This entry does not exist.', 'NotFoundError');
        }
        this.removed.push(name);
        this.children.delete(name);
    }

    async isSameEntry(other: FileSystemHandle): Promise<boolean> {
        return this === other;
    }

    async resolve(descendant: FileSystemHandle): Promise<string[] | null> {
        if (descendant === this) {
            return [];
        }
        for (const [name, child] of this.children) {
            if (child === descendant) {
                return [name];
            }
        }
        return null;
    }

    async *values(): AsyncGenerator<FileSystemDirectoryHandle | FileSystemFileHandle, undefined, unknown> {
        this.requirePermission();
        yield* this.children.values();
        return undefined;
    }

    async *keys(): AsyncGenerator<string, undefined, unknown> {
        this.requirePermission();
        yield* this.children.keys();
        return undefined;
    }

    async *entries(): AsyncGenerator<[string, FileSystemDirectoryHandle | FileSystemFileHandle], undefined, unknown> {
        this.requirePermission();
        yield* this.children.entries();
        return undefined;
    }

    [Symbol.asyncIterator]() {
        return this.entries();
    }
}
