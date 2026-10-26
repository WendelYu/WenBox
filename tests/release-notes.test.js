const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { currentNotes, releaseNotes } = require('../scripts/release-notes.cjs');
test('release notes contain only the requested version, fail when missing', () => {
    const source = '## WenBox v2.0.0 · New\n\nNew fix\n\n---\n\n## WenBox v1.0.0 · Old\nOld fix';
    assert.equal(currentNotes(source, '2.0.0'), '## WenBox v2.0.0 · New\n\nNew fix\n');
    assert.throws(() => currentNotes(source, '3.0.0'), /Missing/);
});
test('visible UI version matches the packaged release', () => {
    const { version } = require('../package.json');
    assert.ok(fs.readFileSync('app/src/main/assets/web/index.html', 'utf8').includes(`name="wenbox-version" content="${version}"`));
    const notes = currentNotes(fs.readFileSync('docs/RELEASE_NOTES.md', 'utf8'), version);
    assert.equal((notes.match(/^## WenBox v/gm) || []).length, 1);
});

test('desktop leaves file drop to the frontend upload queue', () => {
    const config = require('../src-tauri/tauri.conf.json');
    assert.ok(config.tauri.windows.every(window => window.fileDropEnabled === false));
});

test('every release includes macOS installation help exactly once', () => {
    const notes = releaseNotes('## WenBox v2.0.0 · Update\nNew fix\n', '2.0.0');
    assert.match(notes, /WenBox-macOS-v2.0.0-universal.dmg/);
    assert.match(notes, /xattr -dr com.apple.quarantine \/Applications\/WenBox.app/);
    assert.equal(releaseNotes(notes, '2.0.0'), notes);
});
