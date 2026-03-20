import * as esbuild from 'esbuild';
import { execFileSync } from 'child_process';

const watch = process.argv.includes('--watch');

// Generate a magical version name: "Adjective Noun · abcd123"
const adjectives = [
  'Arcane','Astral','Blazing','Celestial','Crimson','Crystal','Dark','Dire',
  'Elder','Ember','Enchanted','Ethereal','Fading','Fell','Feral','Flickering',
  'Frozen','Gilded','Glimmering','Golden','Hallowed','Hollow','Iron','Jade',
  'Luminous','Molten','Mystic','Obsidian','Pale','Phantom','Prismatic','Radiant',
  'Rune','Sacred','Shadow','Silent','Silver','Spectral','Storm','Twilight',
  'Verdant','Void','Warding','Wild','Woven','Wyrd',
];
const nouns = [
  'Aegis','Amulet','Anvil','Beacon','Blade','Bloom','Bolt','Chalice','Circlet',
  'Crest','Crown','Dawn','Dominion','Dusk','Eclipse','Ember','Eye','Fang','Flame',
  'Gate','Glyph','Grove','Halo','Harvest','Herald','Horn','Hymn','Lotus',
  'Mantle','Monolith','Nexus','Obelisk','Oracle','Pact','Pendulum','Pinnacle',
  'Prism','Pulse','Rift','Rune','Sanctum','Seal','Sentinel','Shard','Sigil',
  'Solstice','Spark','Spire','Stone','Tempest','Thorn','Tome','Veil','Vigil',
  'Ward','Whisper','Zenith',
];

function buildVersionName() {
  let hash;
  try { hash = execFileSync('git', ['rev-parse', '--short=7', 'HEAD']).toString().trim(); }
  catch { hash = Date.now().toString(36).slice(-7); }
  // Use hash to seed deterministic pick so same commit = same name
  const seed = parseInt(hash, 16) || 0;
  const adj = adjectives[seed % adjectives.length];
  const noun = nouns[(seed >> 8) % nouns.length];
  return `${adj} ${noun} · ${hash}`;
}

const versionName = buildVersionName();

const prod = !watch;

const config = {
  entryPoints: ['src/main.js'],
  bundle: true,
  outfile: 'realm-map.js',
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  minify: prod,
  keepNames: true,
  metafile: true,
  banner: { js: `// Built from src/ modules — do not edit directly\n// Version: ${versionName}\n` },
  define: {
    '__REALM_VERSION__': JSON.stringify(versionName),
  },
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('Watching src/ for changes...');
} else {
  const result = await esbuild.build(config);
  console.log(`Built realm-map.js — ${versionName}`);
  if (result.metafile) {
    const analysis = await esbuild.analyzeMetafile(result.metafile);
    console.log(analysis);
  }
}
