import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
    '.json': 'application/json',
    '.txt': 'text/plain',
};
export function serveStatic(root, urlPath, res) {
    const absRoot = path.resolve(root);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const resolved = path.resolve(absRoot, rel);
    const inside = resolved === absRoot || resolved.startsWith(absRoot + path.sep);
    let isFile = false;
    if (inside) {
        try {
            isFile = statSync(resolved).isFile();
        }
        catch {
            isFile = false;
        }
    }
    if (!isFile) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('not found');
        return;
    }
    const ext = path.extname(resolved);
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    if (ext === '.html')
        res.setHeader('Cache-Control', 'no-store');
    const stream = createReadStream(resolved);
    stream.on('error', () => {
        if (res.headersSent) {
            res.destroy();
        }
        else {
            res.statusCode = 500;
            res.end('read error');
        }
    });
    stream.pipe(res);
}
