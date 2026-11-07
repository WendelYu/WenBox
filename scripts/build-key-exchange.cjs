// Fixed dependency versions and licenses are recorded in package-lock.json and docs/licenses.
require('esbuild').buildSync({ entryPoints: ['scripts/key-exchange.entry.mjs'], bundle: true, minify: true, format: 'iife', outfile: 'app/src/main/assets/web/key-exchange.js' });
