// Prepare immutable, verified upstream input resources. Does not install/start services.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const lock = require('./kvm-backend-lock.json');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'src-tauri/resources/kvm');
const cache = path.resolve(process.env.WENBOX_KVM_CACHE || path.join(os.tmpdir(), 'wenbox-kvm-downloads'));
const dry = process.argv.includes('--verify-only');
const preparationStamp = crypto.createHash('sha256');
for (const relative of ['scripts/prepare-kvm-backend.cjs', 'scripts/kvm-backend-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/kvm/model.rs', 'src-tauri/src/kvm/identity.rs', 'src-tauri/src/kvm/broker_protocol.rs', 'src-tauri/src/kvm/broker_service.rs', 'src-tauri/kvm-service/src/main.rs', 'src-tauri/kvm-service/Cargo.toml', 'src-tauri/kvm-service/Cargo.lock', 'src-tauri/installer/windows.nsi', 'src-tauri/installer/install-service.ps1']) preparationStamp.update(fs.readFileSync(path.join(root, relative)));
const stamp = preparationStamp.digest('hex');
function run(bin, args, options = {}) { const result = cp.spawnSync(bin, args, { stdio: 'inherit', ...options }); if (result.status !== 0) throw new Error(`${bin} failed (${result.status})`); }
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function download(name, url, digest) {
    fs.mkdirSync(cache, { recursive: true });
    const file = path.join(cache, name);
    if (!fs.existsSync(file) || sha(file) !== digest) {
        const tmp = file + '.download';
        // Use platform curl (available on Win10 2004+, Win11 and supported macOS).
        run(process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--max-time', '180', '--output', tmp, url]);
        if (sha(tmp) !== digest) { fs.rmSync(tmp, { force: true }); throw new Error(`Official digest mismatch: ${name}`); }
        fs.renameSync(tmp, file);
    }
    if (sha(file) !== digest) throw new Error(`Cached artifact failed verification: ${name}`);
    return file;
}
function files(folder, prefix = '') { return fs.readdirSync(folder, { withFileTypes: true }).flatMap(e => { const relative = path.join(prefix, e.name); return e.isDirectory() ? files(path.join(folder, e.name), relative) : [relative]; }); }
function macho(file) { if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) return false; const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(b.toString('hex')); }
function verify() {
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    if (manifest.version !== lock.version || manifest.commit !== lock.commit) throw new Error('Prepared backend version mismatch');
    for (const [name, digest] of Object.entries(manifest.files)) if (sha(path.join(output, name)) !== digest) throw new Error(`Prepared file changed: ${name}`);
    console.log(`Verified input resources: ${Object.keys(manifest.files).length} files, Deskflow ${lock.version}`);
}
async function main() {
    if (dry) { verify(); return; }
    if (!process.argv.includes('--rebuild') && fs.existsSync(path.join(output, 'manifest.json'))) {
        const previous = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
        if (previous.preparationStamp === stamp && previous.platform === process.platform) { verify(); return; }
    }
    if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Input bundle preparation requires macOS or Windows');
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'wenbox-input-stage-'));
    const mounted = [];
    try {
        const source = await download(lock.source.name, lock.source.url, lock.source.sha256);
        const notices = path.join(stage, 'third-party'); fs.mkdirSync(notices);
        fs.copyFileSync(source, path.join(notices, lock.source.name));
        const extracted = path.join(stage, 'source'); fs.mkdirSync(extracted);
        run('tar', ['-xzf', source, '--strip-components=1', '-C', extracted]);
        fs.copyFileSync(path.join(extracted, 'LICENSE'), path.join(notices, 'Deskflow-LICENSE.txt'));
        if (fs.existsSync(path.join(extracted, 'LICENSES'))) fs.cpSync(path.join(extracted, 'LICENSES'), path.join(notices, 'LICENSES'), { recursive: true });
        fs.writeFileSync(path.join(notices, 'SOURCE.txt'), `Deskflow ${lock.version}\nCommit ${lock.commit}\nOfficial release https://github.com/deskflow/deskflow/releases/tag/v${lock.version}\nUpstream input-core code unchanged; macOS architecture slices, launcher metadata and signing adapted for packaging. Corresponding upstream source and license texts included.\n`);
        fs.rmSync(extracted, { recursive: true });
        if (process.platform === 'darwin') {
            const apps = [];
            for (const arch of ['arm64', 'x86_64']) {
                const asset = lock.assets.find(a => a.name.endsWith(`macos-${arch}.dmg`));
                const dmg = await download(asset.name, asset.browser_download_url, asset.digest.replace('sha256:', ''));
                const mount = path.join(stage, `mount-${arch}`); fs.mkdirSync(mount);
                run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { input: 'Y\n', stdio: ['pipe', 'ignore', 'inherit'] }); mounted.push(mount);
                apps.push(path.join(mount, 'Deskflow.app'));
            }
            const app = path.join(stage, 'Deskflow.app'); fs.cpSync(apps[0], app, { recursive: true, verbatimSymlinks: true });
            for (const relative of files(apps[0])) {
                const arm = path.join(apps[0], relative), intel = path.join(apps[1], relative), dest = path.join(app, relative);
                if (macho(arm)) {
                    const archs = file => cp.execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/);
                    const aa = archs(arm), ia = fs.existsSync(intel) && macho(intel) ? archs(intel) : [];
                    if (relative.startsWith('Contents' + path.sep + 'PlugIns') && !ia.length) continue;
                    if (!(aa.includes('arm64') && aa.includes('x86_64'))) {
                        const slices = [];
                        for (const arch of ['arm64', 'x86_64']) {
                            const original = aa.includes(arch) ? arm : ia.includes(arch) ? intel : null;
                            if (!original) throw new Error(`Architecture ${arch} missing: ${relative}`);
                            const thin = path.join(stage, 'slice-' + arch);
                            if (archs(original).length > 1) run('/usr/bin/lipo', [original, '-thin', arch, '-output', thin]);
                            else fs.copyFileSync(original, thin);
                            slices.push(thin);
                        }
                        fs.rmSync(dest); run('/usr/bin/lipo', ['-create', ...slices, '-output', dest]);
                        for (const slice of slices) fs.rmSync(slice);
                    }
                    fs.chmodSync(dest, 0o755);
                }
            }
            // Optional Qt plugins differ across official architecture packages. Preserve their union;
            // Qt ignores non-native plugin slices, as it does in the original distribution.
            for (const relative of files(apps[1])) {
                const dest = path.join(app, relative);
                if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(path.join(apps[1], relative), dest, { verbatimSymlinks: true }); }
            }
            // Give the bundled component its own stable permission identity; do not expose a second GUI.
            const plist = path.join(app, 'Contents/Info.plist');
            run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleExecutable deskflow-core', plist]);
            run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.wendel.wenbox.input', plist]);
            run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName WenBox Input', plist]);
            run('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleDisplayName string WenBox Input', plist]);
            fs.rmSync(path.join(app, 'Contents/MacOS/Deskflow'), { force: true });
            fs.rmSync(path.join(app, 'Contents/_CodeSignature'), { recursive: true, force: true });
            run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
        } else {
            const asset = lock.assets.find(a => a.name.endsWith('win-x64-portable.zip'));
            const zip = await download(asset.name, asset.browser_download_url, asset.digest.replace('sha256:', ''));
            const unpack = path.join(stage, 'unpack');
            const ps = '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:WENBOX_INPUT_ZIP -DestinationPath $env:WENBOX_INPUT_UNPACK';
            run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, WENBOX_INPUT_ZIP: zip, WENBOX_INPUT_UNPACK: unpack } });
            const core = files(unpack).find(f => path.basename(f).toLowerCase() === 'deskflow-core.exe');
            if (!core) throw new Error('Official input core not found in portable archive');
            const input = path.join(stage, 'input'); fs.cpSync(path.dirname(path.join(unpack, core)), input, { recursive: true });
            for (const name of ['deskflow.exe', 'deskflow-daemon.exe']) fs.rmSync(path.join(input, name), { force: true });
            fs.mkdirSync(path.join(input, 'settings'), { recursive: true }); fs.writeFileSync(path.join(input, 'settings/Deskflow.conf'), '; Portable marker; actual protected profile is passed with --settings.\n');
            run('cargo', ['build', '--locked', '--release', '--manifest-path', path.join(root, 'src-tauri/kvm-service/Cargo.toml'), '--target-dir', path.join(root, 'src-tauri/target/kvm-service')]);
            fs.copyFileSync(path.join(root, 'src-tauri/target/kvm-service/release/wenbox-kvm-service.exe'), path.join(stage, 'wenbox-kvm-service.exe'));
            for (const name of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) if (fs.existsSync(path.join(input, name))) fs.copyFileSync(path.join(input, name), path.join(stage, name));
            fs.copyFileSync(path.join(root, 'src-tauri/installer/install-service.ps1'), path.join(stage, 'install-service.ps1'));
            const helper = path.join(root, 'src-tauri/installer/install-service.ps1').replaceAll(path.sep, '/').replaceAll('$', () => '$$');
            const template = fs.readFileSync(path.join(root, 'src-tauri/installer/windows.nsi'), 'utf8').replaceAll('@@WENBOX_SERVICE_HELPER@@', helper);
            fs.writeFileSync(path.join(stage, 'installer.nsi'), template);
            fs.rmSync(unpack, { recursive: true });
        }
        for (const mount of mounted.splice(0)) run('/usr/bin/hdiutil', ['detach', mount], { stdio: 'ignore' });
        for (const name of fs.readdirSync(stage).filter(n => n.startsWith('mount-'))) fs.rmSync(path.join(stage, name), { recursive: true });
        const manifest = { preparationStamp: stamp, version: lock.version, commit: lock.commit, platform: process.platform, files: {} };
        for (const relative of files(stage)) if (!fs.lstatSync(path.join(stage, relative)).isSymbolicLink()) manifest.files[relative.replaceAll(path.sep, '/')] = sha(path.join(stage, relative));
        fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        // Commit staging only after verification; never modify a user's installed backend.
        const readme = fs.existsSync(path.join(output, 'README.md')) ? fs.readFileSync(path.join(output, 'README.md')) : null;
        fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.cpSync(stage, output, { recursive: true, verbatimSymlinks: true });
        if (readme) fs.writeFileSync(path.join(output, 'README.md'), readme);
        verify();
    } finally {
        for (const mount of mounted) cp.spawnSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'ignore' });
        fs.rmSync(stage, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
