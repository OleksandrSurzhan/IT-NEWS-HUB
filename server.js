const express = require('express');
const Parser = require('rss-parser');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
const parser = new Parser({ timeout: 15000 });
const PORT = process.env.PORT || 3300;

const feedsPath = path.join(__dirname, 'feeds.json');
const FEEDS = JSON.parse(fs.readFileSync(feedsPath, 'utf-8'));

// Words that bump an item's importance score. Edit freely — this is the
// free, no-API way of deciding what counts as "important" for you.
const BOOST_KEYWORDS = [
  'ai', 'ші', 'штучний інтелект', 'openai', 'anthropic', 'google', 'apple',
  'microsoft', 'meta', 'nvidia', 'launch', 'запуск', 'funding', 'інвестиц',
  'раунд', 'acquisition', 'придбала', 'закон', 'регулювання', 'security',
  'вразливість', 'breach', 'ipo'
];

let cache = []; // in-memory store of the latest scored items

function scoreItem(item) {
  const ageHours = (Date.now() - new Date(item.isoDate || item.pubDate || Date.now())) / 36e5;
  // Freshness: full marks under 3h old, decaying to 0 by ~72h.
  const freshness = Math.max(0, 1 - ageHours / 72);

  const haystack = `${item.title || ''} ${item.contentSnippet || ''}`.toLowerCase();
  const hits = BOOST_KEYWORDS.filter((k) => haystack.includes(k)).length;
  const keywordScore = Math.min(hits / 3, 1); // cap so one item can't dominate

  // Weighted blend — tune to taste.
  return Number((freshness * 0.6 + keywordScore * 0.4).toFixed(3));
}

async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const parsed = await parser.parseURL(feed.url);
      return (parsed.items || []).slice(0, 20).map((item) => ({
        id: item.guid || item.link,
        title: item.title,
        link: item.link,
        source: feed.name,
        sourceId: feed.id,
        lang: feed.lang || 'uk',
        summary: (item.contentSnippet || '').slice(0, 220),
        publishedAt: item.isoDate || item.pubDate || null,
      }));
    })
  );

  const items = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      items.push(...r.value);
    } else {
      console.error(`[feed error] ${FEEDS[i].name}:`, r.reason?.message || r.reason);
    }
  });

  items.forEach((item) => {
    item.score = scoreItem(item);
  });

  items.sort((a, b) => b.score - a.score);
  await translateEnglishItems(items);
  cache = items;
  console.log(`[refresh] ${items.length} items from ${FEEDS.length} sources at ${new Date().toLocaleString()}`);
}

// Free machine translation (MyMemory API, no key needed) for English
// sources. Title + summary are sent together in one call per item to
// stay within the free daily quota. Failures are silent — the item
// just keeps its original English text.
async function translateText(text) {
  if (!text) return text;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|uk`;
  const res = await fetch(url);
  const data = await res.json();
  return data?.responseData?.translatedText || text;
}

async function translateEnglishItems(items) {
  const targets = items.filter((i) => i.lang === 'en');
  for (const item of targets) {
    try {
      const combined = `${item.title} ||| ${item.summary}`;
      const translated = await translateText(combined);
      const [title, summary] = translated.split('|||').map((s) => s && s.trim());
      if (title) item.titleUk = title;
      if (summary) item.summaryUk = summary;
    } catch (e) {
      // Leave original English text if translation fails — never block the feed on it.
    }
    await new Promise((r) => setTimeout(r, 250)); // be gentle with the free API
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/news', (req, res) => {
  const { source } = req.query;
  const data = source ? cache.filter((i) => i.sourceId === source) : cache;
  res.json({ updatedAt: new Date().toISOString(), sources: FEEDS, items: data });
});

app.get('/api/refresh', async (req, res) => {
  await fetchAllFeeds();
  res.json({ ok: true, count: cache.length });
});

// Refresh on boot, then every hour.
fetchAllFeeds().catch((e) => console.error('Initial fetch failed:', e));
cron.schedule('0 * * * *', () => fetchAllFeeds().catch((e) => console.error('Refresh failed:', e)));

app.listen(PORT, () => console.log(`IT News Hub running at http://localhost:${PORT}`));
