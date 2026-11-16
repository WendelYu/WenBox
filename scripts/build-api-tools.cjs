const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const out = 'app/src/main/assets/web/api-debug.js';
const result = buildSync({ entryPoints: ['src-tools/api-debug.mjs'], bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['es2022'], outfile: out, legalComments: 'linked', metafile: true });
// Ship the full licenses of every bundled package, including transitive parsers.
const packages = new Set();
for (const file of Object.keys(result.metafile.inputs)) {
    if (!file.includes('node_modules/')) continue;
    let dir = path.dirname(path.resolve(file));
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        const parent = path.dirname(dir);
        if (parent === dir) throw Error(`Package not found for ${file}`);
        dir = parent;
    }
    packages.add(dir);
}
const notices = [...packages].sort().map(dir => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const files = fs.readdirSync(dir).filter(name => /^(?:LICENSE|COPYING|NOTICE)(?:\..*)?$/i.test(name));
    if (!files.length) throw Error(`License missing for ${pkg.name}`);
    return `${pkg.name}@${pkg.version} (${pkg.license})\n${files.map(name => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')).join('\n')}`;
});
fs.writeFileSync(out + '.LICENSES.txt', 'WenBox API tools — bundled third-party licenses\n\n' + notices.join('\n\n' + '='.repeat(72) + '\n\n'));
