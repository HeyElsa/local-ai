import { renderMarkdown } from '/render.js';
import { reasoningText, looksUnfinished } from '/stream.js';
import { maskText, unmaskText, describeHidden } from '/privacy.js';
import { startRecording, listMicrophones, splitSamples, wavBlob, speechText, splitForSpeech, MAX_SECONDS } from '/voice.js';
import { PROVIDERS, providerById, providerOf, routeFor, isLocalId, isAutoModel } from '/routing.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* optional */ } },
};

// The first of these that you have a key for is used until you choose a model. Infero comes first.
const DEFAULTS = {
  chat: ['infero:deepseek-v4-flash', 'minirouter/auto', 'openrouter:openrouter/auto'],
  image: ['infero:z-image-turbo', 'openai/gpt-image-1-mini'],
  video: ['google/veo-3.1-lite-generate-001'],
};
const SEND_LABEL = { chat: 'Ask', image: 'Make image', video: 'Make video' };
const SUGGESTED_LOCAL = 'gemma3:4b';
const PLACEHOLDER = { chat: 'Type your question', image: 'Describe the image you want', video: 'Describe the video you want' };
const STARTERS = [
  'How has the world’s population changed since 1800? Show a chart.',
  'Give me a timeline of the Apollo programme.',
  'How does HTTPS keep a connection private? Draw a diagram.',
  'What are the biggest AI stories this week?',
];

const state = {
  chats: [], chat: null, models: [], mode: 'chat',
  picked: store.get('picked', {}), web: store.get('web', true),
  attachments: [], busy: null, hasKey: false, keys: {}, voices: null,
  reading: null, autoReadId: null,
  voice: store.get('voice', 'alloy'), readBack: store.get('readBack', false),
  mask: store.get('mask', true), private: false, vault: 'locked', locked: false, temporary: false,
  ollama: false, pull: null, retentionDays: 0,
};

async function api(path, options = {}) {
  const init = { ...options };
  if (options.json !== undefined) {
    init.method ||= 'POST';
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(options.json);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `The local server returned ${res.status}.`);
    err.status = res.status;
    if (res.status === 423) showLock();
    throw err;
  }
  return res;
}
const apiJson = async (path, options) => (await api(path, options)).json();

const modelInfo = (id) => state.models.find((m) => m.id === id);
// Image mode can be limited to one provider in Settings, while that provider has a key.
const imageVia = () => ((state.imageOptions || []).some((p) => p.id === state.imageVia) ? state.imageVia : null);
const allowed = (mode, m) => Boolean(m) && m.kind === mode && (mode !== 'image' || !imageVia() || m.via === imageVia());
const defaultModel = (mode) => {
  const listed = DEFAULTS[mode].find((id) => allowed(mode, modelInfo(id)));
  if (listed) return listed;
  // Otherwise the first cloud model in order of preference, then a local one.
  const ofKind = state.models.filter((m) => allowed(mode, m));
  return (ofKind.find((m) => !m.local) || ofKind[0])?.id
    || DEFAULTS[mode].find((id) => state.keys[providerOf(id).id]) || DEFAULTS[mode][0];
};
const currentModel = (mode = state.mode) => {
  const id = state.picked[mode];
  if (!id) return defaultModel(mode);
  // A chosen local model is never swapped for a cloud one, even if Ollama has stopped.
  if (isLocalId(id) && !state.private) return id;
  return allowed(mode, modelInfo(id)) ? id : defaultModel(mode);
};
// Where the next question really goes, using the same rule as the server.
const routeNow = (id = currentModel('chat')) => routeFor(id, state.web, { models: state.models, keys: state.keys, searchVia: state.searchVia });
const viaName = (id) => (providerOf(id).custom ? state.custom?.name || 'your custom endpoint' : providerOf(id).name);
const formatUsd = (v) => (v >= 0.01 ? `$${v.toFixed(2)}` : `$${Number(v.toPrecision(2))}`);

function note(text = '', bad = false) {
  $('composer-note').textContent = text;
  $('composer-note').classList.toggle('bad', bad);
}

/* ---------- saving ---------- */

const offRecord = () => state.temporary || state.private;

async function saveChat(chat) {
  if (chat.temporary || state.private) return;
  chat.updatedAt = Date.now();
  await api(`/api/chats/${chat.id}`, { method: 'PUT', json: chat });
  const row = { id: chat.id, title: chat.title, updatedAt: chat.updatedAt };
  state.chats = [row, ...state.chats.filter((c) => c.id !== chat.id)];
  renderChatList();
}

function newChatObject(firstText) {
  const title = firstText.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Attachment';
  const chat = { id: crypto.randomUUID(), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  if (offRecord()) chat.temporary = true;
  return chat;
}

/* ---------- sidebar ---------- */

function renderChatList() {
  const filter = $('chat-filter').value.trim().toLowerCase();
  const list = $('chat-list');
  list.replaceChildren();
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups = [
    ['Today', (c) => c.updatedAt >= startOfToday],
    ['Last 7 days', (c) => c.updatedAt >= startOfToday - 6 * 864e5 && c.updatedAt < startOfToday],
    ['Older', (c) => c.updatedAt < startOfToday - 6 * 864e5],
  ];
  const chats = state.chats.filter((c) => !filter || (c.title || '').toLowerCase().includes(filter));
  for (const [name, test] of groups) {
    const inGroup = chats.filter(test);
    if (!inGroup.length) continue;
    list.append(el('div', 'chat-group', name));
    for (const chat of inGroup) list.append(chatRow(chat));
  }
  if (!chats.length && filter) list.append(el('div', 'chat-group', 'No chats match'));
  $('clear-chats').hidden = !state.chats.length;
}

function chatRow(chat) {
  const row = el('div', 'chat-row');
  row.classList.toggle('active', state.chat?.id === chat.id);
  const open = el('button', 'chat-open', chat.title || 'Untitled');
  open.title = chat.title || '';
  open.addEventListener('click', () => openChat(chat.id));
  const del = el('button', 'chat-delete', 'Delete');
  del.setAttribute('aria-label', `Delete ${chat.title}`);
  del.addEventListener('click', async () => {
    if (!del.classList.contains('armed')) {
      del.classList.add('armed');
      del.textContent = 'Confirm';
      setTimeout(() => { del.classList.remove('armed'); del.textContent = 'Delete'; }, 3000);
      return;
    }
    await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
    state.chats = state.chats.filter((c) => c.id !== chat.id);
    if (state.chat?.id === chat.id) startNew();
    renderChatList();
  });
  row.append(open, del);
  return row;
}

const isNarrow = () => matchMedia('(max-width: 760px)').matches;
function setSidebar(open) {
  document.body.classList.toggle('side-closed', !open);
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
  $('toggle-sidebar').textContent = open ? 'Hide chats' : 'Chats';
  if (!isNarrow()) store.set('sidebar', open);
}

/* ---------- thread ---------- */

function renderWelcome() {
  const wrap = el('section', 'welcome column');
  if (state.temporary && !state.private) {
    wrap.append(el('h1', '', 'Off the record.'), el('p', 'welcome-note', 'This chat and its files are erased when you leave it. Nothing is added to your chat list.'));
    $('thread').replaceChildren(wrap);
    return;
  }
  wrap.append(el('h1', '', state.private ? 'Just this computer.' : 'Ask anything.'));
  if (state.private) wrap.append(el('p', 'welcome-note', 'Nothing here is saved. This chat and its files are gone when you leave it.'));
  if (state.private && !state.models.some((m) => m.local)) {
    wrap.append(el('p', 'welcome-note', 'Private mode needs a model on this computer. Choose one from the model button below.'));
    $('thread').replaceChildren(wrap);
    return;
  }
  for (const text of STARTERS) {
    const b = el('button', 'starter', text);
    b.type = 'button';
    b.addEventListener('click', () => { $('input').value = text; autoGrow(); submit(); });
    wrap.append(b);
  }
  $('thread').replaceChildren(wrap);
}

function mediaElement(media, label) {
  if (media.kind === 'video') {
    const video = el('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = `/media/${media.id}`;
    video.setAttribute('aria-label', label);
    return video;
  }
  const img = el('img');
  img.src = `/media/${media.id}`;
  img.alt = label;
  img.loading = 'lazy';
  return img;
}

const thoughtFor = (seconds) => (seconds >= 1
  ? `Thought for ${Math.round(seconds)} ${Math.round(seconds) === 1 ? 'second' : 'seconds'}`
  : 'Thought for a moment');

function thinkingBox(message) {
  const box = el('details', 'thinking');
  const summary = el('summary', '', message.thinkingSeconds === undefined ? 'Thinking' : thoughtFor(message.thinkingSeconds));
  const text = el('div', 'thinking-text', message.thinking || '');
  box.append(summary, text);
  return box;
}

function renderUser(message) {
  const turn = el('section', 'turn column');
  turn.dataset.user = message.id;
  if (message.attachments?.length) {
    const wrap = el('div', 'sent-media');
    for (const a of message.attachments) {
      const figure = el('figure');
      figure.append(mediaElement(a, a.name || 'Attachment'));
      if (a.kind === 'video') figure.append(el('figcaption', '', `${a.frames?.length || 0} still ${a.frames?.length === 1 ? 'frame' : 'frames'} sent to the model`));
      wrap.append(figure);
    }
    turn.append(wrap);
  }
  const text = message.content || '';
  if (text) {
    const question = el('h2', `question ${text.length > 200 ? 'q-l' : text.length > 70 ? 'q-m' : ''}`, text);
    turn.append(question);
  }
  return turn;
}

function metaInfo(message) {
  const bits = [];
  const model = message.servedModel || message.model;
  if (model) bits.push(modelInfo(model)?.name || model);
  if (message.handedOff) bits.push(`Sent to ${message.handedOff} to search the web`);
  if (message.searches) bits.push(`${message.searches} web ${message.searches === 1 ? 'search' : 'searches'}`);
  if (message.cost) bits.push(formatUsd(Number(message.cost)));
  if (message.hidden) bits.push(`Hid ${message.hidden} from the model`);
  if (message.stopped) bits.push('Stopped');
  if (message.searchOff) bits.push('This model could not use web search');
  return bits.join(', ');
}

function fillAssistant(holder, message, isLast) {
  holder.replaceChildren();
  if (message.media) {
    const made = el('div', 'made');
    made.append(mediaElement(message.media, `Generated from: ${message.prompt || ''}`));
    const actions = el('div', 'made-actions');
    const save = el('a', 'quiet', `Save ${message.media.kind}`);
    save.href = `/media/${message.media.id}`;
    save.download = message.media.id;
    actions.append(save);
    made.append(actions);
    holder.append(made);
  } else if (message.job) {
    const pct = message.progress ? `, ${message.progress}% done` : '';
    holder.append(statusLine(`Making your video${pct}. This usually takes a few minutes, and you can keep using the app`));
  } else if (message.error) {
    const box = el('div', 'error-box');
    box.append(el('p', '', message.error));
    if (message.needsKey) {
      const add = el('button', 'solid', 'Open Settings');
      add.addEventListener('click', () => $('settings-dialog').showModal());
      box.append(add);
    } else if (isLast) {
      const retry = el('button', 'solid', 'Try again');
      retry.addEventListener('click', () => regenerate());
      box.append(retry);
    }
    holder.append(box);
    return;
  } else {
    if (message.thinking) holder.append(thinkingBox(message));
    const body = el('div', 'answer');
    renderMarkdown(body, message.content || '');
    holder.append(body);
  }
  const meta = el('div', 'meta');
  if (message.content) {
    const copy = el('button', 'quiet', 'Copy');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(message.content);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });
    meta.append(copy);
  }
  if (message.content && !state.busy) {
    const read = el('button', 'quiet', readLabel(message.id));
    read.dataset.read = message.id;
    read.addEventListener('click', () => readAloud(message));
    meta.append(read);
  }
  if (isLast && !message.job && !state.busy) {
    const again = el('button', 'quiet', 'Try again');
    again.addEventListener('click', () => regenerate());
    meta.append(again);
  }
  if (!state.busy && looksUnfinished(message)) {
    const cutOff = message.finishReason === 'length' || message.finishReason === 'tool_calls';
    holder.append(el('p', 'unfinished', cutOff
      ? 'This answer was cut off before it finished. Try again, or choose another model.'
      : 'The model stopped before giving its answer. Try again, or choose another model.'));
  }
  const info = metaInfo(message);
  if (info) meta.append(el('span', 'meta-info', info));
  holder.append(meta);
}

