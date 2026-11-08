import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isFileServingAllowed, normalizePath, type Plugin } from 'vite';

// Custom deny lists replace Vite defaults. Retain the defaults and add runtime/private paths.
export const privateFileDeny = [
  '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
  '**/.local/**', '**/.tools/**', '**/.aws/**', '**/.ssh/**', '**/.codex/**', '**/.agents/**',
  '**/target/**', '**/keys/**', '**/keypairs/**', '**/worker-data/**',
  '**/*keypair*.json', '**/*private*.json', '**/*secret*.json', '**/*credentials*.json',
  '**/id.json', '**/*-key.json',
];

function within(directory: string, path: string): boolean {
  const suffix = relative(directory, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

/** Public assets bypass Vite's fs.deny; enforce the same boundary before all static serving. */
export function privateFileBoundary(webRoot: string, allowed: string[]): Plugin {
  return {
    name: 'osid-private-file-boundary',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        let pathname: string;
        try { pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname).replaceAll('\\', '/'); }
        catch { response.statusCode = 400; response.end('Invalid path'); return; }
        const candidates = pathname.startsWith('/@fs/')
          ? [resolve('/', pathname.slice('/@fs/'.length))]
          : [resolve(webRoot, `.${pathname}`), resolve(server.config.publicDir || resolve(webRoot, 'public'), `.${pathname}`)];
        for (const candidate of candidates) {
          let actual: string;
          try { actual = await realpath(candidate); } catch { continue; }
          if (!allowed.some((directory) => within(directory, actual)) || !isFileServingAllowed(server.config, normalizePath(actual))) {
            response.statusCode = 403;
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
            response.end('Private file access denied');
            return;
          }
        }
        next();
      });
    },
  };
}
