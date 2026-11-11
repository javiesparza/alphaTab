import type { Plugin } from 'vite';
import { createSongsterrMiddleware } from './src/songsterr/middleware';
import { IMPORT_META_NAME } from './src/songsterr/shared';

export default function songsterrImport(): Plugin {
    return {
        name: 'at-songsterr-import',
        apply: 'serve',
        config() {
            return { server: { host: '127.0.0.1' } };
        },
        configResolved(config) {
            if (config.server.host !== '127.0.0.1' || config.server.https) {
                throw new Error('Songsterr import mode requires an HTTP server bound to 127.0.0.1.');
            }
        },
        configureServer(server) {
            server.middlewares.use(
                createSongsterrMiddleware({
                    logError: error =>
                        server.config.logger.error(
                            `[songsterr-import] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
                        )
                })
            );
        },
        transformIndexHtml() {
            return [
                {
                    tag: 'meta',
                    attrs: { name: IMPORT_META_NAME, content: 'enabled' },
                    injectTo: 'head'
                }
            ];
        }
    };
}