function renderThread() {
  const chat = state.chat;
  if (!chat?.messages.length) return renderWelcome();
  const thread = $('thread');
  const nodes = [];
  let turn = null;
  chat.messages.forEach((message, i) => {
    if (message.role === 'user') {
      turn = renderUser(message);
      nodes.push(turn);
    } else {
      const holder = el('div');
      holder.dataset.assistant = message.id;
      fillAssistant(holder, message, i === chat.messages.length - 1);
      (turn || thread).append(holder);
    }
  });
  thread.replaceChildren(...nodes);
  return undefined;
}

/* ---------- following an answer as it arrives ---------- */

// While an answer streams, the page keeps its newest part in view. Scrolling up
// stops that so you can read; scrolling back to the bottom starts it again.
const scroller = $('scroller');
const follow = { on: false, lastTop: 0, until: 0, token: null };
const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
scroller.addEventListener('scroll', () => {
  const top = scroller.scrollTop;
  // Moving up while not pinned at the bottom can only be you; content shrinking leaves you at the bottom.
  if (top < follow.lastTop - 2 && !atBottom()) follow.on = false;
  else if (atBottom()) follow.on = true;
  follow.lastTop = top;
}, { passive: true });
// Text, the thinking box, and charts and diagrams that finish drawing later all change the size.
new ResizeObserver(() => {
  if (!follow.on || performance.now() > follow.until) return;
  const target = scroller.scrollHeight - scroller.clientHeight;
  if (scroller.scrollTop < target - 1) scroller.scrollTop = target;
}).observe($('thread'));

function startFollowing() {
  const token = {};
  Object.assign(follow, { on: true, lastTop: scroller.scrollTop, until: Infinity, token });
  return token;
}
// Charts and diagrams can still be drawing just after the text ends.
function stopFollowing(token) {
  if (follow.token === token) follow.until = performance.now() + 2000;
}
function cancelFollowing() {
  Object.assign(follow, { until: 0, token: null });
}

function scrollToLatestQuestion() {
  const turns = $('thread').querySelectorAll('.turn');
  requestAnimationFrame(() => turns[turns.length - 1]?.scrollIntoView({ block: 'start' }));
}

