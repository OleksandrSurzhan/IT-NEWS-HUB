const feedEl = document.getElementById('feed');
const filtersEl = document.getElementById('filters');
const updatedEl = document.getElementById('updated');
const bellEl = document.getElementById('bell');

const SEEN_KEY = 'wire_seen_ids';
const NOTIF_KEY = 'wire_notif_enabled';
let activeSource = '';
let allSources = [];

function getSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveSeen(ids) {
  localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-500)));
}

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diffMs / 36e5);
  if (h < 1) return 'щойно';
  if (h < 24) return `${h} год тому`;
  return `${Math.floor(h / 24)} дн тому`;
}

function renderFilters(sources) {
  filtersEl.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'chip' + (activeSource === '' ? ' active' : '');
  all.textContent = 'Усі';
  all.onclick = () => { activeSource = ''; load(); };
  filtersEl.appendChild(all);

  sources.forEach((s) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (activeSource === s.id ? ' active' : '');
    chip.textContent = s.name;
    chip.onclick = () => { activeSource = s.id; load(); };
    filtersEl.appendChild(chip);
  });
}

function renderItems(items) {
  if (!items.length) {
    feedEl.innerHTML = '<p class="empty">Тут поки порожньо — можливо, джерела ще не завантажились.</p>';
    return;
  }
  feedEl.innerHTML = '';
  items.forEach((item) => {
    const barOpacity = 0.3 + item.score * 0.7;
    const el = document.createElement('article');
    el.className = 'item';
    el.innerHTML = `
      <div class="item-bar" style="opacity:${barOpacity.toFixed(2)}"></div>
      <div class="item-body">
        <h2 class="item-title"><a href="${item.link}" target="_blank" rel="noopener">${item.titleUk || item.title}</a></h2>
        ${(item.summaryUk || item.summary) ? `<p class="item-summary">${item.summaryUk || item.summary}</p>` : ''}
        <div class="item-meta">
          <span class="source">${item.source}</span>
          <span>${timeAgo(item.publishedAt)}</span>
          ${item.lang === 'en' ? '<span class="orig-badge">переклад</span>' : ''}
        </div>
      </div>
    `;
    feedEl.appendChild(el);
  });
}

function maybeNotify(items) {
  if (localStorage.getItem(NOTIF_KEY) !== '1') return;
  if (Notification.permission !== 'granted') return;

  const seen = getSeen();
  const fresh = items.filter((i) => i.id && !seen.has(i.id) && i.score >= 0.55);

  fresh.slice(0, 3).forEach((item) => {
    const n = new Notification(`${item.source}: ${item.title}`, {
      body: item.summary || '',
      tag: item.id,
    });
    n.onclick = () => window.open(item.link, '_blank');
  });

  items.forEach((i) => i.id && seen.add(i.id));
  saveSeen(seen);
}

async function load() {
  const url = activeSource ? `/api/news?source=${encodeURIComponent(activeSource)}` : '/api/news';
  const res = await fetch(url);
  const data = await res.json();

  allSources = data.sources || [];
  renderFilters(allSources);
  renderItems(data.items || []);
  updatedEl.textContent = `оновлено ${new Date(data.updatedAt).toLocaleTimeString('uk-UA')}`;

  maybeNotify(data.items || []);
}

function setBellUI(on) {
  bellEl.classList.toggle('on', on);
  bellEl.textContent = on ? 'Сповіщення: увімкнено' : 'Сповіщення: вимкнено';
}

bellEl.addEventListener('click', async () => {
  const currentlyOn = localStorage.getItem(NOTIF_KEY) === '1';
  if (currentlyOn) {
    localStorage.setItem(NOTIF_KEY, '0');
    setBellUI(false);
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    localStorage.setItem(NOTIF_KEY, '1');
    setBellUI(true);
  }
});

setBellUI(localStorage.getItem(NOTIF_KEY) === '1');
load();
setInterval(load, 5 * 60 * 1000); // re-poll every 5 minutes

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}
