import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSamples, splitSamples, wavBlob } from '../public/voice.js';

test('audio converts to 16 kHz at any capture rate', () => {
  const samples = toSamples([new Float32Array(24000).fill(0.5), new Float32Array(24000).fill(0.5)], 48000);
  assert.equal(samples.length, 16000);
  assert.ok(Math.abs(samples[100] - 16383) < 2);
  assert.ok(samples.every((s) => s > 0));
});

test('short recordings stay whole', () => {
  const samples = new Int16Array(16000);
  assert.deepEqual(splitSamples(samples).map((p) => p.length), [16000]);
});

test('long recordings split at a quiet moment, lose nothing and fit the upload limit', () => {
  const rate = 16000;
  const samples = new Int16Array(rate * 500).fill(9000);
  const quiet = rate * 237;
  samples.fill(0, quiet, quiet + rate / 2);
  const pieces = splitSamples(samples);
  assert.equal(pieces.length, 3);
  assert.equal(pieces.reduce((n, p) => n + p.length, 0), samples.length);
  assert.ok(Math.abs(pieces[0].length - (quiet + rate / 4)) < rate / 2, `cut at ${pieces[0].length / rate}s`);
  for (const piece of pieces) assert.ok(wavBlobSize(piece) <= 8 * 1024 * 1024);
});

const wavBlobSize = (piece) => 44 + piece.length * 2;

test('a WAV file has the header MiniRouter expects', async () => {
  const blob = wavBlob(new Int16Array([1, -1, 300]));
  assert.equal(blob.type, 'audio/wav');
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(view.byteLength, 50);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(46, true), -1);
});
