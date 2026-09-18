const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Tum konusma gecmisini + sabit sistem promptunu Claude'a gonderir, serbest
 * metin cevabi dondurur. Sistem promptu "ephemeral" cache ile isaretlenir,
 * boylece ayni promptu tekrar tekrar tam fiyattan odemezsiniz (Anthropic
 * prompt caching), maliyet dusuk kalir.
 */
async function askClaude(conversation, systemPrompt) {
  if (!CLAUDE_API_KEY) {
    throw new Error('CLAUDE_API_KEY tanimli degil. Bu bot modu Claude olmadan calismaz.');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: conversation,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude API hatasi: ${res.status} ${errBody}`);
  }

  const data = await res.json();
  const text = data?.content?.find((c) => c.type === 'text')?.text;
  return text ? text.trim() : '';
}

module.exports = { askClaude };
