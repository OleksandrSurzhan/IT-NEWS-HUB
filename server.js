const express = require('express');
const Parser = require('rss-parser');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const translate = require('google-translate-api-x');

const app = express();
const parser = new Parser({ timeout: 15000 });
const PORT = process.env.PORT || 3300;

const feedsPath = path.join(__dirname, 'feeds.json');
const FEEDS = JSON.parse(
  fs.readFileSync(feedsPath, 'utf-8')
);

const BOOST_KEYWORDS = [
  'ai',
  'ші',
  'штучний інтелект',
  'openai',
  'anthropic',
  'google',
  'apple',
  'microsoft',
  'meta',
  'nvidia',
  'launch',
  'запуск',
  'funding',
  'інвестиц',
  'раунд',
  'acquisition',
  'придбала',
  'закон',
  'регулювання',
  'security',
  'вразливість',
  'breach',
  'ipo'
];

let cache = [];


// =========================
// ОЦІНКА НОВИН
// =========================

function scoreItem(item) {
  const date =
    item.publishedAt ||
    item.isoDate ||
    item.pubDate ||
    Date.now();

  const ageHours =
    (Date.now() - new Date(date)) / 36e5;

  const freshness =
    Math.max(0, 1 - ageHours / 72);

  const haystack =
    `${item.title || ''} ${item.summary || ''}`
      .toLowerCase();

  const hits = BOOST_KEYWORDS.filter((keyword) =>
    haystack.includes(keyword)
  ).length;

  const keywordScore =
    Math.min(hits / 3, 1);

  return Number(
    (
      freshness * 0.6 +
      keywordScore * 0.4
    ).toFixed(3)
  );
}


// =========================
// ПЕРЕКЛАД EN -> UK
// =========================

const translationCache = new Map();

function cleanText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function translateText(text) {
  const clean = cleanText(text);

  if (!clean) return null;

  if (translationCache.has(clean)) {
    return translationCache.get(clean);
  }

  try {
    const result = await translate(clean, {
      from: 'en',
      to: 'uk'
    });

    const translated =
      cleanText(result?.text);

    if (!translated) {
      return null;
    }

    translationCache.set(
      clean,
      translated
    );

    return translated;

  } catch (error) {
    console.warn(
      '[translation error]',
      error?.message || error
    );

    return null;
  }
}


async function translateEnglishItems(items) {
  const targets = items.filter(
    (item) => item.lang === 'en'
  );

  console.log(
    `[translation] ${targets.length} English items`
  );

  const BATCH_SIZE = 5;

  for (
    let i = 0;
    i < targets.length;
    i += BATCH_SIZE
  ) {
    const batch =
      targets.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (item) => {
        const [
          titleUk,
          summaryUk
        ] = await Promise.all([
          translateText(item.title),

          item.summary
            ? translateText(item.summary)
            : Promise.resolve(null)
        ]);

        if (titleUk) {
          item.titleOriginal = item.title;
          item.title = titleUk;
          item.titleUk = titleUk;
          item.translated = true;
        } else {
          item.translated = false;
        }

        if (summaryUk) {
          item.summaryOriginal =
            item.summary;

          item.summary = summaryUk;
          item.summaryUk = summaryUk;
        }
      })
    );

    if (i + BATCH_SIZE < targets.length) {
      await new Promise(
        (resolve) =>
          setTimeout(resolve, 300)
      );
    }
  }

  console.log(
    '[translation] finished'
  );
}


// =========================
// RSS
// =========================

async function fetchAllFeeds() {
  console.log(
    '[refresh] Loading RSS feeds...'
  );

  const results =
    await Promise.allSettled(
      FEEDS.map(async (feed) => {
        const parsed =
          await parser.parseURL(feed.url);

        return (parsed.items || [])
          .slice(0, 20)
          .map((item) => ({
            id:
              item.guid ||
              item.link,

            title:
              item.title ||
              'Без заголовка',

            link:
              item.link,

            source:
              feed.name,

            sourceId:
              feed.id,

            lang:
              feed.lang || 'uk',

            summary:
              cleanText(
                item.contentSnippet ||
                item.content ||
                ''
              ).slice(0, 220),

            publishedAt:
              item.isoDate ||
              item.pubDate ||
              null
          }));
      })
    );

  const items = [];

  results.forEach(
    (result, index) => {
      if (
        result.status ===
        'fulfilled'
      ) {
        items.push(
          ...result.value
        );
      } else {
        console.error(
          `[feed error] ${FEEDS[index].name}:`,
          result.reason?.message ||
          result.reason
        );
      }
    }
  );

  items.forEach((item) => {
    item.score =
      scoreItem(item);
  });

  items.sort(
    (a, b) =>
      b.score - a.score
  );

  try {
    await translateEnglishItems(
      items
    );
  } catch (error) {
    console.warn(
      '[translation unavailable]',
      error?.message || error
    );
  }

  cache = items;

  console.log(
    `[refresh] ${items.length} items from ` +
    `${FEEDS.length} sources`
  );
}


// =========================
// STATIC
// =========================

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);


// =========================
// API
// =========================

app.get(
  '/api/news',
  (req, res) => {
    const { source } =
      req.query;

    const data = source
      ? cache.filter(
          (item) =>
            item.sourceId ===
            source
        )
      : cache;

    res.json({
      updatedAt:
        new Date().toISOString(),

      sources:
        FEEDS,

      items:
        data
    });
  }
);


// =========================
// MANUAL REFRESH
// =========================

app.get(
  '/api/refresh',
  async (req, res) => {
    try {
      await fetchAllFeeds();

      res.json({
        ok: true,
        count: cache.length
      });

    } catch (error) {
      console.error(
        '[refresh error]',
        error
      );

      res.status(500).json({
        ok: false,
        error: 'Refresh failed'
      });
    }
  }
);


// =========================
// STARTUP
// =========================

fetchAllFeeds().catch(
  (error) => {
    console.error(
      'Initial fetch failed:',
      error
    );
  }
);


// =========================
// AUTO REFRESH
// =========================

cron.schedule(
  '0 * * * *',
  () => {
    fetchAllFeeds().catch(
      (error) => {
        console.error(
          'Refresh failed:',
          error
        );
      }
    );
  }
);


// =========================
// SERVER
// =========================

app.listen(
  PORT,
  () => {
    console.log(
      `IT News Hub running on port ${PORT}`
    );
  }
);
