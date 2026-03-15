import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: 'realm-map.js',
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  minify: true,
  keepNames: true,
  banner: { js: '// Built from src/ modules — do not edit directly\n' },
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('Watching src/ for changes...');
} else {
  const result = await esbuild.build(config);
  console.log(`Built realm-map.js (${(result.metafile?.outputs?.['realm-map.js']?.bytes / 1024 || '?')} KB)`);
}
