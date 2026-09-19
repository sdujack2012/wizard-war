#!/usr/bin/env node
/**
 * Render every cue offline and measure the result.
 *
 * The Node test suite proves each cue BUILDS a graph and that the graphs differ.
 * That is not the same as proving the cues make a sound: a graph can be built
 * entirely with silent parameters and no test of node counts would notice. This
 * renders each cue through an OfflineAudioContext and measures the actual
 * samples - peak, RMS, zero-crossing rate (a cheap brightness proxy) and how
 * long it stays audible - then reports a table and fails if any cue is silent or
 * if two cues render to the same fingerprint.
 *
 * Needs the dev server running, and a browser; deliberately not part of
 * `npm test` for that reason.
 *
 *   node tools/render-cues.mjs [--url http://127.0.0.1:5173/]
 */
import { createRequire } from 'node:module';

const require = createRequire('/home/sdujack2012/.local/lib/node_modules/');
const { chromium } = require('playwright');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const URL_ = arg('url', 'http://127.0.0.1:5173/');

const CUES = [
  'fireball', 'waterball', 'heal', 'explosion', 'freeze',
  'hitFire', 'hitWater', 'hitIce',
  'spark', 'element', 'chargeFull', 'break', 'fizzle',
  'kill', 'playerHit', 'waveStart', 'waveClear', 'overtime', 'death',
];

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/sdujack2012/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL_, { waitUntil: 'load' });

const rows = await page.evaluate(async (names) => {
  const { Audio } = await import('/src/audio.js');
  const SR = 48000;
  const DUR = 1.4;
  const out = {};
  for (const name of names) {
    const off = new OfflineAudioContext(1, SR * DUR, SR);
    const a = new Audio();
    a.attach(off);
    // Give the parameterised cues the arguments the game would pass.
    a.play(name, { element: 'fire', index: 1, charge: 1 });
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0;
    let sum = 0;
    let zc = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
      sum += v * v;
      if (av > 0.002) {
        if (first < 0) first = i;
        last = i;
      }
      if (i > 0 && d[i - 1] < 0 !== v < 0) zc++;
    }
    out[name] = {
      peak: Number(peak.toFixed(4)),
      rms: Number(Math.sqrt(sum / d.length).toFixed(5)),
      zcr: Math.round(zc / (DUR)),
      ms: first < 0 ? 0 : Math.round(((last - first) / SR) * 1000),
    };
  }
  return out;
}, CUES);

await browser.close();

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log(`${pad('cue', 12)}${padL('peak', 8)}${padL('rms', 9)}${padL('zcr/s', 8)}${padL('audible ms', 12)}`);
for (const name of CUES) {
  const r = rows[name];
  console.log(`${pad(name, 12)}${padL(r.peak, 8)}${padL(r.rms, 9)}${padL(r.zcr, 8)}${padL(r.ms, 12)}`);
}

const problems = [];
// A floor that only catches genuinely broken cues. An element tap is MEANT to
// be a 40ms tick, so a single duration threshold across every cue would flag
// correct work; the real requirement is that nothing is silent or near-silent.
for (const name of CUES) {
  const r = rows[name];
  if (r.peak < 0.01) problems.push(`${name} is effectively silent (peak ${r.peak})`);
  if (r.ms < 25) problems.push(`${name} lasts only ${r.ms}ms of audible output`);
}
// Spells are the set that has to carry weight, so they get a stricter floor:
// a spell that is over as fast as a tap is a spell with no impact.
for (const name of ['fireball', 'waterball', 'heal', 'explosion', 'freeze']) {
  const r = rows[name];
  if (r.ms < 120) problems.push(`${name} is a spell but lasts only ${r.ms}ms`);
}
// A landing must be shorter than the cast it lands: the impact is punctuation.
for (const [hit, cast] of [['hitFire', 'fireball'], ['hitWater', 'waterball']]) {
  if (rows[hit].ms >= rows[cast].ms) {
    problems.push(`${hit} (${rows[hit].ms}ms) is not shorter than ${cast} (${rows[cast].ms}ms)`);
  }
}

// Fingerprint distinctness on the RENDERED audio, not the parameters.
const seen = new Map();
for (const name of CUES) {
  const r = rows[name];
  const key = `${r.peak.toFixed(2)}/${r.rms.toFixed(3)}/${Math.round(r.zcr / 25)}/${Math.round(r.ms / 25)}`;
  if (seen.has(key)) problems.push(`${name} renders identically to ${seen.get(key)} (${key})`);
  seen.set(key, name);
}

if (errs.length) problems.push(`page errors: ${errs.join(' | ')}`);

if (problems.length) {
  console.error('\nFAIL');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`\nOK  ${CUES.length} cues, all audible, all rendering to distinct fingerprints`);
