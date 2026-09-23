const feedEl = document.getElementById('feed');
const filtersEl = document.getElementById('filters');
const updatedEl = document.getElementById('updated');
const bellEl = document.getElementById('bell');

const SEEN_KEY = 'wire_seen_ids';
const NOTIF_KEY = 'wire_notif_enabled';

let activeSource = '';
let allSources = [];

function getSeen() {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')
    );
  } catch {
    return new Set();
  }
}

function saveSeen(ids) {
  localStorage.setItem(
    SEEN_KEY,
    JSON.stringify([...ids].slice(-500))
  );
}

function timeAgo(iso) {
  if (!iso) return '';

  const diffMs =
    Date.now() - new Date(iso).getTime();

  const h =
    Math.floor(diffMs / 36e5);

  if (h < 1) return 'щойно';
  if (h < 24) return `${h} год тому`;

  return `${Math.floor(h / 24)} дн тому`;
}


// =========================
// FILTERS
// =========================

function renderFilters(sources) {
  filtersEl.innerHTML = '';

  const all =
    document.createElement('button');

  all.className =
    'chip' +
    (activeSource === '' ? ' active' : '');

  all.textContent = 'Усі';

  all.onclick = () => {
    activeSource = '';
    load();
  };

  filtersEl.appendChild(all);

  sources.forEach((s) => {
    const chip =
      document.createElement('button');

    chip.className =
      'chip' +
      (activeSource === s.id ? ' active' : '');

    chip.textContent =
      s.name;

    chip.onclick = () => {
      activeSource = s.id;
      load();
    };

    filtersEl.appendChild(chip);
  });
}


// =========================
// ARTICLE
// =========================

async function openArticle(item, articleEl, button) {

  const existing =
    articleEl.querySelector('.full-article');

  /*
    Якщо вже відкрита —
    просто закриваємо.
  */

  if (existing) {
    existing.remove();
    button.textContent = 'Читати';
    return;
  }

  button.disabled = true;
  button.textContent = 'Завантаження...';

  const box =
    document.createElement('div');

  box.className =
    'full-article';

  box.innerHTML = `
    <p class="article-loading">
      Завантажуємо статтю${item.lang === 'en'
        ? ' та перекладаємо українською'
        : ''}...
    </p>
  `;

  articleEl
    .querySelector('.item-body')
    .appendChild(box);

  try {

    const response =
      await fetch(
        `/api/article?url=${encodeURIComponent(item.link)}`
      );

    const data =
      await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(
        data.error ||
        'Не вдалося завантажити статтю'
      );
    }

    box.innerHTML = '';

    const text =
      document.createElement('div');

    text.className =
      'article-text';

    /*
      Кожен абзац окремо.
      textContent захищає від HTML зі сторонніх сайтів.
    */

    String(data.text || '')
      .split(/\n{2,}/)
      .filter(Boolean)
      .forEach((paragraph) => {

        const p =
          document.createElement('p');

        p.textContent =
          paragraph.trim();

        text.appendChild(p);
      });

    box.appendChild(text);


    /*
      Посилання на оригінал
      залишаємо внизу.
    */

    const original =
      document.createElement('a');

    original.href =
      data.originalUrl;

    original.target =
      '_blank';

    original.rel =
      'noopener';

    original.className =
      'article-original';

    original.textContent =
      'Відкрити оригінал ↗';

    box.appendChild(original);

    button.textContent =
      'Згорнути';

  } catch (error) {

    box.innerHTML = `
      <p class="article-error">
        Не вдалося завантажити повну статтю.
      </p>
      <a
        class="article-original"
        href="${item.link}"
        target="_blank"
        rel="noopener"
      >
        Відкрити оригінал ↗
      </a>
    `;

    button.textContent =
      'Закрити';

  } finally {

    button.disabled = false;
  }
}


// =========================
// ITEMS
// =========================

