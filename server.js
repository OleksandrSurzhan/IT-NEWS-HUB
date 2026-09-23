const express = require('express');
const Parser = require('rss-parser');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const translate = require('google-translate-api-x');
const cheerio = require('cheerio');

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
const articleCache = new Map();


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


// =========================
// ARTICLE TRANSLATION
// =========================

async function translateArticle(text) {
  if (!text) return '';

  /*
    Перекладаємо частинами,
    щоб не відправляти величезний текст
    одним запитом.
  */

  const paragraphs =
    text
      .split('\n')
      .map(cleanText)
      .filter(Boolean);

  const translated = [];

  for (const paragraph of paragraphs) {

    /*
      Дуже довгі абзаци ріжемо.
    */

    const chunks =
      paragraph.match(/.{1,1500}(?:\s|$)/g) ||
      [paragraph];

    for (const chunk of chunks) {
      const result =
        await translateText(chunk);

      translated.push(
        result || chunk
      );

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 150)
      );
    }
  }

  return translated.join('\n\n');
}


// =========================
// RSS TRANSLATION
// =========================

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
// ARTICLE EXTRACTOR
// =========================

async function fetchArticle(url) {

  const cached =
    articleCache.get(url);

  if (cached) {
    return cached;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      15000
    );

  try {

    const response =
      await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 Wire-IT-News-Hub/1.0',
          'Accept':
            'text/html,application/xhtml+xml'
        }
      });

    if (!response.ok) {
      throw new Error(
        `Article HTTP ${response.status}`
      );
    }

    const html =
      await response.text();

    const $ =
      cheerio.load(html);

    /*
      Прибираємо все зайве.
    */

    $(
      [
        'script',
        'style',
        'nav',
        'header',
        'footer',
        'aside',
        'form',
        'button',
        'iframe',
        'noscript',
        '.advertisement',
        '.ad',
        '.ads',
        '.social',
        '.share',
        '.newsletter',
        '.related'
      ].join(',')
    ).remove();


    /*
      Шукаємо контейнер статті.
      Підходить для більшості
      новинних сайтів.
    */

    const selectors = [
      'article',
      '[itemprop="articleBody"]',
      '.article-body',
      '.article-content',
      '.entry-content',
      '.post-content',
      '.story-body',
      'main'
    ];

    let container = null;

    for (const selector of selectors) {
      const found = $(selector);

      if (
        found.length &&
        cleanText(found.text()).length > 300
      ) {
        container = found.first();
        break;
      }
    }

    if (!container) {
      throw new Error(
        'Article body not found'
      );
    }


    /*
      Беремо заголовки та абзаци.
    */

    const paragraphs = [];

    container
      .find('p, h2, h3')
      .each((_, element) => {

        const text =
          cleanText(
            $(element).text()
          );

        if (
          text.length >= 30 &&
          !paragraphs.includes(text)
        ) {
          paragraphs.push(text);
        }
      });


    /*
      Захист від величезних сторінок.
    */

    const articleText =
      paragraphs
        .join('\n\n')
        .slice(0, 18000);

    if (
      articleText.length < 200
    ) {
      throw new Error(
        'Article text too short'
      );
    }

    const result = {
      text: articleText
    };

    articleCache.set(
      url,
      result
    );

    return result;

  } finally {
    clearTimeout(timeout);
  }
}


// =========================
// RSS
// =========================

async function fetchAllFeeds() {

  if (refreshing) return;

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

    cache = items;

    console.log(
      `[refresh] ${items.length} items ready`
    );

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

app.get(
  '/api/status',
  (req, res) => {

    res.json({
      ready:
        cache.length > 0,

      refreshing,
      translating,

      count:
        cache.length
    });
  }
);


// =========================
// NEWS API
// =========================

app.get(
  '/api/news',
  (req, res) => {

    const { source } =
      req.query;

    const data =
      source
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
  }
);


// =========================
// FULL ARTICLE API
// =========================

app.get(
  '/api/article',
  async (req, res) => {

    const url =
      String(
        req.query.url || ''
      );

    /*
      Дозволяємо відкривати тільки URL,
      які реально є в нашій RSS-стрічці.
    */

    const item =
      cache.find(
        (news) =>
          news.link === url
      );

    if (!item) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            'Article not found'
        });
    }

    try {

      const article =
        await fetchArticle(url);

      let text =
        article.text;

      /*
        Англійські статті
        перекладаємо українською.
      */

      if (item.lang === 'en') {
        text =
          await translateArticle(
            article.text
          );
      }

      res.json({
        ok: true,

        title:
          item.titleUk ||
          item.title,

        source:
          item.source,

        originalUrl:
          item.link,

        translated:
          item.lang === 'en',

        text
      });

    } catch (error) {

      console.error(
        '[article error]',
        error?.message || error
      );

      res
        .status(500)
        .json({
          ok: false,

          error:
            'Не вдалося завантажити повну статтю.'
        });
    }
  }
);


// =========================
// REFRESH
// =========================

app.get(
  '/api/refresh',
  async (req, res) => {

    if (refreshing) {
      return res.json({
        ok: true,
        refreshing: true
      });
    }

    await fetchAllFeeds();

    res.json({
      ok: true,
      count:
        cache.length
    });
  }
);


// =========================
// HEALTH
// =========================

app.get(
  '/health',
  (req, res) => {
    res
      .status(200)
      .send('OK');
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

    fetchAllFeeds()
      .catch((error) => {

        console.error(
          'Initial fetch failed:',
          error
        );
      });
  }
);


// =========================
// AUTO REFRESH
// =========================

cron.schedule(
  '0 * * * *',
  () => {

    fetchAllFeeds()
      .catch((error) => {

        console.error(
          'Refresh failed:',
          error
        );
      });
  }
);
