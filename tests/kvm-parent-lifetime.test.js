const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

test('macOS input core cannot outlive its WenBox owner', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenbox-parent-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const shim = path.join(dir, 'shim.dylib'), fixture = path.join(dir, 'fixture');
    for (const args of [
        ['-O2', '-dynamiclib', 'src-tauri/kvm-shim/tis_serializer.c', '-framework', 'Carbon', '-o', shim],
        ['tests/macos/input-parent.c', '-o', fixture]
    ]) {
        const result = spawnSync('clang', args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    for (const [mode, signal] of [['guarded', 'SIGTERM'], ['guarded', 'SIGKILL'], ['delayed', 'SIGKILL'], ['standalone', 'SIGKILL']]) {
        await t.test(`${mode}: ${signal}`, async () => {
            const owner = spawn(fixture, [shim, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '', errors = '', closed = false, childPid;
            owner.stdout.on('data', chunk => { output += chunk; });
            owner.stderr.on('data', chunk => { errors += chunk; });
            const done = new Promise(resolve => owner.on('close', () => { closed = true; resolve(); }));
            async function until(predicate) {
                const deadline = Date.now() + 3000;
                while (!predicate()) {
                    assert(Date.now() < deadline, `timed out: ${output} ${errors}`);
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
            }
            try {
                await until(() => /CHILD (\d+)/.test(output));
                childPid = Number(output.match(/CHILD (\d+)/)[1]);
                if (mode !== 'delayed') {
                    await until(() => output.includes('READY'));
                    await new Promise(resolve => setTimeout(resolve, 350));
                    process.kill(childPid, 0); // Still alive while its owner is alive.
                }
                owner.kill(signal);
                if (mode === 'standalone') {
                    await new Promise(resolve => setTimeout(resolve, 600));
                    assert.equal(closed, false, 'standalone shim must not terminate its host');
                    process.kill(childPid, 0);
                } else {
                    // Child inherits stdout/stderr: close requires BOTH processes to exit.
                    await until(() => closed);
                    if (mode === 'delayed') assert(!output.includes('READY'), 'orphan must exit during initialization');
                }
            } finally {
                owner.kill('SIGKILL');
                if (childPid && !closed) { try { process.kill(childPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
                await done;
            }
        });
    }
});
