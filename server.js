const express = require('express');
const Parser = require('rss-parser');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const translate = require('google-translate-api-x');

const app = express();
const parser = new Parser({ timeout: 15000 });
const PORT = process.env.PORT || 3300;

const FEEDS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'feeds.json'),
    'utf-8'
  )
);

const BOOST_KEYWORDS = [
  'ai', 'ші', 'штучний інтелект',
  'openai', 'anthropic', 'google',
  'apple', 'microsoft', 'meta',
  'nvidia', 'launch', 'запуск',
  'funding', 'інвестиц', 'раунд',
  'acquisition', 'придбала',
  'закон', 'регулювання',
  'security', 'вразливість',
  'breach', 'ipo'
];

let cache = [];
let refreshing = false;
let translating = false;

const translationCache = new Map();


// =========================
// HELPERS
// =========================

function cleanText(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreItem(item) {
  const date =
    item.publishedAt || Date.now();

  const ageHours =
    (Date.now() - new Date(date)) / 36e5;

  const freshness =
    Math.max(0, 1 - ageHours / 72);

  const haystack =
    `${item.title || ''} ${item.summary || ''}`
      .toLowerCase();

  const hits = BOOST_KEYWORDS.filter(
    (keyword) => haystack.includes(keyword)
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
// TRANSLATION
// =========================

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

    if (!translated) return null;

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
  if (translating) return;

  translating = true;

  try {
    const targets = items.filter(
      (item) =>
        item.lang === 'en' &&
        !item.translated
    );

    console.log(
      `[translation] ${targets.length} items`
    );

    const BATCH_SIZE = 3;

    for (
      let i = 0;
      i < targets.length;
      i += BATCH_SIZE
    ) {
      const batch =
        targets.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (item) => {
          try {
            const [titleUk, summaryUk] =
              await Promise.all([
                translateText(item.title),

                item.summary
                  ? translateText(item.summary)
                  : Promise.resolve(null)
              ]);

            if (titleUk) {
              item.titleOriginal =
                item.title;

              item.title =
                titleUk;

              item.titleUk =
                titleUk;

              item.translated =
                true;
            }

            if (summaryUk) {
              item.summaryOriginal =
                item.summary;

              item.summary =
                summaryUk;

              item.summaryUk =
                summaryUk;
            }

          } catch (error) {
            console.warn(
              '[item translation error]',
              error?.message || error
            );
          }
        })
      );

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 250)
      );
    }

    console.log(
      '[translation] finished'
    );

  } finally {
    translating = false;
  }
}


// =========================
// RSS
// =========================

async function fetchAllFeeds() {
  if (refreshing) {
    console.log(
      '[refresh] already running'
    );
    return;
  }

  refreshing = true;

  console.log(
    '[refresh] Loading RSS feeds...'
  );

  try {
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
                cleanText(
                  item.title ||
                  'Без заголовка'
                ),

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
                null,

              translated: false
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

    /*
      ВАЖЛИВО:
      одразу віддаємо новини сайту.
      Переклад НЕ блокує запуск.
    */

    cache = items;

    console.log(
      `[refresh] ${items.length} items ready`
    );

    /*
      Переклад запускаємо у фоні.
      await тут спеціально НЕ ставимо.
    */

    translateEnglishItems(cache)
      .catch((error) => {
        console.warn(
          '[background translation error]',
          error?.message || error
        );
      });

  } catch (error) {
    console.error(
      '[refresh error]',
      error
    );

  } finally {
    refreshing = false;
  }
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
// STATUS
// =========================

app.get('/api/status', (req, res) => {
  res.json({
    ready: cache.length > 0,
    refreshing,
    translating,
    count: cache.length
  });
});


// =========================
// NEWS API
// =========================

app.get('/api/news', (req, res) => {
  const { source } = req.query;

  const data = source
    ? cache.filter(
        (item) =>
          item.sourceId === source
      )
    : cache;

  res.json({
    updatedAt:
      new Date().toISOString(),

    ready:
      cache.length > 0,

    refreshing,

    translating,

    sources:
      FEEDS,

    items:
      data
  });
});


// =========================
// MANUAL REFRESH
// =========================

app.get(
  '/api/refresh',
  async (req, res) => {
    if (refreshing) {
      return res.json({
        ok: true,
        refreshing: true,
        message:
          'Оновлення вже виконується'
      });
    }

    await fetchAllFeeds();

    res.json({
      ok: true,
      count: cache.length
    });
  }
);


// =========================
// HEALTH CHECK
// =========================

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});


// =========================
// SERVER
// =========================

app.listen(PORT, () => {
  console.log(
    `IT News Hub running on port ${PORT}`
  );

  /*
    Спочатку запускаємо сервер.
    Потім завантажуємо RSS.
  */

  fetchAllFeeds().catch(
    (error) => {
      console.error(
        'Initial fetch failed:',
        error
      );
    }
  );
});


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
