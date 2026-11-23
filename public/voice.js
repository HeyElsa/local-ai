// Microphone capture and answer playback. MiniRouter rejects WebM, the format
// browsers record by default, so speech is captured raw and encoded as WAV.

const TARGET_RATE = 16000;
export const MAX_SECONDS = 3600; // MiniRouter's limit per recording is an hour, and this also bounds memory use.
const PIECE_SECONDS = 240; // A 16 kHz WAV reaches MiniRouter's 8 MiB upload limit at about 4.3 minutes.
const SEARCH_SECONDS = 5;

// Converts captured audio to 16 kHz, 16-bit samples by averaging.
export function toSamples(chunks, sourceRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = sourceRate / TARGET_RATE;
  const output = new Int16Array(Math.floor(total / ratio));
  let chunk = 0;
  let inChunk = 0;
  let consumed = 0;
  for (let i = 0; i < output.length; i += 1) {
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    while (consumed < end && chunk < chunks.length) {
      sum += chunks[chunk][inChunk];
      count += 1;
      consumed += 1;
      inChunk += 1;
      if (inChunk >= chunks[chunk].length) { chunk += 1; inChunk = 0; }
    }
    const sample = Math.max(-1, Math.min(1, count ? sum / count : 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

// Splits long recordings for upload, cutting at the quietest moment near each limit so words stay whole.
export function splitSamples(samples, maxSeconds = PIECE_SECONDS, rate = TARGET_RATE) {
  const max = maxSeconds * rate;
  const search = Math.min(SEARCH_SECONDS * rate, Math.floor(max / 2));
  const windowSize = Math.floor(rate / 10);
  const pieces = [];
  let start = 0;
  while (samples.length - start > max) {
    const limit = start + max;
    let cut = limit;
    let quietest = Infinity;
    for (let at = limit - windowSize; at >= limit - search; at -= windowSize) {
      let energy = 0;
      for (let k = at; k < at + windowSize; k += 1) energy += Math.abs(samples[k]);
      if (energy < quietest) { quietest = energy; cut = at + Math.floor(windowSize / 2); }
    }
    pieces.push(samples.subarray(start, cut));
    start = cut;
  }
  pieces.push(samples.subarray(start));
  return pieces;
}

export function wavBlob(samples, rate = TARGET_RATE) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true));
  return new Blob([view], { type: 'audio/wav' });
}

const AUDIO_OPTIONS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function openMicrophone(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_OPTIONS, deviceId: { exact: deviceId } } });
  } catch (err) {
    if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
    return navigator.mediaDevices.getUserMedia({ audio: AUDIO_OPTIONS }); // That microphone has gone away.
  }
}

// The list a person would choose from. "Default" is an alias, so it is shown only if it adds something.
export async function listMicrophones() {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  const clean = (label) => label.replace(/^Default - /, '').replace(/ \(Built-in\)$/, '');
  const seen = new Set();
  const list = [];
  for (const device of [...inputs].sort((a) => (a.deviceId === 'default' ? 1 : -1))) {
    const name = clean(device.label) || 'Microphone';
    if (!seen.has(name)) { seen.add(name); list.push({ id: device.deviceId, name }); }
  }
  return { list, nameOf: clean };
}

// Records until told to stop: silence never ends a recording. Returns finish() and cancel().
// It asks for the system default, because Chrome otherwise may pick a phone linked to the Mac.
export async function startRecording({ deviceId = 'default', onLevel, onEnded }) {
  let stream = await openMicrophone(deviceId);
  let context;
  let source;
  let node;
  const watchTrack = () => { stream.getAudioTracks()[0].onended = () => onEnded?.(); };
  const stopStream = (old) => {
    const [track] = old.getAudioTracks();
    track.onended = null;
    old.getTracks().forEach((t) => t.stop());
  };
  try {
    try {
      // 16 kHz capture uses much less memory, but not every browser allows it for a microphone.
      context = new AudioContext({ sampleRate: TARGET_RATE });
      source = context.createMediaStreamSource(stream);
    } catch {
      context?.close();
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
    }
    await context.audioWorklet.addModule('/recorder-worklet.js');
    await context.resume();
    node = new AudioWorkletNode(context, 'recorder');
  } catch (err) {
    stopStream(stream);
    context?.close();
    throw err;
  }
  const chunks = [];
  let samples = 0;
  node.port.onmessage = ({ data }) => {
    chunks.push(data);
    samples += data.length;
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    onLevel?.(peak);
  };
  source.connect(node);
  watchTrack();
  const release = () => {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    stopStream(stream);
    context.close();
  };
  return {
    seconds: () => samples / context.sampleRate,
    label: () => stream.getAudioTracks()[0].label,
    // Changing microphone keeps what has been recorded so far.
    async useMicrophone(id) {
      const next = await openMicrophone(id);
      source.disconnect();
      stopStream(stream);
      stream = next;
      source = context.createMediaStreamSource(stream);
      source.connect(node);
      watchTrack();
    },
    cancel: release,
    finish() {
      const rate = context.sampleRate;
      release();
      return { samples: toSamples(chunks, rate), seconds: samples / rate };
    },
  };
}

// The words of an answer as a person would say them: visuals become their
// titles, and code and duplicate maths markup are left out.
export function speechText(answer) {
  const clone = answer.cloneNode(true);
  for (const node of clone.querySelectorAll('.code, .katex-mathml, .chart-box, details')) node.remove();
  for (const node of clone.querySelectorAll('.viz')) {
    const title = node.querySelector('.viz-title')?.textContent;
    const items = [...node.querySelectorAll('.stat, .timeline li, .steps li')];
    const leaves = 'div:not(:has(div))';
    const body = items.map((item) => [...item.querySelectorAll(leaves)].map((d) => d.textContent).join(', ')).join('. ');
    node.textContent = [title, body].filter(Boolean).join('. ');
    node.append('. ');
  }
  for (const node of clone.querySelectorAll('p, li, td, th, h1, h2, h3, h4, blockquote')) {
    node.append(/[.!?:]\s*$/.test(node.textContent) ? ' ' : '. ');
  }
  return clone.textContent.replace(/\s+/g, ' ').replace(/(\. ){2,}/g, '. ').trim();
}

// Short pieces start sooner and mean a stopped answer costs only what was played.
export function splitForSpeech(text, limit = 1200) {
  const pieces = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const at = cut > limit / 2 ? cut + 1 : Math.max(window.lastIndexOf(' '), 1);
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