// Erases a temporary chat's files. The chat itself only ever existed in this page.
function discardTemporary() {
  const chat = state.chat;
  const ids = [];
  for (const a of state.attachments) if (a.id?.startsWith('temp-')) ids.push(a.id);
  if (chat) {
    for (const m of chat.messages) {
      if (m.media?.id) ids.push(m.media.id);
      for (const a of m.attachments || []) {
        ids.push(a.id);
        for (const frame of a.frames || []) ids.push(frame.id);
      }
    }
  }
  for (const id of ids) {
    if (id?.startsWith('temp-')) fetch(`/api/media/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
  if (offRecord()) { state.attachments = []; renderAttachments(); }
}

async function openChat(id) {
  if (state.busy) stop();
  cancelFollowing();
  stopReading();
  discardTemporary();
  state.temporary = false;
  renderComposer();
  const chat = await apiJson(`/api/chats/${id}`);
  state.chat = chat;
  renderThread();
  renderChatList();
  scrollToLatestQuestion();
  if (isNarrow()) setSidebar(false);
  for (const message of chat.messages) if (message.job) pollVideo(chat.id, message.id, message.job);
  $('input').focus();
}

function startNew(temporary = false) {
  if (state.busy) stop();
  cancelFollowing();
  stopReading();
  discardTemporary();
  note();
  state.chat = null;
  state.temporary = temporary;
  if (temporary && state.mode === 'video') state.mode = 'chat';
  $('temp-chat').setAttribute('aria-current', String(temporary));
  renderComposer();
  renderThread();
  renderChatList();
  if (isNarrow()) setSidebar(false);
  $('input').focus();
}

/* ---------- composer ---------- */

function autoGrow() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
  updateSend();
}

// The logo's sparkle twinkles while the app waits, and a counter appears once a wait runs long.
const MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect class="mark-field" width="32" height="32"/><path class="mark-ink" d="M8 7h5v13h11v5H8z"/><path class="mark-ink mark-spark" d="M22 2.5Q23.5 8.5 29.5 10Q23.5 11.5 22 17.5Q20.5 11.5 14.5 10Q20.5 8.5 22 2.5Z"/></svg>';

function statusLine(text) {
  const line = el('p', 'status');
  line.setAttribute('role', 'status');
  line.insertAdjacentHTML('afterbegin', MARK);
  const words = el('span', 'shimmer', text);
  const elapsed = el('span', 'elapsed');
  elapsed.setAttribute('aria-hidden', 'true'); // A ticking count would be read out every second.
  line.append(words, elapsed);
  const started = performance.now();
  const timer = setInterval(() => {
    if (!line.isConnected) { clearInterval(timer); return; }
    const seconds = Math.floor((performance.now() - started) / 1000);
    if (seconds >= 3) elapsed.textContent = `${seconds}s`;
  }, 1000);
  return line;
}

const SEND_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 20V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor"/></svg>';

// The button says what it will do, and stays unavailable until there is something to send.
function updateSend() {
  const send = $('send');
  const label = state.busy ? 'Stop' : SEND_LABEL[state.mode];
  send.innerHTML = state.busy ? STOP_ICON : SEND_ICON;
  send.setAttribute('aria-label', label);
  send.title = label;
  const hasContent = $('input').value.trim() || (state.mode === 'chat' && state.attachments.length);
  send.disabled = !state.busy && !hasContent;
}

function destinationText() {
  const id = currentModel();
  const info = modelInfo(id);
  let text;
  const route = state.mode === 'chat' ? routeNow(id) : { model: id };
  const via = viaName(route.model);
  if (state.private && !info) text = 'Private mode: choose a model on this computer';
  else if (isLocalId(id)) text = 'Stays on this computer';
  else if (route.handedOff) text = `Web search on: goes to ${via} and the model it picks, not ${viaName(id)}`;
  else if (isAutoModel(id) || !info?.provider) text = `Goes to ${via} and the model it picks`;
  else if (info.via === 'infero') text = 'Goes to Infero and the host it picks';
  else if (info.via === 'custom') text = `Goes to ${via} at ${state.custom ? new URL(state.custom.base).host : 'your endpoint'}`;
  // These companies run the models themselves, so nobody else receives the message.
  else if (providerOf(id).more) text = `Goes to ${via}`;
  else text = `Goes to ${via} and ${info.provider}`;
  return offRecord() ? `${text}. Not saved` : text;
}

function setBusy(busy) {
  state.busy = busy;
  const send = $('send');
  send.classList.toggle('stop', Boolean(busy));
  updateSend();
}

function updateEstimate() {
  const model = modelInfo(currentModel());
  let text = '';
  if (model && state.mode === 'image' && model.imagePrice) text = `About ${formatUsd(model.imagePrice)}`;
  if (model && state.mode === 'video') {
    const tier = model.videoControls?.sizes?.find((s) => s.size === $('video-size').value)?.tier;
    const price = model.videoPrices.find((p) => p.tier === tier && !p.audio) || model.videoPrices[0];
    if (price) text = `About ${formatUsd(Number($('video-seconds').value) * Number(price.usd_per_second))}`;
  }
  $('estimate').textContent = text;
}

function updateVideoControls() {
  const controls = modelInfo(currentModel('video'))?.videoControls;
  const seconds = $('video-seconds');
  const size = $('video-size');
  seconds.replaceChildren(...(controls?.seconds || []).map((s) => {
    const o = el('option', '', `${s} seconds`);
    o.value = s;
    return o;
  }));
  size.replaceChildren(...(controls?.sizes || []).map((s) => {
    const o = el('option', '', s.tier || s.size);
    o.value = s.size;
    return o;
  }));
}

function renderComposer() {
  if (state.private && state.mode !== 'chat') state.mode = 'chat';
  const { mode } = state;
  for (const b of document.querySelectorAll('.modes button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    b.hidden = (b.dataset.mode !== 'chat' && state.private) || (b.dataset.mode === 'video' && state.temporary);
  }
  document.querySelector('.modes').hidden = state.private;
  $('mic').hidden = state.private;
  $('attach').hidden = mode !== 'chat';
  $('web').hidden = mode !== 'chat' || state.private || isLocalId(currentModel());
  $('video-options').hidden = mode !== 'video';
  $('attachments').hidden = mode !== 'chat';
  $('input').placeholder = PLACEHOLDER[mode];
  updateSend();
  const id = currentModel();
  const destination = $('destination');
  destination.textContent = destinationText();
  destination.classList.toggle('local', isLocalId(id));
  $('model-name').textContent = state.private && !modelInfo(id) ? 'Choose a model' : (modelInfo(id)?.name || id.replace(/^(local\/|infero:|openrouter:)/, ''));
  $('model').title = `Model: ${id}`;
  $('web').setAttribute('aria-pressed', String(state.web));
  $('web').setAttribute('aria-label', state.web ? 'Web search on' : 'Web search off');
  const searcher = providerOf(id).supports.search;
  const route = routeFor(id, true, { models: state.models, keys: state.keys, searchVia: state.searchVia });
  let webTitle = 'Web search is off. The model answers without searching.';
  if (state.web && searcher) webTitle = 'Web search is on. The model can search when it needs to, and each search costs a little.';
  else if (state.web && route.handedOff) webTitle = `Web search is on. ${viaName(id)} can't search, so questions go to ${viaName(route.model)} instead. Turn this off to stay on ${viaName(id)}.`;
  else if (state.web) webTitle = `Web search is on, but ${viaName(id)} can't search. Add a MiniRouter or OpenRouter key to search.`;
  $('web').title = webTitle;
  if (mode === 'video') updateVideoControls();
  updateEstimate();
}

/* ---------- attachments ---------- */

function renderAttachments() {
  $('attachments').replaceChildren(...state.attachments.map((a) => {
    const chip = el('div', `chip${a.ready ? '' : ' loading'}`);
    const preview = el(a.kind === 'video' ? 'video' : 'img');
    preview.src = a.preview;
    if (a.kind === 'video') preview.muted = true;
    else preview.alt = a.name;
    const remove = el('button', '', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${a.name}`);
    remove.addEventListener('click', () => {
      state.attachments = state.attachments.filter((x) => x !== a);
      renderAttachments();
    });
    chip.append(preview, remove);
    return chip;
  }));
  updateSend();
}

const uploadBlob = async (blob) => apiJson(`/api/media${state.temporary ? '?temporary=1' : ''}`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });

// The docs only describe image input, so a video is sent as evenly spaced still frames.
async function extractFrames(file, url) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error(`This browser cannot read ${file.name}. Try an MP4 file.`));
  });
  // Some recordings do not report a length until the browser has seeked to the end.
  const seek = (t) => new Promise((resolve) => { video.onseeked = resolve; video.currentTime = t; });
  if (!Number.isFinite(video.duration)) await seek(1e9);
  const duration = Number.isFinite(video.duration) ? video.duration : video.currentTime;
  const count = Math.min(8, Math.max(3, Math.ceil(duration / 3)));
  const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const t = (duration * (i + 0.5)) / count;
    await seek(t);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', 0.8); });
    frames.push({ id: (await uploadBlob(blob)).id, t });
  }
  return frames;
}

async function addFiles(files) {
  if (state.mode !== 'chat') setMode('chat');
  for (const file of files) {
    const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : null;
    if (!kind) { note(`${file.name} can't be attached. Use an image or a video.`, true); continue; }
    const attachment = { kind, name: file.name, preview: URL.createObjectURL(file), ready: false };
    state.attachments.push(attachment);
    renderAttachments();
    try {
      attachment.id = (await uploadBlob(file)).id;
      if (kind === 'video') attachment.frames = await extractFrames(file, attachment.preview);
      attachment.ready = true;
      const model = modelInfo(currentModel('chat'));
      if (isLocalId(currentModel('chat')) && !model?.seesImages) {
        // Never moved to the cloud without asking.
        note('This local model can\u2019t see images. Choose a local vision model, or remove the attachment.', true);
      } else if (model && !model.seesImages) {
        // Prefer a model from the same provider, so the attachment goes nowhere new.
        const sees = state.models.filter((m) => !m.local && m.kind === 'chat' && m.seesImages);
        const next = sees.find((m) => m.via === model.via && isAutoModel(m.id)) || sees.find((m) => m.via === model.via) || sees[0];
        if (next) {
          state.picked.chat = next.id;
          store.set('picked', state.picked);
          note(`${model.name} can't see images, so this chat switched to ${next.name}${next.via === model.via ? '' : ` on ${viaName(next.id)}`}.`);
          renderComposer();
        } else {
          note(`${model.name} can't see images. Choose a model that can, or remove the attachment.`, true);
        }
      }
    } catch (err) {
      state.attachments = state.attachments.filter((a) => a !== attachment);
      note(err.message, true);
    }
    renderAttachments();
  }
}

/* ---------- asking ---------- */

const historyFor = (chat) => chat.messages
  .filter((m) => !m.error && (m.role === 'user' || m.content || m.media))
  .map(({ role, content, attachments, media }) => ({
    role, content, media,
    attachments: attachments?.map(({ kind, id, name, frames }) => ({ kind, id, name, frames })),
  }));

function holderFor(message) {
  return $('thread').querySelector(`[data-assistant="${message.id}"]`);
}

async function streamAnswer(chat, message) {
  const controller = new AbortController();
  setBusy({ controller });
  const followToken = startFollowing();
  const holder = holderFor(message);
  const local = isLocalId(message.model);
  const masks = !local && state.mask ? (chat.masks ||= {}) : null;
  const status = statusLine(state.web && !local ? 'Thinking, and searching the web if needed' : 'Thinking');
  holder.replaceChildren(status);
  const body = el('div', 'answer');
  const cache = new Map();
  let frame = null;
  let box = null;
  let touched = false; // Once you open or close the section yourself, the app leaves it alone.
  // Search rounds aren't streamed and their reasoning arrives in one burst, so time from the question.
  const thinkingStart = performance.now();
  let thought = false;
  const endThinking = () => {
    if (thought && message.thinkingSeconds === undefined) {
      message.thinkingSeconds = (performance.now() - thinkingStart) / 1000;
    }
  };
  const paint = () => {
    frame = null;
    if (message.thinking && !box) {
      box = thinkingBox(message);
      box.open = true;
      box.querySelector('summary').classList.add('shimmer'); // Still thinking.
      box.querySelector('summary').addEventListener('click', () => { touched = true; });
      holder.replaceChildren(box);
    }
    if (box) {
      const text = box.querySelector('.thinking-text');
      const following = text.scrollHeight - text.scrollTop - text.clientHeight < 40;
      text.textContent = unmaskText(message.thinking, masks);
      if (following) text.scrollTop = text.scrollHeight;
    }
    if (!message.content) return;
    if (box && !body.isConnected) {
      endThinking();
      box.querySelector('summary').textContent = thoughtFor(message.thinkingSeconds);
      box.querySelector('summary').classList.remove('shimmer');
      if (!touched) box.open = false;
    }
    if (!body.isConnected) holder.replaceChildren(...(box ? [box, body] : [body]));
    renderMarkdown(body, unmaskText(message.content, masks), { streaming: true, cache });
  };

  try {
    let history = historyFor({ messages: chat.messages.filter((m) => m !== message) });
    if (masks) {
      history = history.map((m) => ({ ...m, content: maskText(m.content, masks) }));
      message.hidden = describeHidden(history.findLast((m) => m.role === 'user')?.content) || undefined;
    }
    const res = await api('/api/chat', {
      json: { model: message.model, web: state.web && !isLocalId(message.model), masked: Boolean(masks && Object.keys(masks).length), messages: history },
      signal: controller.signal,
    });
    message.servedModel = res.headers.get('x-served-model') || undefined;
    message.searchOff = state.web && !local && res.headers.get('x-search-available') === 'false' ? true : undefined;
    const via = res.headers.get('x-served-via');
    message.handedOff = res.headers.get('x-handed-off') === 'true' ? providerById(via)?.name : undefined;
    const balance = res.headers.get('x-balance-usd');
    if (balance) showBalance(balance, via);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { finished = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw new Error(chunk.error.message || String(chunk.error));
        const choiceDelta = chunk.choices?.[0]?.delta;
        const finishReason = chunk.choices?.[0]?.finish_reason;
        if (finishReason) message.finishReason = finishReason;
        const reasoning = reasoningText(choiceDelta);
        if (reasoning) {
          thought = true;
          message.thinking = (message.thinking || '') + reasoning;
          frame ??= requestAnimationFrame(paint);
        }
        const delta = choiceDelta?.content;
        if (delta) {
          message.content += delta;
          frame ??= requestAnimationFrame(paint);
        }
        if (chunk.usage) {
          message.cost = chunk.usage.cost;
          // MiniRouter and OpenRouter count searches under different names.
          const tools = chunk.usage.server_tool_use || chunk.usage.server_tool_use_details || {};
          message.searches = (tools.google_search_requests || 0) + (tools.web_search_requests || 0);
        }
      }
    }
    if (!message.content) throw new Error('The model returned an empty answer. Try again or choose another model.');
  } catch (err) {
    if (controller.signal.aborted) {
      message.stopped = true;
    } else if (message.content) {
      message.stopped = true;
      note(`The answer ended early: ${err.message}`, true);
    } else {
      message.error = err.message;
      message.needsKey = err.status === 401 && !state.hasKey;
    }
  }
  if (frame) cancelAnimationFrame(frame);
  endThinking();
  message.content = unmaskText(message.content, masks);
  message.thinking = unmaskText(message.thinking, masks);
  setBusy(null);
  if (state.chat?.id === chat.id) renderThread();
  stopFollowing(followToken);
  if (!message.error) await saveChat(chat).catch((err) => note(`This chat could not be saved: ${err.message}`, true));
  if (state.autoReadId === message.id) {
    state.autoReadId = null;
    if (!message.error && !message.stopped && state.chat?.id === chat.id) readAloud(message);
  }
}

async function makeImage(chat, message) {
  const controller = new AbortController();
  setBusy({ controller });
  holderFor(message).replaceChildren(statusLine('Making your image'));
  try {
    const { media, cost } = await apiJson('/api/images', { json: { model: message.model, prompt: message.prompt, temporary: Boolean(chat.temporary) }, signal: controller.signal });
    Object.assign(message, { media, cost });
  } catch (err) {
    if (controller.signal.aborted) message.error = 'Stopped. The provider may still charge for an image it had started.';
    else { message.error = err.message; message.needsKey = err.status === 401 && !state.hasKey; }
  }
  setBusy(null);
  if (state.chat?.id === chat.id) renderThread();
  if (!message.error) await saveChat(chat);
}

async function makeVideo(chat, message) {
  holderFor(message).replaceChildren(statusLine('Starting your video'));
  try {
    const { jobId } = await apiJson('/api/videos', {
      json: { model: message.model, prompt: message.prompt, seconds: message.seconds, size: message.size },
    });
    message.job = jobId;
    await saveChat(chat);
    if (state.chat?.id === chat.id) renderThread();
    pollVideo(chat.id, message.id, jobId);
  } catch (err) {
    message.error = err.message;
    message.needsKey = err.status === 401 && !state.hasKey;
    if (state.chat?.id === chat.id) renderThread();
  }
}

const polling = new Set();
async function pollVideo(chatId, messageId, jobId) {
  if (polling.has(jobId)) return;
  polling.add(jobId);
  const apply = async (changes) => {
    // Read the saved chat again: more messages may have been added since the video started.
    const saved = await apiJson(`/api/chats/${chatId}`);
    const target = saved.messages.find((m) => m.id === messageId);
    if (target) { Object.assign(target, changes); await saveChat(saved); }
    if (state.chat?.id === chatId) {
      const live = state.chat.messages.find((m) => m.id === messageId);
      if (live) Object.assign(live, changes);
      if (!state.busy) renderThread();
    }
  };
  let failures = 0;
  while (polling.has(jobId)) {
    try {
      const job = await apiJson(`/api/videos/${encodeURIComponent(jobId)}`);
      failures = 0;
      if (job.status === 'completed') {
        await apply({ job: undefined, media: job.media, cost: job.cost });
        break;
      }
      if (job.status === 'failed') {
        await apply({ job: undefined, error: job.error });
        break;
      }
      if (state.chat?.id === chatId) {
        const live = state.chat.messages.find((m) => m.id === messageId);
        if (live && live.progress !== job.progress) {
          live.progress = job.progress;
          const holder = holderFor(live);
          if (holder) fillAssistant(holder, live, state.chat.messages.at(-1) === live);
        }
      }
    } catch (err) {
      // Private mode or a locked app only pauses the wait. The video is still being made.
      if (err.status === 403 || err.status === 423) {
        await new Promise((resolve) => { setTimeout(resolve, 10000); });
        continue;
      }
      failures += 1;
      if (failures >= 6 || err.status === 410 || err.status === 404) {
        await apply({ job: undefined, error: `The video could not be retrieved: ${err.message}` }).catch(() => {});
        break;
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 10000); });
  }
  polling.delete(jobId);
}

function dispatch(chat, message) {
  if (message.kind === 'image') return makeImage(chat, message);
  if (message.kind === 'video') return makeVideo(chat, message);
  return streamAnswer(chat, message);
}

async function submit() {
  if (state.busy) return stop();
  stopReading();
  const text = $('input').value.trim();
  const { mode } = state;
  const attachments = mode === 'chat' ? state.attachments : [];
  if (attachments.some((a) => !a.ready)) return note('Wait for your attachment to finish preparing.');
  if (!text && !attachments.length) return $('input').focus();
  const picked = modelInfo(currentModel());
  if (state.private && !picked) { openModelPicker(); return note('Choose a model on this computer first.', true); }
  if (attachments.length && isLocalId(currentModel()) && picked && !picked.seesImages) return note('This local model can\u2019t see images. Choose a local vision model, or remove the attachment.', true);
  note();

  const chat = state.chat || (state.chat = newChatObject(text || attachments[0].name));
  chat.messages.push({
    id: crypto.randomUUID(), role: 'user', content: text,
    attachments: attachments.length ? attachments.map(({ kind, id, name, frames }) => ({ kind, id, name, frames })) : undefined,
  });
  const message = { id: crypto.randomUUID(), role: 'assistant', content: '', model: currentModel(), kind: mode };
  if (mode !== 'chat') message.prompt = text;
  if (mode === 'video') {
    message.seconds = Number($('video-seconds').value);
    message.size = $('video-size').value;
  }
  chat.messages.push(message);
  if (mode === 'chat' && state.speakNext) state.autoReadId = message.id;
  state.speakNext = false;

  $('input').value = '';
  autoGrow();
  state.attachments = [];
  renderAttachments();
  renderThread();
  renderChatList();
  scrollToLatestQuestion();
  saveChat(chat).catch((err) => note(`This chat could not be saved: ${err.message}`, true));
  return dispatch(chat, message);
}

function stop() {
  state.busy?.controller?.abort();
}

async function regenerate() {
  const chat = state.chat;
  const last = chat?.messages.at(-1);
  if (!last || last.role !== 'assistant' || state.busy) return;
  // A paid request is only repeated when you ask for it, and the same settings are reused.
  const fresh = {
    id: crypto.randomUUID(), role: 'assistant', content: '', kind: last.kind || 'chat',
    model: last.kind && last.kind !== 'chat' ? last.model : currentModel('chat'),
    prompt: last.prompt, seconds: last.seconds, size: last.size,
  };
  chat.messages[chat.messages.length - 1] = fresh;
  renderThread();
  await dispatch(chat, fresh);
}

function setMode(mode) {
  state.mode = mode;
  renderComposer();
  $('input').focus();
}

/* ---------- voice ---------- */

const clock = (seconds) => {
  const s = Math.floor(seconds);
  const minutes = String(Math.floor(s / 60) % 60);
  const rest = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${minutes.padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};

const voice = {
  phase: 'idle', recording: null, bars: [], peak: 0, lastBar: 0, seconds: 0, frame: null, timer: null,
  pieces: [], texts: [], controller: null, retry: null, armTimer: null,
  heard: false, lastSound: 0, silent: false,
};

function micError(err) {
  if (err.name === 'NotAllowedError') return 'Microphone access is blocked. Allow it for this site in your browser, then try again.';
  if (err.name === 'NotFoundError') return 'No microphone was found. Connect one and try again.';
  return `The microphone could not start: ${err.message}`;
}

// One waveform for every stage: it scrolls while listening, then shows the whole recording.
function drawWave(now) {
  const canvas = $('voice-wave');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = devicePixelRatio || 1;
  if (canvas.width !== width * scale || canvas.height !== height * scale) {
    canvas.width = width * scale;
    canvas.height = height * scale;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent');
  const quiet = styles.getPropertyValue('--muted');
  const step = 5;
  const count = Math.max(1, Math.floor(width / step));
  let bars;
  if (voice.phase === 'listening' || voice.phase === 'starting') {
    bars = voice.bars.slice(-count);
  } else {
    const size = Math.max(1, voice.bars.length / count);
    bars = [];
    for (let i = 0; i < Math.min(count, voice.bars.length); i += 1) {
      const part = voice.bars.slice(Math.floor(i * size), Math.max(Math.floor((i + 1) * size), Math.floor(i * size) + 1));
      bars.push(Math.max(...part));
    }
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sweep = !still && voice.phase === 'writing' ? ((now / 1400) % 1.3) * bars.length : -99;
  const done = voice.phase === 'writing' ? voice.texts.length / voice.pieces.length : 0;
  bars.forEach((level, i) => {
    const barHeight = Math.max(3, Math.min(1, Math.sqrt(level)) * height);
    const lit = voice.phase === 'listening' || i < done * bars.length || Math.abs(i - sweep) < bars.length * 0.08;
    ctx.fillStyle = lit ? accent : quiet;
    ctx.globalAlpha = lit ? 1 : 0.35;
    ctx.fillRect(i * step, (height - barHeight) / 2, 3, barHeight);
  });
  ctx.globalAlpha = 1;
  if (voice.phase !== 'idle') voice.frame = requestAnimationFrame(drawWave);
}

function showVoice(phase, status, { bad = false, retry = null, retryLabel = '' } = {}) {
  const firstShow = voice.phase === 'idle';
  voice.phase = phase;
  voice.retry = retry;
  $('composer').classList.add('voice-on');
  $('voice-panel').hidden = false;
  $('voice-status').textContent = status;
  $('voice-status').classList.toggle('bad', bad);
  $('voice-done').hidden = phase !== 'listening';
  $('voice-done').textContent = state.mode === 'chat' ? 'Stop and ask' : 'Stop and write';
  $('voice-retry').hidden = !retry;
  if (phase !== 'listening') $('voice-mic').hidden = true;
  $('voice-retry').textContent = retryLabel;
  disarmCancel();
  $('voice-cancel').textContent = phase === 'failed' ? 'Discard' : 'Cancel';
  if (firstShow) voice.frame = requestAnimationFrame(drawWave);
}

function closeVoice() {
  clearInterval(voice.timer);
  cancelAnimationFrame(voice.frame);
  Object.assign(voice, { phase: 'idle', recording: null, bars: [], peak: 0, seconds: 0, pieces: [], texts: [], controller: null, retry: null });
  disarmCancel();
  $('composer').classList.remove('voice-on');
  $('voice-panel').hidden = true;
  $('voice-time').textContent = '0:00';
}

const LISTENING = 'Listening. Take your time, pauses are fine. Nothing is sent until you stop.';
// A local model doesn't make voice local, so this says so before anything is sent.
const listeningText = () => (isLocalId(currentModel()) && state.transcriber ? `${LISTENING} Your voice then goes to ${state.transcriber} to be written down.` : LISTENING);
const SOUND_FLOOR = 0.0001;
const DEAD_MIC_MS = 2500;
let cleanMicName = (label) => label;
const micName = () => cleanMicName(voice.recording?.label() || 'this microphone');

async function showMicrophones() {
  const select = $('voice-mic');
  const { list, nameOf } = await listMicrophones();
  cleanMicName = nameOf;
  select.replaceChildren(...list.map(({ id, name }) => {
    const option = el('option', '', name);
    option.value = id;
    return option;
  }));
  const current = list.find((m) => m.name === micName());
  if (current) select.value = current.id;
  select.hidden = list.length < 2 || voice.phase !== 'listening';
}

async function beginVoice() {
  stopReading();
  note();
  voice.bars = [];
  voice.seconds = 0;
  showVoice('starting', 'Waiting for the microphone. Allow it if your browser asks.');
  $('voice-time').textContent = '0:00';
  voice.heard = false;
  voice.silent = false;
  const attempt = {};
  voice.attempt = attempt;
  try {
    const recording = await startRecording({
      deviceId: store.get('micId', 'default'),
      onLevel(level) {
        if (level > SOUND_FLOOR) { voice.heard = true; voice.lastSound = performance.now(); }
        voice.peak = Math.max(voice.peak, level);
        const now = performance.now();
        if (now - voice.lastBar >= 60) {
          voice.bars.push(voice.peak);
          voice.peak = 0;
          voice.lastBar = now;
        }
      },
      onEnded() { if (voice.phase === 'listening') finishVoice('The microphone disconnected, so this is what was recorded.'); },
    });
    if (voice.attempt !== attempt) return recording.cancel(); // Cancelled while the permission prompt was open.
    voice.recording = recording;
    voice.lastSound = performance.now();
    showVoice('listening', listeningText());
    await showMicrophones();
    $('voice-done').focus();
    const tick = () => {
      touch();
      voice.seconds = recording.seconds();
      $('voice-time').textContent = clock(voice.seconds);
      // A silent room still has faint noise. Nothing at all means this microphone is not delivering sound.
      const silent = voice.phase === 'listening' && performance.now() - voice.lastSound > DEAD_MIC_MS;
      if (silent !== voice.silent && voice.phase === 'listening') {
        voice.silent = silent;
        const name = micName();
        $('voice-status').textContent = silent ? `No sound is coming from ${name}. Check it, or choose another microphone.` : listeningText();
        $('voice-status').classList.toggle('bad', silent);
      }
      if (voice.seconds >= MAX_SECONDS) finishVoice('This recording reached the one hour limit.');
    };
    voice.timer = setInterval(tick, 250);
  } catch (err) {
    if (voice.attempt === attempt) showVoice('failed', micError(err), { bad: true, retry: beginVoice, retryLabel: 'Try again' });
  }
  return undefined;
}

function finishVoice(reason = '') {
  if (voice.phase !== 'listening') return;
  clearInterval(voice.timer);
  const { samples, seconds } = voice.recording.finish();
  voice.recording = null;
  voice.seconds = seconds;
  $('voice-time').textContent = clock(seconds);
  if (seconds < 0.4) {
    showVoice('failed', 'That was too short to write down.', { retry: beginVoice, retryLabel: 'Record again' });
    return;
  }
  // Pure silence is not sent, so a dead microphone costs nothing.
  if (!voice.heard) {
    showVoice('failed', 'No sound reached the app, so nothing was sent. Check your microphone and record again.', { bad: true, retry: beginVoice, retryLabel: 'Record again' });
    return;
  }
  voice.pieces = splitSamples(samples);
  voice.texts = [];
  voice.note = reason;
  transcribeVoice();
}

// Finished parts are kept, so a retry only pays for what has not been written down yet.
async function transcribeVoice() {
  const controller = new AbortController();
  voice.controller = controller;
  try {
    while (voice.texts.length < voice.pieces.length) {
      const part = voice.texts.length + 1;
      const of = voice.pieces.length;
      showVoice('writing', `${voice.note ? `${voice.note} ` : ''}Writing down what you said${of > 1 ? `, part ${part} of ${of}` : ''}.`);
      const { text } = await apiJson('/api/transcribe', {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavBlob(voice.pieces[part - 1]), signal: controller.signal,
      });
      voice.texts.push(text);
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    showVoice('failed', `Your recording is safe, but it could not be written down. ${err.message}`, { bad: true, retry: transcribeVoice, retryLabel: 'Try again' });
    return;
  }
  const text = voice.texts.filter(Boolean).join(' ').trim();
  if (!text) {
    showVoice('failed', 'No speech was heard. Check your microphone and try again.', { retry: beginVoice, retryLabel: 'Record again' });
    return;
  }
  closeVoice();
  const input = $('input');
  input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
  autoGrow();
  input.focus();
  // Speaking asks the question. Image and Video wait for a press, because they cost more.
  if (state.mode === 'chat' && !state.busy) {
    state.speakNext = state.readBack;
    submit();
  }
}

function disarmCancel() {
  clearTimeout(voice.armTimer);
  $('voice-cancel').classList.remove('armed');
  if (voice.phase !== 'idle') $('voice-cancel').textContent = voice.phase === 'failed' ? 'Discard' : 'Cancel';
}

// A slip should not lose a long recording, so anything over 10 seconds asks twice.
function cancelVoice() {
  const button = $('voice-cancel');
  if (voice.phase === 'idle') return;
  const hasWork = voice.phase !== 'starting' && voice.seconds > 10;
  if (hasWork && !button.classList.contains('armed')) {
    button.classList.add('armed');
    button.textContent = 'Press again to discard';
    voice.armTimer = setTimeout(disarmCancel, 3000);
    return;
  }
  voice.attempt = null;
  voice.controller?.abort();
  voice.recording?.cancel();
  closeVoice();
  $('input').focus();
}

function readLabel(id) {
  if (state.reading?.id !== id) return 'Read aloud';
  return state.reading.playing ? 'Stop reading' : 'Preparing audio';
}

function updateReadButtons() {
  for (const button of document.querySelectorAll('[data-read]')) button.textContent = readLabel(button.dataset.read);
}

function stopReading() {
  const reading = state.reading;
  if (!reading) return;
  state.reading = null;
  reading.controller.abort();
  reading.audio?.pause();
  if (reading.onDevice) speechSynthesis.cancel();
  reading.finished?.();
  updateReadButtons();
}

// Uses only voices installed on this computer. Some browser voices stream from the cloud.
async function deviceVoice() {
  let voices = speechSynthesis.getVoices();
  if (!voices.length) {
    await new Promise((resolve) => {
      speechSynthesis.addEventListener('voiceschanged', resolve, { once: true });
      setTimeout(resolve, 1000);
    });
    voices = speechSynthesis.getVoices();
  }
  const own = voices.filter((v) => v.localService);
  const language = navigator.language.split('-')[0];
  return own.find((v) => v.lang === navigator.language) || own.find((v) => v.lang.startsWith(language)) || null;
}

async function readOnDevice(reading, pieces) {
  const chosen = await deviceVoice();
  if (!chosen) throw new Error('This computer has no voice for your language, so nothing was read. Add one in System Settings.');
  for (const text of pieces) {
    if (state.reading !== reading) return;
    await new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = chosen;
      reading.finished = resolve;
      utterance.onstart = () => { reading.playing = true; updateReadButtons(); };
      utterance.onend = resolve;
      utterance.onerror = (e) => (e.error === 'canceled' || e.error === 'interrupted' ? resolve() : reject(new Error('This computer could not read the answer aloud.')));
      speechSynthesis.speak(utterance);
    });
  }
}

async function readAloud(message) {
  const same = state.reading?.id === message.id;
  stopReading();
  if (same) return;
  const answer = holderFor(message)?.querySelector('.answer');
  const onDevice = state.private || isLocalId(message.model);
  // Some voices take only short pieces, such as Groq's at 200 characters.
  const limit = onDevice ? 280 : Math.min(1200, state.voices?.limit || 1200);
  const pieces = answer ? splitForSpeech(speechText(answer), limit) : [];
  if (!pieces.length) return note('This answer has no text to read.');
  note();
  const reading = { id: message.id, controller: new AbortController(), playing: false, onDevice };
  state.reading = reading;
  updateReadButtons();
  try {
    if (onDevice) {
      await readOnDevice(reading, pieces);
      if (state.reading === reading) { state.reading = null; updateReadButtons(); }
      return undefined;
    }
    for (const text of pieces) {
      const res = await api('/api/speak', { json: { text, voice: state.voice }, signal: reading.controller.signal });
      const url = URL.createObjectURL(await res.blob());
      if (state.reading !== reading) { URL.revokeObjectURL(url); return undefined; }
      const audio = new Audio(url);
      reading.audio = audio;
      await new Promise((resolve, reject) => {
        reading.finished = resolve;
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('This browser could not play the audio.'));
        audio.play().then(() => { reading.playing = true; updateReadButtons(); }, reject);
      }).finally(() => URL.revokeObjectURL(url));
      if (state.reading !== reading) return undefined;
    }
  } catch (err) {
    if (state.reading === reading) {
      note(err.name === 'NotAllowedError' ? 'The browser blocked audio. Press Read aloud to play it.' : err.message, true);
    }
  }
  if (state.reading === reading) {
    state.reading = null;
    updateReadButtons();
  }
  return undefined;
}

/* ---------- model picker ---------- */

function modelSubline(m) {
  if (m.local) return ['Runs on this computer', m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '', m.seesImages ? 'sees images' : ''].filter(Boolean).join(', ');
  if (m.kind === 'image') return m.imagePrice ? `${m.provider}, about ${formatUsd(m.imagePrice)} per image` : m.provider;
  if (m.kind === 'video') {
    const cheapest = Math.min(...m.videoPrices.map((p) => Number(p.usd_per_second)));
    return `${m.provider}, from ${formatUsd(cheapest)} per second`;
  }
  const bits = [m.provider];
  if (m.input || m.output) bits.push(`$${Number((m.input * 1e6).toPrecision(3))} in, $${Number((m.output * 1e6).toPrecision(3))} out per million tokens`);
  if (m.seesImages) bits.push('sees images');
  if (m.canSearch) bits.push('can search');
  return bits.join(', ');
}

function renderModelList() {
  const query = $('model-search').value.trim().toLowerCase();
  const selected = currentModel();
  const matching = state.models
    .filter((m) => allowed(state.mode, m))
    .filter((m) => !query || `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(query));
  const rowsFor = (list) => list
    .map((m) => {
      const b = el('button', 'model-row');
      b.append(el('span', 'model-name', m.name), el('span', 'model-sub', modelSubline(m)));
      if (m.id === selected) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => {
        state.picked[state.mode] = m.id;
        store.set('picked', state.picked);
        $('model-dialog').close();
        renderComposer();
        $('input').focus();
      });
      return b;
    });
  const local = matching.filter((m) => m.local);
  const cloud = matching.filter((m) => !m.local);
  const rows = [];
  if (state.mode === 'image' && imageVia()) rows.push(el('div', 'model-note', `Showing ${providerById(imageVia()).name} only. Change this in Settings, under Make images with.`));
  if (local.length) rows.push(el('div', 'model-group', 'On this computer'), ...rowsFor(local));
  // One group per provider, Infero first.
  for (const p of PROVIDERS) {
    const group = cloud.filter((m) => m.via === p.id);
    if (group.length) rows.push(el('div', 'model-group', p.custom ? `Through ${viaName('custom:')}` : `In the cloud, through ${p.name}`), ...rowsFor(group));
  }
  // A search that finds nothing may be a local model you could download, so that is offered.
  const typed = $('model-search').value.trim();
  const suggestion = state.mode === 'chat' && typed && !matching.length && OLLAMA_NAME.test(typed) && !/(^|[-:])cloud$/i.test(typed) ? typed : '';
  const empty = suggestion && state.ollama ? `No models match “${suggestion}”. You can download it below to run on this computer.`
    : state.private ? 'No models on this computer yet.'
      : state.models.length ? 'No models match that search.'
      : state.hasKey ? 'The model list could not be loaded. Check your connection and reopen this.'
        : 'Add an Infero key in Settings to see cloud models.';
  $('model-list').replaceChildren(...(rows.length ? rows : [el('div', 'model-empty', empty)]));
  renderLocalSetup(suggestion);
}

// Ollama model names, as the server accepts them.
const OLLAMA_NAME = /^[a-z0-9][\w./-]*(:[\w.-]+)?$/i;
// The download box stays tucked away until you open it, search for a model you don't have, or a download runs.
const localSetup = { open: false, typed: false, value: '' };

function renderLocalSetup(suggestion = '') {
  const box = $('local-setup');
  if (state.mode !== 'chat') return box.replaceChildren();
  const hasLocal = state.models.some((m) => m.local);
  const open = localSetup.open || Boolean(suggestion) || Boolean(state.pull?.text) || (state.private && !hasLocal);
  box.classList.toggle('collapsed', !open);
  if (!open) {
    const toggle = el('button', 'quiet', state.ollama ? 'Download a local model' : 'Run models on this computer');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      localSetup.open = true;
      renderLocalSetup();
      $('pull-name')?.focus();
    });
    return box.replaceChildren(toggle);
  }
  if (!state.ollama) {
    const text = el('p', '', `${suggestion ? `To download “${suggestion}”, first install Ollama` : 'To get answers that stay on this computer, install Ollama'}, open it, then check again. `);
    const link = el('a', '', 'Get Ollama');
    link.href = 'https://ollama.com/download';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    text.append(link);
    const again = el('button', 'quiet', 'Check again');
    again.type = 'button';
    again.addEventListener('click', async () => { again.textContent = 'Checking'; await loadModels(); renderModelList(); });
    return box.replaceChildren(text, again);
  }
  const form = el('form', 'pull-row');
  const input = el('input');
  input.id = 'pull-name';
  input.setAttribute('aria-label', 'Model to download');
  // Your search fills the box, unless you have typed a name into it yourself.
  input.value = state.pull?.active ? state.pull.name
    : suggestion && !localSetup.typed ? suggestion
      : localSetup.value || state.pull?.name || SUGGESTED_LOCAL;
  input.spellcheck = false;
  input.addEventListener('input', () => { localSetup.typed = true; localSetup.value = input.value; });
  const go = el('button', 'solid', state.pull?.active ? 'Downloading' : 'Download');
  go.disabled = Boolean(state.pull?.active);
  form.append(input, go);
  form.addEventListener('submit', (e) => { e.preventDefault(); pullLocal(input.value.trim()); });
  const intro = el('p', '', suggestion && !localSetup.typed
    ? `“${suggestion}” is not on this computer. Download it from the Ollama library to answer here, with nothing sent anywhere.`
    : hasLocal ? 'Add another model from the Ollama library.' : `Download a model to answer on this computer. ${SUGGESTED_LOCAL} is about 3.3 GB and can see images.`);
  const status = el('p', state.pull?.bad ? 'bad' : '', state.pull?.text || '');
  status.id = 'pull-status';
  box.replaceChildren(intro, form, ...(state.pull?.text ? [status] : []));
  return undefined;
}

async function pullLocal(name) {
  if (!name || state.pull?.active) return;
  state.pull = { name, active: true, text: 'Starting the download' };
  renderLocalSetup();
  const show = (text, bad = false) => {
    Object.assign(state.pull, { text, bad });
    const line = document.getElementById('pull-status');
    if (line) line.textContent = text;
  };
  try {
    const res = await api('/api/local/pull', { json: { name } });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const update = JSON.parse(line);
        if (update.error) throw new Error(update.error);
        if (update.total && update.completed !== undefined) show(`Downloading, ${Math.floor((update.completed / update.total) * 100)}% of ${(update.total / 1e9).toFixed(1)} GB`);
        else if (update.status) show(update.status[0].toUpperCase() + update.status.slice(1));
      }
    }
    await loadModels();
    state.pull = { name, active: false, text: `${name} is ready.` };
    const installed = state.models.find((m) => m.local && (m.name === name || m.name === `${name}:latest`));
    if (installed) { state.picked.chat = installed.id; store.set('picked', state.picked); }
    renderComposer();
  } catch (err) {
    state.pull = { name, active: false, bad: true, text: err.message };
  }
  if ($('model-dialog').open) renderModelList();
}

async function loadModels() {
  try {
    const { models, ollama } = await apiJson('/api/models');
    state.models = models;
    state.ollama = ollama;
    return true;
  } catch (err) {
    state.models = [];
    if (err.status !== 423) note('The model list could not be loaded. Check your connection.', true);
    return false;
  }
}

function openModelPicker() {
  $('model-search').value = '';
  Object.assign(localSetup, { open: false, typed: false, value: '' });
  if (state.pull && !state.pull.active) state.pull = null; // An old download message is not shown again.
  renderModelList();
  if (!$('model-dialog').open) $('model-dialog').showModal();
  $('model-search').focus();
}

/* ---------- settings ---------- */

// Older versions stored only the amount, which was always MiniRouter's.
function showBalance(value, via = 'minirouter') {
  const name = providerById(via)?.name;
  $('balance').textContent = `${formatUsd(Number(value))} left${name ? ` on ${name}` : ''}`;
  store.set('balance', { value, via });
}

const KEY_ROLES = {
  infero: 'Infero key, the main provider',
  minirouter: 'MiniRouter key, for web search and video',
  openrouter: 'OpenRouter key, optional',
};
const keyLabel = (p) => KEY_ROLES[p.id] || `${p.name} key, ${p.role.toLowerCase()}`;

function applyKeys({ keys = {}, voices = null, transcriber = null, custom = null, speakVia = 'auto', speakOptions = [], transcribeVia = 'auto', transcribeOptions = [], searchVia = 'auto', searchOptions = [], imageVia = 'auto', imageOptions = [] }) {
  Object.assign(state, { speakVia, speakOptions, transcribeVia, transcribeOptions, searchVia, searchOptions, imageVia, imageOptions });
  state.keys = keys;
  state.hasKey = Object.values(keys).some(Boolean);
  state.voices = voices;
  state.transcriber = transcriber;
  state.custom = custom;
  renderVoices();
}

// After a provider is added, the model list and composer are refreshed to include it.
async function afterKeyChange(text) {
  renderKeyState();
  await loadModels();
  renderComposer();
  note(text);
}

function savedNote(noteEl, p) {
  if (state.keys[p.id]) {
    noteEl.textContent = 'Saved in this app’s .env file, readable only by your user account.';
    return;
  }
  const link = el('a', '', `Get a key from ${p.name}`);
  link.href = p.keyUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  noteEl.append(link, '. It is saved only on this computer.');
}

function field(id, labelText, { type = 'text', placeholder = '', value = '' } = {}) {
  const input = el('input');
  Object.assign(input, { id, type, placeholder, value, autocomplete: 'off', spellcheck: false });
  const label = el('label', '', labelText);
  label.htmlFor = id;
  return { label, input };
}

function keyForm(p) {
  const form = el('form', 'key-form');
  const { label, input } = field(`key-${p.id}`, `${state.keys[p.id] ? 'Replace ' : ''}${keyLabel(p)}`, { type: 'password', placeholder: p.placeholder });
  const row = el('div', 'key-row');
  const save = el('button', 'solid', 'Save key');
  save.type = 'submit';
  row.append(input, save);
  const noteEl = el('p', 'key-note');
  savedNote(noteEl, p);
  form.append(label, row, noteEl);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      applyKeys(await apiJson('/api/key', { method: 'PUT', json: { provider: p.id, key: input.value } }));
      await afterKeyChange(`${p.name} key saved.`);
    } catch (err) {
      noteEl.textContent = err.message;
      noteEl.classList.add('bad');
    }
  });
  return form;
}

// Any OpenAI-compatible server: its address, a name to show, and a key if it needs one.
function customForm() {
  const saved = state.custom;
  const form = el('form', 'key-form');
  const base = field('custom-base', 'Custom endpoint address', { placeholder: 'https://llm.example.com/v1', value: saved?.base || '' });
  const name = field('custom-name', 'Name to show', { placeholder: 'My server', value: saved?.name === 'Custom endpoint' ? '' : saved?.name || '' });
  const key = field('custom-key', saved?.hasKey ? 'Replace key (leave empty to keep it)' : 'Key, if it needs one', { type: 'password' });
  const row = el('div', 'key-row');
  const save = el('button', 'solid', 'Save endpoint');
  save.type = 'submit';
  row.append(save);
  if (saved) {
    const remove = el('button', 'quiet', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      applyKeys(await apiJson('/api/custom', { method: 'PUT', json: { base: '' } }));
      await afterKeyChange('The custom endpoint was removed.');
    });
    row.append(remove);
  }
  const noteEl = el('p', 'key-note', saved
    ? 'Saved in this app’s .env file. Your chats go to this address when you choose one of its models.'
    : 'Its models appear in the model picker. Your chats go to this address when you choose one of them.');
  form.append(base.label, base.input, name.label, name.input, key.label, key.input, row, noteEl);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      applyKeys(await apiJson('/api/custom', { method: 'PUT', json: { base: base.input.value, name: name.input.value, key: key.input.value } }));
      await afterKeyChange(base.input.value ? 'Custom endpoint saved.' : 'The custom endpoint was removed.');
    } catch (err) {
      noteEl.textContent = err.message;
      noteEl.classList.add('bad');
    }
  });
  return form;
}

function renderKeyState() {
  const main = PROVIDERS.filter((p) => !p.more).map(keyForm);
  const more = el('details', 'more-providers');
  const added = PROVIDERS.filter((p) => p.more && state.keys[p.id]).length;
  more.append(el('summary', '', `More providers${added ? `, ${added} added` : ''}`));
  for (const p of PROVIDERS.filter((x) => x.more)) more.append(p.custom ? customForm() : keyForm(p));
  if (added) more.open = true;
  $('keys').replaceChildren(...main, more);
}

// The voice list belongs to whichever provider reads answers aloud.
// Each provider remembers its own voice, so switching readers keeps your choice for each.
const voiceFor = store.get('voiceBy', {});

// A menu of the providers you have a key for that can do one voice job.
function renderChooser(select, options, chosen, inUse, emptyText) {
  const automatic = el('option', '', options.length ? `Automatic${chosen === 'auto' && inUse ? `, now ${inUse}` : ''}` : emptyText);
  automatic.value = 'auto';
  select.replaceChildren(automatic, ...options.map((p) => {
    const option = el('option', '', p.name);
    option.value = p.id;
    return option;
  }));
  // A chosen provider whose key was removed is shown as Automatic, which is what the server uses.
  select.value = options.some((p) => p.id === chosen) ? chosen : 'auto';
  select.disabled = !options.length;
}

function renderVoices() {
  const searcher = routeFor('infero:x', true, { keys: state.keys, searchVia: state.searchVia }).handedOff;
  renderChooser($('image-via'), state.imageOptions || [], state.imageVia, null, 'Add a key for a provider that makes images');
  renderChooser($('search-via'), state.searchOptions || [], state.searchVia, providerById(searcher)?.name, 'Add a MiniRouter or OpenRouter key to search');
  renderChooser($('transcribe-via'), state.transcribeOptions || [], state.transcribeVia, state.transcriber, 'Add a key to ask by voice');
  renderChooser($('speak-via'), state.speakOptions || [], state.speakVia, state.voices?.name, 'Add a key to read answers aloud');

  const select = $('voice');
  const list = state.voices?.list || [];
  select.replaceChildren(...list.map((v) => {
    const option = el('option', '', v.name);
    option.value = v.id;
    return option;
  }));
  const wanted = voiceFor[state.voices?.via] || state.voice;
  state.voice = list.some((v) => v.id === wanted) ? wanted : list[0]?.id || state.voice;
  select.value = state.voice;
  select.disabled = !list.length;
  $('voice-label').textContent = state.voices ? `Voice for reading answers, from ${state.voices.name}` : 'Voice for reading answers';
}

function applyTheme(value) {
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  try {
    if (value === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', value);
  } catch { /* optional */ }
  renderThread();
}

/* ---------- privacy ---------- */

function renderPrivate() {
  $('private-toggle').setAttribute('aria-checked', String(state.private));
  $('temp-chat').hidden = state.private;
}

async function setPrivate(on) {
  if (state.busy) stop();
  stopReading();
  // Files held for a Private mode chat end with it, so leaving starts afresh.
  const endsChat = !on && state.private;
  if (endsChat) { discardTemporary(); state.attachments = []; renderAttachments(); }
  await apiJson('/api/settings', { method: 'PUT', json: { privateMode: on } });
  state.private = on;
  // This also stops anything said in Private mode being saved into an older chat later.
  if (endsChat) { state.chat = null; state.temporary = false; }
  renderPrivate();
  if (on) $('balance').textContent = '';
  await loadModels();
  renderComposer();
  if (!state.chat) renderThread();
  renderChatList();
  note(on ? 'Private mode is on. Nothing leaves this computer, and nothing new is saved.' : '');
  $('input').focus();
}

// The lock screen also serves the first run, when the passphrase is chosen.
function renderLockScreen() {
  const setup = state.vault === 'setup';
  $('lock-title').textContent = setup ? 'Choose a passcode.' : 'Locked.';
  $('setup-fields').hidden = !setup;
  $('setup-more').hidden = !setup;
  $('lock-label').textContent = setup ? 'Passcode, 4 numbers' : 'Passcode';
  $('lock-input').autocomplete = setup ? 'new-password' : 'current-password';
  // A new passcode is 4 numbers. Unlocking accepts anything, so a longer passphrase
  // chosen with an earlier version still works until it is changed in Settings.
  if (setup) { $('lock-input').maxLength = 4; $('lock-input').inputMode = 'numeric'; } else { $('lock-input').removeAttribute('maxlength'); $('lock-input').removeAttribute('inputmode'); }
  $('lock-submit').textContent = setup ? 'Set passcode' : 'Unlock';
}

function showLock(vault = 'locked') {
  if (state.locked) return;
  state.locked = true;
  state.vault = vault;
  renderLockScreen();
  if (state.busy) stop();
  stopReading();
  if (voice.phase !== 'idle') { voice.attempt = null; voice.controller?.abort(); voice.recording?.cancel(); closeVoice(); }
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  // Nothing private stays on the page behind the lock.
  state.chat = null;
  state.chats = [];
  state.attachments = [];
  state.temporary = false;
  $('input').value = '';
  $('thread').replaceChildren();
  $('chat-list').replaceChildren();
  $('clear-chats').hidden = true;
  $('attachments').replaceChildren();
  $('lock-note').textContent = '';
  $('lock').hidden = false;
  for (const id of ['lock-input', 'setup-code', 'setup-repeat']) $(id).value = '';
  $('setup-understand').checked = false;
  (vault === 'setup' ? $('setup-code') : $('lock-input')).focus();
}

let lastTouch = 0;
function touch() {
  if (state.vault !== 'open' || Date.now() - lastTouch < 60000) return;
  lastTouch = Date.now();
  fetch('/api/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
}

function renderRetention() {
  $('retention').value = String(state.retentionDays);
  $('retention-note').hidden = true;
  $('retention-confirm').hidden = true;
}

async function saveRetention(days) {
  await apiJson('/api/settings', { method: 'PUT', json: { retentionDays: days } });
  state.retentionDays = days;
  state.chats = (await apiJson('/api/chats')).chats;
  if (state.chat && !state.chat.temporary && !state.chats.some((c) => c.id === state.chat.id)) startNew();
  renderChatList();
  renderRetention();
}

/* ---------- events ---------- */

$('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
$('input').addEventListener('input', autoGrow);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.busy) submit();
  }
});
$('input').addEventListener('paste', (e) => {
  const files = [...e.clipboardData.files];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
for (const b of document.querySelectorAll('.modes button')) b.addEventListener('click', () => setMode(b.dataset.mode));
$('mic').addEventListener('click', beginVoice);
$('voice-mic').addEventListener('change', async () => {
  const id = $('voice-mic').value;
  store.set('micId', id);
  voice.lastSound = performance.now();
  try {
    await voice.recording?.useMicrophone(id);
  } catch (err) {
    $('voice-status').textContent = micError(err);
    $('voice-status').classList.add('bad');
  }
});
$('voice-done').addEventListener('click', () => finishVoice());
$('voice-cancel').addEventListener('click', cancelVoice);
$('voice-retry').addEventListener('click', () => voice.retry?.());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && voice.phase !== 'idle' && !document.querySelector('dialog[open]')) cancelVoice(); });
window.addEventListener('beforeunload', (e) => { if (voice.phase === 'listening' || voice.phase === 'writing') e.preventDefault(); });
$('voice').addEventListener('change', () => {
  state.voice = $('voice').value;
  store.set('voice', state.voice);
  if (state.voices) { voiceFor[state.voices.via] = state.voice; store.set('voiceBy', voiceFor); }
});
for (const [id, setting] of [['speak-via', 'speakVia'], ['transcribe-via', 'transcribeVia'], ['search-via', 'searchVia'], ['image-via', 'imageVia']]) {
  $(id).addEventListener('change', async () => {
    if (setting === 'speakVia') stopReading();
    try {
      await apiJson('/api/settings', { method: 'PUT', json: { [setting]: $(id).value } });
      applyKeys(await apiJson('/api/status'));
      // The line under the message box, or the image model, may change.
      if (setting === 'searchVia' || setting === 'imageVia') renderComposer();
    } catch (err) {
      note(err.message, true);
      renderVoices();
    }
  });
}
$('read-back').addEventListener('change', () => { state.readBack = $('read-back').checked; store.set('readBack', state.readBack); });
$('attach').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => { addFiles([...$('file').files]); $('file').value = ''; });
$('web').addEventListener('click', () => { state.web = !state.web; store.set('web', state.web); renderComposer(); });
$('video-seconds').addEventListener('change', updateEstimate);
$('video-size').addEventListener('change', updateEstimate);
$('model').addEventListener('click', openModelPicker);
$('model-search').addEventListener('input', renderModelList);
$('open-guide').addEventListener('click', openGuide);

/* ---------- terms, privacy and license ---------- */

// These are the repository's own files, served as they are, so the app never disagrees with them.
async function openLegal(name) {
  const body = $('legal-body');
  for (const tab of document.querySelectorAll('[data-legal-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.legalTab === name));
  body.replaceChildren(el('p', 'status', 'Loading'));
  if (!$('legal').open) $('legal').showModal();
  try {
    const res = await fetch(`/legal/${name}`);
    if (!res.ok) throw new Error();
    const text = await res.text();
    if (name === 'license') body.replaceChildren(el('pre', 'legal-license', text));
    else renderMarkdown(body, text);
  } catch {
    body.replaceChildren(el('p', '', 'This document could not be loaded. It is also in the app folder as TERMS.md, PRIVACY.md and LICENSE.'));
  }
  $('legal').scrollTop = 0;
}
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-legal], [data-legal-tab]');
  if (link) openLegal(link.dataset.legal || link.dataset.legalTab);
});
$('guide-close').addEventListener('click', () => $('guide').close());
$('guide-settings').addEventListener('click', () => $('guide').close());
$('guide').addEventListener('close', () => {
  store.set('guideSeen', true);
  // Nothing in the cloud works without a key, so closing the guide leads on to adding one.
  if (!state.hasKey && !state.private && !state.locked) openKeySettings();
});
for (const dialog of [$('model-dialog'), $('settings-dialog'), $('guide'), $('legal')]) {
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
}
$('new-chat').addEventListener('click', () => startNew());
$('temp-chat').addEventListener('click', () => startNew(true));
// The switch waits for the server, so a second press can't race the first.
$('private-toggle').addEventListener('click', async () => {
  const button = $('private-toggle');
  if (button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  try {
    await setPrivate(!state.private);
  } catch (err) {
    note(err.message, true);
  }
  button.removeAttribute('aria-busy');
});
window.addEventListener('pagehide', discardTemporary);
for (const type of ['keydown', 'pointerdown']) document.addEventListener(type, touch, { passive: true });
$('lock-now').addEventListener('click', async () => {
  showLock();
  await fetch('/api/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
});
$('lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const setup = state.vault === 'setup';
  const passphrase = $('lock-input').value;
  const fail = (text) => { $('lock-note').textContent = text; };
  if (setup && !/^[0-9]{4}$/.test(passphrase)) return fail('Use exactly 4 numbers.');
  if (setup && passphrase !== $('setup-repeat').value) return fail('The two passcodes don\u2019t match.');
  if (setup && !$('setup-understand').checked) return fail('Tick the box to confirm you understand.');
  $('lock-submit').disabled = true;
  $('lock-submit').textContent = setup ? 'Encrypting your chats and files' : 'Unlocking';
  try {
    if (setup) await apiJson('/api/vault/enable', { json: { passphrase, code: $('setup-code').value } });
    else await apiJson('/api/unlock', { json: { passphrase } });
    for (const id of ['lock-input', 'setup-code', 'setup-repeat']) $(id).value = '';
    $('lock').hidden = true;
    state.locked = false;
    state.vault = 'open';
    await loadApp();
  } catch (err) {
    fail(err.message);
    // Another tab may have chosen the passphrase meanwhile, so check which screen applies.
    if (err.status === 409) state.vault = (await apiJson('/api/status').catch(() => null))?.vault || state.vault;
  }
  $('lock-submit').disabled = false;
  renderLockScreen();
  return undefined;
});
$('vault-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const noteEl = $('vault-note');
  const say = (text, bad = false) => { noteEl.textContent = text; noteEl.classList.toggle('bad', bad); };
  const next = $('vault-next').value;
  if (!/^[0-9]{4}$/.test(next)) return say('Use exactly 4 numbers.', true);
  if (next !== $('vault-repeat').value) return say('The two new passcodes don\u2019t match.', true);
  $('vault-submit').disabled = true;
  try {
    await apiJson('/api/vault/passphrase', { method: 'PUT', json: { current: $('vault-pass').value, next } });
    for (const id of ['vault-pass', 'vault-next', 'vault-repeat']) $(id).value = '';
    say('Your passcode was changed. Other browsers were signed out.');
  } catch (err) {
    say(err.message, true);
  }
  $('vault-submit').disabled = false;
  return undefined;
});
$('auto-lock').addEventListener('change', () => apiJson('/api/settings', { method: 'PUT', json: { autoLockMinutes: Number($('auto-lock').value) } }).catch((err) => { $('vault-note').textContent = err.message; }));
$('mask-details').addEventListener('change', () => { state.mask = $('mask-details').checked; store.set('mask', state.mask); });
// Choosing a period can delete chats straight away, so that is confirmed first.
$('retention').addEventListener('change', () => {
  const days = Number($('retention').value);
  const cutoff = Date.now() - days * 864e5;
  const count = days ? state.chats.filter((c) => c.updatedAt < cutoff).length : 0;
  if (!count) { saveRetention(days).catch((err) => { $('retention-note').textContent = err.message; $('retention-note').hidden = false; }); return; }
  $('retention-note').textContent = `${count} older ${count === 1 ? 'chat' : 'chats'} and their files will be deleted now.`;
  $('retention-note').hidden = false;
  const confirm = $('retention-confirm');
  confirm.textContent = `Delete ${count} and turn on`;
  confirm.hidden = false;
  confirm.onclick = () => saveRetention(days).catch((err) => { $('retention-note').textContent = err.message; });
});
$('settings-dialog').addEventListener('close', renderRetention);
// Deleting every chat can't be undone, so each button asks to be pressed twice.
function wipeButton(button, idle, armedText, doneText) {
  let timer;
  const reset = () => { clearTimeout(timer); button.classList.remove('armed'); button.textContent = idle(); };
  button.addEventListener('click', async () => {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = armedText();
      timer = setTimeout(reset, 4000);
      return;
    }
    reset();
    if (state.busy) stop();
    stopReading();
    try {
      await apiJson('/api/wipe', { json: { confirm: 'DELETE' } });
    } catch (err) {
      note(`Nothing was deleted: ${err.message}`, true);
      return;
    }
    state.chats = [];
    state.chat = null;
    state.temporary = false;
    state.attachments = [];
    renderAttachments();
    renderThread();
    renderChatList();
    if (doneText) button.textContent = doneText;
    note('All chats and their files were deleted.');
  });
}
const chatCount = () => `${state.chats.length} ${state.chats.length === 1 ? 'chat' : 'chats'}`;
wipeButton($('wipe'), () => 'Delete all chats and files', () => 'Press again to delete everything', 'Everything was deleted');
wipeButton($('clear-chats'), () => 'Delete all chats', () => `Press again to delete ${chatCount()}`);
$('chat-filter').addEventListener('input', renderChatList);
$('toggle-sidebar').addEventListener('click', () => setSidebar(document.body.classList.contains('side-closed')));
$('scrim').addEventListener('click', () => setSidebar(false));
$('open-settings').addEventListener('click', () => { renderKeyState(); $('settings-dialog').showModal(); });
$('theme').addEventListener('change', () => applyTheme($('theme').value));
$('thread').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-copy-code]');
  if (!button) return;
  await navigator.clipboard.writeText(button.closest('.code').querySelector('code').textContent);
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, 1200);
});
const composer = $('composer');
for (const type of ['dragover', 'dragenter']) {
  document.addEventListener(type, (e) => { e.preventDefault(); composer.classList.add('dropping'); });
}
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) composer.classList.remove('dropping'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  composer.classList.remove('dropping');
  if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
});
matchMedia('(max-width: 760px)').addEventListener('change', (e) => setSidebar(!e.matches && store.get('sidebar', true)));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderThread());

/* ---------- start ---------- */

(async function start() {
  setSidebar(!isNarrow() && store.get('sidebar', true));
  try {
    $('theme').value = localStorage.getItem('theme') || 'system';
  } catch { /* optional */ }
  $('voice').value = state.voice;
  $('read-back').checked = state.readBack;
  $('mask-details').checked = state.mask;
  const balance = store.get('balance', null);
  if (balance?.value) showBalance(balance.value, balance.via);
  else if (balance) showBalance(balance);
  renderThread();
  renderComposer();
  const status = await apiJson('/api/status').catch(() => null);
  if (status) applyStatus(status);
  if (state.vault !== 'open') showLock(state.vault);
  else await loadApp(status);
  // Notices a lock from the idle timer, even if you are only reading.
  setInterval(async () => {
    if (state.locked) return;
    const now = await apiJson('/api/status').catch(() => null);
    if (now && now.vault !== 'open') showLock(now.vault);
  }, 20000);
}());

function applyStatus(status) {
  state.vault = status.vault;
  if (status.vault !== 'open') return; // Nothing else is known until you sign in.
  applyKeys(status);
  state.private = status.privateMode;
  state.retentionDays = status.retentionDays;
  $('auto-lock').value = String(status.autoLockMinutes);
  if (state.private) $('balance').textContent = '';
  renderPrivate();
  renderRetention();
}

async function loadApp(known) {
  const status = known || await apiJson('/api/status').catch(() => null);
  if (status) applyStatus(status);
  renderThread();
  renderComposer();
  $('input').focus();
  const [chats] = await Promise.allSettled([apiJson('/api/chats'), loadModels()]);
  if (chats.status === 'fulfilled') state.chats = chats.value.chats;
  renderChatList();
  renderThread();
  renderComposer();
  // The guide comes first on a first visit; closing it leads on to adding a key.
  if (!store.get('guideSeen', false)) openGuide();
  else if (!state.hasKey && !state.private && status) openKeySettings();
}

function openKeySettings() {
  renderKeyState();
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
  $('key-infero')?.focus();
}

/* ---------- guide ---------- */

// Each step says whether it is done, from what this app can see.
function renderGuide() {
  const mark = (step, done, otherwise) => {
    const node = document.querySelector(`[data-step="${step}"]`);
    node.textContent = done ? 'Done' : otherwise;
    node.classList.toggle('done', done);
  };
  mark('key', state.hasKey, 'To do');
  mark('search', Boolean(state.keys.minirouter || state.keys.openrouter), 'Optional');
  mark('local', state.models.some((m) => m.local), 'Optional');
  $('guide-settings').hidden = state.hasKey;
  $('guide-close').className = state.hasKey ? 'solid' : 'quiet';
}

function openGuide() {
  renderGuide();
  if (!$('guide').open) $('guide').showModal();
  $('guide').scrollTop = 0;
}
