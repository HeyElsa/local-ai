// Markdown to safe DOM. Raw HTML from a model is shown as text, remote images
// are turned into links, and the result still passes through DOMPurify.
import { Marked } from '/vendor/marked/lib/marked.esm.js';
import DOMPurify from '/vendor/dompurify/dist/purify.es.mjs';
import hljs from '/vendor/@highlightjs/cdn-assets/es/highlight.min.js';
import { buildFigure } from '/figures.js';

const FIGURES = new Set(['chart', 'timeline', 'steps', 'stats', 'mermaid']);
const FENCE_END = /(^|\n)\s*(`{3,}|~{3,})\s*$/;
const PENDING = { chart: 'Drawing chart', timeline: 'Drawing timeline', steps: 'Laying out steps', stats: 'Preparing numbers', mermaid: 'Drawing diagram' };

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const math = (name, level, patterns, start) => ({
  name, level,
  start: (src) => { const i = src.search(start); return i < 0 ? undefined : i; },
  tokenizer(src) {
    for (const pattern of patterns) {
      const m = pattern.exec(src);
      if (m) return { type: name, raw: m[0], tex: m[1].trim() };
    }
    return undefined;
  },
  renderer: (token) => `<${level === 'block' ? 'div' : 'span'} class="math" data-display="${level === 'block'}" data-tex="${encodeURIComponent(token.tex)}"></${level === 'block' ? 'div' : 'span'}>`,
});

let isStreaming = false;

const marked = new Marked({
  gfm: true,
  breaks: false,
  extensions: [
    math('mathBlock', 'block', [/^\s*\$\$([\s\S]+?)\$\$/, /^\s*\\\[([\s\S]+?)\\\]/], /\$\$|\\\[/),
    // The dollar form refuses a digit straight after the opening $, so "$5 and $10" stays as prices.
    math('mathInline', 'inline', [/^\\\(([\s\S]+?)\\\)/, /^\$(?![\s\d])([^$\n]+?)(?<!\s)\$(?!\d)/], /\$|\\\(/),
  ],
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ href, text }) => `<a href="${escape(href)}">${escape(text || 'Image')} (open image)</a>`,
    code({ text, lang, raw }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      const complete = FENCE_END.test((raw || '').trimEnd()) && raw.trim().split('\n').length > 1;
      if (FIGURES.has(language)) {
        return complete || !isStreaming
          ? `<div data-figure="${language}" data-src="${encodeURIComponent(text)}"></div>`
          : `<div class="viz viz-pending">${PENDING[language]}</div>`;
      }
      const highlighted = language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escape(text);
      return `<div class="code"><div class="code-head"><span>${escape(language || 'Text')}</span><button type="button" class="quiet" data-copy-code>Copy</button></div><pre><code>${highlighted}</code></pre></div>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

let katexLib;
async function renderMath(root) {
  const nodes = root.querySelectorAll('.math[data-tex]');
  if (!nodes.length) return;
  katexLib ||= import('/vendor/katex/dist/katex.mjs').then((m) => m.default);
  const katex = await katexLib;
  for (const node of nodes) {
    const display = node.dataset.display === 'true';
    if (display) node.classList.add('math-block');
    katex.render(decodeURIComponent(node.dataset.tex), node, { displayMode: display, throwOnError: false, trust: false });
    node.removeAttribute('data-tex');
  }
}

// `cache` keeps already drawn visuals in place while an answer streams, so they do not flicker.
export function renderMarkdown(target, source, { streaming = false, cache = new Map() } = {}) {
  isStreaming = streaming;
  const html = marked.parse(source);
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select'], FORBID_ATTR: ['style'] });
  const next = document.createElement('div');
  next.innerHTML = clean;
  for (const table of next.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
  for (const holder of next.querySelectorAll('[data-figure]')) {
    const key = `${holder.dataset.figure}:${holder.dataset.src}`;
    let figure = cache.get(key);
    if (!figure) {
      figure = buildFigure(holder.dataset.figure, decodeURIComponent(holder.dataset.src));
      cache.set(key, figure);
    }
    holder.replaceWith(figure);
  }
  target.replaceChildren(...next.childNodes);
  renderMath(target);
}