function renderItems(items) {

  if (!items.length) {
    feedEl.innerHTML =
      '<p class="empty">Завантажуємо новини...</p>';

    return;
  }

  feedEl.innerHTML = '';

  items.forEach((item) => {

    const barOpacity =
      0.3 + item.score * 0.7;

    const el =
      document.createElement('article');

    el.className =
      'item';

    el.innerHTML = `
      <div
        class="item-bar"
        style="opacity:${barOpacity.toFixed(2)}"
      ></div>

      <div class="item-body">

        <h2 class="item-title">
          <button class="article-title-button">
            ${item.titleUk || item.title}
          </button>
        </h2>

        ${
          (item.summaryUk || item.summary)
            ? `
              <p class="item-summary">
                ${item.summaryUk || item.summary}
              </p>
            `
            : ''
        }

        <div class="item-meta">

          <span class="source">
            ${item.source}
          </span>

          <span>
            ${timeAgo(item.publishedAt)}
          </span>

          ${
            item.lang === 'en'
              ? '<span class="orig-badge">переклад</span>'
              : ''
          }

          <button class="read-button">
            Читати
          </button>

        </div>

      </div>
    `;

    const titleButton =
      el.querySelector(
        '.article-title-button'
      );

    const readButton =
      el.querySelector(
        '.read-button'
      );

    titleButton.onclick =
      () =>
        openArticle(
          item,
          el,
          readButton
        );

    readButton.onclick =
      () =>
        openArticle(
          item,
          el,
          readButton
        );

    feedEl.appendChild(el);
  });
}


// =========================
// NOTIFICATIONS
// =========================

function maybeNotify(items) {

  if (
    localStorage.getItem(NOTIF_KEY) !== '1'
  ) return;

  if (
    Notification.permission !== 'granted'
  ) return;

  const seen =
    getSeen();

  const fresh =
    items.filter(
      (i) =>
        i.id &&
        !seen.has(i.id) &&
        i.score >= 0.55
    );

  fresh
    .slice(0, 3)
    .forEach((item) => {

      const n =
        new Notification(
          `${item.source}: ${item.titleUk || item.title}`,
          {
            body:
              item.summaryUk ||
              item.summary ||
              '',

            tag:
              item.id
          }
        );

      n.onclick =
        () =>
          window.open(
            item.link,
            '_blank'
          );
    });

  items.forEach(
    (i) =>
      i.id &&
      seen.add(i.id)
  );

  saveSeen(seen);
}


// =========================
// LOAD
// =========================

async function load() {

  try {

    const url =
      activeSource
        ? `/api/news?source=${encodeURIComponent(activeSource)}`
        : '/api/news';

    const res =
      await fetch(url);

    const data =
      await res.json();

    allSources =
      data.sources || [];

    renderFilters(
      allSources
    );

    renderItems(
      data.items || []
    );

    updatedEl.textContent =
      `оновлено ${
        new Date(
          data.updatedAt
        ).toLocaleTimeString(
          'uk-UA'
        )
      }`;

    maybeNotify(
      data.items || []
    );

  } catch (error) {

    feedEl.innerHTML =
      '<p class="empty">Сервер запускається. Спробуйте ще раз за кілька секунд.</p>';
  }
}


// =========================
// NOTIFICATION BUTTON
// =========================

function setBellUI(on) {

  bellEl.classList.toggle(
    'on',
    on
  );

  bellEl.textContent =
    on
      ? 'Сповіщення: увімкнено'
      : 'Сповіщення: вимкнено';
}

bellEl.addEventListener(
  'click',
  async () => {

    const currentlyOn =
      localStorage.getItem(
        NOTIF_KEY
      ) === '1';

    if (currentlyOn) {

      localStorage.setItem(
        NOTIF_KEY,
        '0'
      );

      setBellUI(false);

      return;
    }

    const perm =
      await Notification
        .requestPermission();

    if (perm === 'granted') {

      localStorage.setItem(
        NOTIF_KEY,
        '1'
      );

      setBellUI(true);
    }
  }
);


// =========================
// START
// =========================

setBellUI(
  localStorage.getItem(
    NOTIF_KEY
  ) === '1'
);

load();

setInterval(
  load,
  5 * 60 * 1000
);

if (
  'serviceWorker' in navigator
) {
  navigator
    .serviceWorker
    .register('/service-worker.js')
    .catch(() => {});
}
