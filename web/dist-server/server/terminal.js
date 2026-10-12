import { WebSocketServer } from 'ws';
import { hostAllowed, originAllowed, tokenMatches } from './auth.js';
import { clampInt, SESSION_NAME_RE } from '../src/shared/validate.js';
const FRAME_MAX = 64 * 1024;
const CONTROL_MAX = 4096;
function refuse(socket, status) {
    socket.once('finish', () => socket.destroy());
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
export function attachTerminalServer(server, deps) {
    const maxPtys = deps.maxPtys ?? 8;
    const maxClients = deps.maxClients ?? 16;
    const highWater = deps.highWater ?? 1024 * 1024;
    const lowWater = deps.lowWater ?? 256 * 1024;
    const registry = new Set();
    const exitWaiters = new Map();
    const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_MAX });
    const markExited = (entry) => {
        entry.exited = true;
        registry.delete(entry);
        exitWaiters.get(entry)?.();
        exitWaiters.delete(entry);
    };
    const safeKill = (entry, signal) => {
        if (entry.exited)
            return;
        try {
            entry.pty.kill(signal);
        }
        catch {
            markExited(entry);
        }
    };
    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => socket.destroy());
        let url;
        try {
            url = new URL(req.url ?? '/', `http://127.0.0.1:${deps.port()}`);
        }
        catch {
            return refuse(socket, '400 Bad Request');
        }
        if (url.pathname !== '/ws/terminal')
            return refuse(socket, '404 Not Found');
        if (!hostAllowed(req.headers.host, deps.port()) || !originAllowed(req.headers.origin, deps.port())) {
            return refuse(socket, '403 Forbidden');
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on('error', () => ws.terminate());
            void admit(ws, url);
        });
    });
    async function admit(ws, url) {
        if (!tokenMatches(deps.token, url.searchParams.get('token') ?? undefined)) {
            return ws.close(4401, 'bad token');
        }
        const name = url.searchParams.get('session') ?? '';
        if (!SESSION_NAME_RE.test(name))
            return ws.close(4404, 'invalid session name');
        if (wss.clients.size > maxClients)
            return ws.close(1013, 'client limit reached');
        let snapshot;
        try {
            snapshot = await deps.sessions();
        }
        catch {
            return ws.close(1013, 'session list unavailable');
        }
        if (ws.readyState !== ws.OPEN)
            return;
        const row = snapshot.sessions.find((s) => s.name === name);
        if (!row || !row.attachable)
            return ws.close(4404, 'unknown session');
        if (registry.size >= maxPtys)
            return ws.close(1013, 'terminal limit reached');
        const cols = clampInt(url.searchParams.get('cols'), 2, 500, 80);
        const rows = clampInt(url.searchParams.get('rows'), 1, 300, 24);
        let pty;
        try {
            pty = deps.ptyFactory(name, cols, rows);
        }
        catch {
            ws.send(JSON.stringify({ t: 'error', code: 'spawn_failed', msg: 'could not start ssh' }));
            return ws.close(1011, 'spawn failed');
        }
        const entry = { pty, exited: false, wsClosedAt: null };
        registry.add(entry);
        let drain = null;
        const stopDrain = () => {
            if (drain !== null)
                clearInterval(drain);
            drain = null;
        };
        pty.onData((data) => {
            if (ws.readyState !== ws.OPEN)
                return;
            ws.send(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { binary: true });
            if (drain === null && ws.bufferedAmount > highWater) {
                pty.pause();
                drain = setInterval(() => {
                    if (ws.bufferedAmount < lowWater || ws.readyState !== ws.OPEN) {
                        stopDrain();
                        pty.resume();
                    }
                }, 50);
            }
        });
        pty.onExit(({ exitCode, signal }) => {
            markExited(entry);
            stopDrain();
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ t: 'exit', code: exitCode, signal: signal ?? null }));
                ws.close(1000, 'session ended');
            }
        });
        ws.on('message', (data, isBinary) => {
            const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (isBinary) {
                pty.write(buf);
                return;
            }
            if (buf.length > CONTROL_MAX)
                return ws.close(1009, 'control frame too large');
            let msg;
            try {
                msg = JSON.parse(buf.toString('utf8'));
            }
            catch {
                return;
            }
            if (msg.t === 'resize') {
                pty.resize(clampInt(String(msg.cols), 2, 500, cols), clampInt(String(msg.rows), 1, 300, rows));
            }
        });
        let alive = true;
        ws.on('pong', () => {
            alive = true;
        });
        const ping = setInterval(() => {
            if (ws.readyState !== ws.OPEN)
                return;
            if (!alive) {
                ws.terminate();
                return;
            }
            alive = false;
            ws.ping();
        }, 30000);
        ws.on('close', () => {
            clearInterval(ping);
            stopDrain();
            entry.wsClosedAt = Date.now();
            safeKill(entry, 'SIGHUP');
        });
        ws.send(JSON.stringify({ t: 'ready' }));
    }
    const sweep = setInterval(() => {
        for (const entry of registry) {
            if (entry.exited) {
                registry.delete(entry);
            }
            else if (entry.wsClosedAt !== null && Date.now() - entry.wsClosedAt > 5000) {
                safeKill(entry, 'SIGKILL');
                registry.delete(entry);
            }
        }
    }, 10000);
    sweep.unref();
    return {
        count() {
            return registry.size;
        },
        closeAll(graceMs = 3000) {
            clearInterval(sweep);
            for (const client of wss.clients) {
                client.close(1001, 'server shutting down');
                setTimeout(() => client.terminate(), 1000).unref();
            }
            const live = [...registry].filter((entry) => !entry.exited);
            const exited = Promise.all(live.map((entry) => new Promise((resolve) => exitWaiters.set(entry, resolve))));
            for (const entry of live)
                safeKill(entry, 'SIGHUP');
            let timer = null;
            const escalate = new Promise((resolve) => {
                timer = setTimeout(() => {
                    for (const entry of live) {
                        safeKill(entry, 'SIGKILL');
                        markExited(entry);
                    }
                    resolve();
                }, graceMs);
            });
            return Promise.race([exited.then(() => undefined), escalate]).finally(() => {
                if (timer !== null)
                    clearTimeout(timer);
                registry.clear();
            });
        },
    };
}
