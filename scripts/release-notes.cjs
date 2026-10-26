const fs = require('node:fs');
const path = require('node:path');
function currentNotes(source, version) {
    const sections = source.split(/(?=^## WenBox v)/m);
    const section = sections.find(value => value.startsWith(`## WenBox v${version} ·`));
    if (!section) throw new Error(`Missing release notes for v${version}`);
    return section.replace(/\n---\s*$/, '').trim() + '\n';
}
if (require.main === module) {
    const root = path.resolve(__dirname, '..');
    const { version } = require(path.join(root, 'package.json'));
    fs.writeFileSync(path.join(root, 'release_notes.md'), currentNotes(fs.readFileSync(path.join(root, 'docs/RELEASE_NOTES.md'), 'utf8'), version));
}
module.exports = { currentNotes };
