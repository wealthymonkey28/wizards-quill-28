// In-memory story cache — keyed by prompt, evicts oldest when full
const storyCache = new Map();
const CACHE_MAX = 100;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Per-IP rate limiting: max 10 requests per minute
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 1000; // 1 minute

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + RATE_WINDOW;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userPrompt } = req.body;

  if (!userPrompt) {
    return res.status(400).json({ error: 'Missing userPrompt' });
  }

  if (typeof userPrompt !== 'string' || userPrompt.length > 200) {
    return res.status(400).json({ error: 'Prompt must be a string under 200 characters' });
  }

  // Rate limiting
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  // Return cached story if available and fresh
  const cacheKey = userPrompt.trim().toLowerCase();
  const cached = storyCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.status(200).json({ story: cached.story });
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are the Wizard's Quill. Write a short, mystical 3-sentence story."
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const err = await response.text();
    return res.status(response.status).json({ error: err });
  }

  const data = await response.json();
  const story = data.choices[0].message.content;

  // Cache the result, evicting the oldest entry if at capacity
  if (storyCache.size >= CACHE_MAX) {
    storyCache.delete(storyCache.keys().next().value);
  }
  storyCache.set(cacheKey, { story, timestamp: Date.now() });

  return res.status(200).json({ story });
}
