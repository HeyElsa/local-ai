// True when a model stopped before really answering: the provider says it was cut
// off, or a short reply that used search ends by announcing what it will do next.
export function looksUnfinished({ content, finishReason, searches }) {
  if (!content) return false;
  if (finishReason === 'length' || finishReason === 'tool_calls') return true;
  if (!searches || content.length > 400) return false;
  const lastSentence = content.trim().split(/(?<=[.!?])\s+/).at(-1);
  return /\b(let me|i'll|i’ll|i will|i'm going to|i’m going to)\b/i.test(lastSentence);
}

// Models report reasoning under different names. Some send several for the same
// text, so only the first one present is used, which avoids showing it twice.
export function reasoningText(delta) {
  if (!delta) return '';
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) return delta.reasoning_content;
  if (typeof delta.reasoning === 'string' && delta.reasoning) return delta.reasoning;
  if (Array.isArray(delta.reasoning_details)) {
    return delta.reasoning_details.map((d) => d?.text || d?.summary || '').filter((t) => typeof t === 'string').join('');
  }
  return '';
}
