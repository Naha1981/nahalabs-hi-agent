// Parse provider SSE without inventing tokens or forwarding tool arguments to the browser.
export async function readChatStream(response, onDelta = () => {}) {
  let buffer = '', content = '', finish_reason = null, usage;
  const calls = new Map();
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (event.error) throw new Error('Reply stream unavailable.');
    usage = event.usage || usage;
    const choice = event.choices?.[0]; if (!choice) return;
    finish_reason = choice.finish_reason || finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') { content += delta.content; onDelta(delta.content); }
    for (const t of delta.tool_calls || []) {
      const previous = calls.get(t.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (t.id) previous.id = t.id;
      previous.function.name += t.function?.name || '';
      previous.function.arguments += t.function?.arguments || '';
      calls.set(t.index, previous);
    }
  };
  const decoder = new TextDecoder();
  if (!response.body) throw new Error('Reply stream unavailable.');
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1000000 || content.length > 100000) throw new Error('Reply stream is too large.');
    let end; while ((end = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1); }
  }
  buffer += decoder.decode(); if (buffer.trim()) consume(buffer.replace(/\r$/, ''));
  if (!finish_reason) throw new Error('Reply stream ended early.');
  return { choices: [{ finish_reason, message: { content, tool_calls: [...calls.values()] } }], usage };
}
