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

const BOOST_KEYWORDS = [
  'ai', 'ші', 'штучний інтелект', 'openai', 'anthropic', 'google', 'apple',
  'microsoft', 'meta', 'nvidia', 'launch', 'запуск', 'funding', 'інвестиц',
  'раунд', 'acquisition', 'придбала', 'закон', 'регулювання', 'security',
  'вразливість', 'breach', 'ipo'
];

let cache = [];

/* =========================
   ОЦІНКА ВАЖЛИВОСТІ НОВИНИ
   ========================= */

function scoreItem(item) {
  const ageHours =
    (Date.now() -
      new Date(item.isoDate || item.pubDate || Date.now())) /
    36e5;

  const freshness = Math.max(0, 1 - ageHours / 72);

  const haystack =
    `${item.title || ''} ${item.contentSnippet || ''}`.toLowerCase();

  const hits = BOOST_KEYWORDS.filter((k) =>
    haystack.includes(k)
  ).length;

  const keywordScore = Math.min(hits / 3, 1);

  return Number(
    (freshness * 0.6 + keywordScore * 0.4).toFixed(3)
  );
}

/* =========================
   ПЕРЕКЛАД
   ========================= */

const translationCache = new Map();

/*
  MyMemory іноді замість перекладу повертає повідомлення
  про закінчення безкоштовного ліміту.

  Ця функція перевіряє, чи не є відповідь сервісу
  повідомленням про помилку.
*/
function isBadTranslation(text) {
  if (!text) return true;

  const value = String(text).toLowerCase();

  const badPhrases = [
    'mymemory warning',
    'you used all available free translations',
    'next available in',
    'translate more',
    'usage limits',
    'translated.net/doc/usagelimits',
    'quota',
    'daily limit'
  ];

  return badPhrases.some((phrase) =>
    value.includes(phrase)
  );
}

async function translateText(text) {
  const clean = String(text || '').trim();

  if (!clean) return null;

  if (translationCache.has(clean)) {
    return translationCache.get(clean);
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 8000);

  try {
    const url =
      `https://api.mymemory.translated.net/get` +
      `?q=${encodeURIComponent(clean)}` +
      `&langpair=en|uk`;

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Wire-IT-News-Hub/1.0'
      }
    });

    if (!res.ok) {
      throw new Error(
        `translation HTTP ${res.status}`
      );
    }

    const data = await res.json();

    /*
      MyMemory може повернути HTTP 200 навіть тоді,
      коли фактично повідомляє про вичерпаний ліміт.
      Тому перевіряємо не тільки responseStatus.
    */

    const translated =
      data?.responseData?.translatedText;

    if (
      data?.responseStatus !== 200 ||
      !translated ||
      isBadTranslation(translated)
    ) {
      throw new Error(
        'MyMemory translation unavailable or daily limit reached'
      );
    }

    translationCache.set(clean, translated);

    return translated;

  } catch (error) {
    /*
      ВАЖЛИВО:
      якщо переклад не працює, повертаємо null.
      Оригінальний англійський текст залишається на сайті.
    */

    console.warn(
      '[translation skipped]',
      error?.message || error
    );

    return null;

  } finally {
    clearTimeout(timeout);
  }
}

async function translateEnglishItems(items) {
  const targets = items.filter(
    (item) => item.lang === 'en'
  );

  for (const item of targets) {

    const translatedTitle =
      await translateText(item.title);

    /*
      Заголовок замінюємо тільки тоді,
      коли отримали справжній переклад.
    */

    if (
      translatedTitle &&
      !isBadTranslation(translatedTitle) &&
      translatedTitle !== item.title
    ) {
      item.titleUk = translatedTitle;
      item.translated = true;
    } else {
      item.titleUk = null;
      item.translated = false;
    }

    /*
      Опис перекладаємо тільки якщо він є.
    */

    if (item.summary) {
      const translatedSummary =
        await translateText(item.summary);

      if (
        translatedSummary &&
        !isBadTranslation(translatedSummary) &&
        translatedSummary !== item.summary
      ) {
        item.summaryUk = translatedSummary;
      } else {
        item.summaryUk = null;
      }
    }

    /*
      Невелика пауза між запитами,
      щоб не перевантажувати безкоштовний сервіс.
    */

    await new Promise((resolve) =>
      setTimeout(resolve, 200)
    );
  }
}

/* =========================
   RSS
   ========================= */

async function fetchAllFeeds() {

  console.log('[refresh] Loading RSS feeds...');

  const results = await Promise.allSettled(

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
            item.title || 'Без заголовка',

          link:
            item.link,

          source:
            feed.name,

          sourceId:
            feed.id,

          lang:
            feed.lang || 'uk',

          summary:
            (item.contentSnippet || '')
              .slice(0, 220),

          publishedAt:
            item.isoDate ||
            item.pubDate ||
            null

        }));
    })
  );

  const items = [];

  results.forEach((result, index) => {

    if (result.status === 'fulfilled') {

      items.push(...result.value);

    } else {

      console.error(
        `[feed error] ${FEEDS[index].name}:`,
        result.reason?.message ||
        result.reason
      );
    }
  });

  items.forEach((item) => {

    item.score = scoreItem(item);

  });

  items.sort(
    (a, b) => b.score - a.score
  );

  /*
    Переклад не повинен ламати RSS.
    Навіть якщо сервіс перекладу недоступний,
    новини все одно будуть показані.
  */

  try {

    await translateEnglishItems(items);

  } catch (error) {

    console.warn(
      '[translation system unavailable]',
      error?.message || error
    );
  }

  cache = items;

  console.log(
    `[refresh] ${items.length} items ` +
    `from ${FEEDS.length} sources at ` +
    new Date().toLocaleString()
  );
}

/* =========================
   СТАТИЧНИЙ САЙТ
   ========================= */

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

/* =========================
   API НОВИН
   ========================= */

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

    sources:
      FEEDS,

    items:
      data

  });
});

/* =========================
   РУЧНЕ ОНОВЛЕННЯ
   ========================= */

app.get('/api/refresh', async (req, res) => {

  try {

    await fetchAllFeeds();

    res.json({
      ok: true,
      count: cache.length
    });

  } catch (error) {

    console.error(
      '[manual refresh error]',
      error
    );

    res.status(500).json({
      ok: false,
      error: 'Refresh failed'
    });
  }
});

/* =========================
   АВТООНОВЛЕННЯ
   ========================= */

/*
  Завантажуємо новини одразу
  після запуску Render.
*/

fetchAllFeeds().catch((error) => {

  console.error(
    'Initial fetch failed:',
    error
  );

});

/*
  Потім оновлюємо стрічку щогодини.
*/

cron.schedule(
  '0 * * * *',
  () => {

    fetchAllFeeds().catch((error) => {

      console.error(
        'Refresh failed:',
        error
      );

    });
  }
);

/* =========================
   START
   ========================= */

app.listen(PORT, () => {

  console.log(
    `IT News Hub running on port ${PORT}`
  );

});
