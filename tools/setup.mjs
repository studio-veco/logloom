// 使えるようにするまでの支度。**足りないものだけ取ってくる。**
//
//   node logloom/tools/setup.mjs
//
// 取ってくるもの（どれも大きいので、リポジトリには入れない）
//   drawio          公式のビルド（約155MB）→ vendor/drawio
//   whisper のモデル large-v3-turbo（約1.6GB）→ ~/.cache/whisper-models
//   会議の音の係     native/syscap.swift を組む → ~/.cache/logloom
//
// 確かめるもの（無くても動くが、できることが減る）
//   ffmpeg / whisper-cli / whisper-server … 音を扱う。無いと聞き取れない
//   swiftc            … 会議の音を拾う係を組むのに要る（macOS のみ）
//   claude            … 見出しと要約。無ければ発言の言葉から作る
//   校正の道具              … 誤字の辞書。無ければ辞書なしで動く
//   Jev の鍵          … 枝分け。無ければ発言の数で切る

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAWIO_VER = 'v31.4.6';
const DRAWIO_URL = `https://github.com/jgraph/drawio/releases/download/${DRAWIO_VER}/draw.war`;
const MODEL_DIR = path.join(os.homedir(), '.cache', 'whisper-models');
const MODEL = path.join(MODEL_DIR, 'ggml-large-v3-turbo.bin');
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';

const ok = (s) => console.log(`  ある    ${s}`);
const no = (s) => console.log(`  無い    ${s}`);
const has = (cmd) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;

function run(cmd, args, opts = {}) {
  console.log(`  > ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// ---- drawio ----------------------------------------------------------------

function setupDrawio() {
  const dir = path.join(ROOT, 'vendor', 'drawio');
  if (fs.existsSync(path.join(dir, 'index.html'))) return ok('drawio');
  console.log(`\n  drawio を取ってきます（${DRAWIO_VER}・約53MB／展開して約155MB）`);
  const war = path.join(ROOT, 'vendor', 'draw.war');
  fs.mkdirSync(path.join(ROOT, 'vendor'), { recursive: true });
  run('curl', ['-fL', '--progress-bar', '-o', war, DRAWIO_URL]);
  fs.mkdirSync(dir, { recursive: true });
  run('unzip', ['-q', '-o', war, '-d', dir]);
  fs.unlinkSync(war);
  ok('drawio');
}

// ---- 聞き取りのモデル -------------------------------------------------------

function setupModel() {
  if (fs.existsSync(MODEL)) return ok(`聞き取りのモデル（${MODEL}）`);
  console.log('\n  聞き取りのモデルを取ってきます（約1.6GB。回線によっては10分ほど）');
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  run('curl', ['-fL', '--progress-bar', '-o', MODEL, MODEL_URL]);
  ok('聞き取りのモデル');
}

// ---- 会議の音を拾う係 -------------------------------------------------------

async function setupSyscap() {
  if (process.platform !== 'darwin') return no('会議の音を拾う係（macOS だけの仕組みです）');
  if (!has('swiftc')) {
    return no('swiftc（会議の音を拾う係が組めません。`xcode-select --install` で入ります）');
  }
  const listen = await import(path.join(ROOT, 'lib', 'listen.mjs'));
  if (listen.syscapState().built) return ok('会議の音を拾う係');
  console.log('\n  会議の音を拾う係を組みます（20秒ほど）');
  await listen.buildSyscap();
  ok('会議の音を拾う係');
}

// ---- 確かめるだけのもの -----------------------------------------------------

async function check() {
  console.log('\n確かめます');
  for (const [cmd, why] of [
    ['ffmpeg', 'マイクの音を取り込みます'],
    ['whisper-server', '聞き取り（常駐）'],
    ['whisper-cli', '聞き取り（ファイル用）'],
    ['claude', '見出しと要約（どちらか一方でよい）'],
    ['codex', '見出しと要約と、議題の絵（どちらか一方でよい）'],
  ]) {
    if (has(cmd)) ok(`${cmd}（${why}）`);
    else no(`${cmd}（${why}）`);
  }
  if (!has('whisper-server')) {
    console.log('      → `brew install whisper-cpp` で入ります');
  }
  if (!has('ffmpeg')) console.log('      → `brew install ffmpeg` で入ります');

  const kotoba = await import(path.join(ROOT, 'lib', 'kotoba.mjs'));
  await kotoba.load();
  if (kotoba.ready()) ok(`校正辞書 ${kotoba.termCount().toLocaleString()} 語（${kotoba.glossaryPath()}）`);
  else no('校正辞書（誤字直しが弱くなります。LOGLOOM_GLOSSARY で場所を指せます）');
  kotoba.shutdown();

  const jev = await import(path.join(ROOT, 'lib', 'jev.mjs'));
  if (jev.available()) ok(`Jev の鍵（${jev.keySource()}）`);
  else no('Jev の鍵（枝は発言の数で切ります。画面の「ほかの操作」から入れられます）');
}

// ---- ここから --------------------------------------------------------------

console.log('LOGLOOMの支度をします\n');
try {
  setupDrawio();
  setupModel();
  await setupSyscap();
  await check();
  console.log('\n支度ができました。次のように起こしてください。\n');
  console.log('  node logloom/server.mjs 8580');
  console.log('  （スマホからも見るなら）  node logloom/server.mjs 8580 --lan\n');
  process.exit(0);
} catch (e) {
  console.error(`\n途中で止まりました：${e.message}`);
  process.exit(1);
}
