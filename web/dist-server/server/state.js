import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export function writeState(dir, state) {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
}
export function removeState(dir, ownPid) {
    const file = path.join(dir, 'state.json');
    let recordedPid = null;
    try {
        recordedPid = JSON.parse(readFileSync(file, 'utf8')).pid ?? null;
    }
    catch {
        recordedPid = null;
    }
    if (recordedPid === null || recordedPid === ownPid)
        rmSync(file, { force: true });
}
