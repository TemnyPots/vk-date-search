// Панель поиска на страницах ВК. Запросы идут в рамках текущей сессии, наружу ничего не уходит.
(function () {
  'use strict';

  if (document.getElementById('vk-date-search-host')) return;

  const core = globalThis.VkDateSearch;
  const REQUEST_DELAY_MS = 250;  // пауза между запросами, чтобы не упереться в лимиты ВК
  const REQUESTS_PER_RUN = 100;  // около 1000 постов, дальше продолжение по кнопке
  const MAX_RETRIES = 2;

  const ATTACHMENT_LABELS = {
    photo: 'фото', video: 'видео', audio: 'аудио', doc: 'файл', link: 'ссылка',
    poll: 'опрос', article: 'статья', clip: 'клип', podcast: 'подкаст', market: 'товар',
  };

  const ERROR_MESSAGES = {
    AUTH: 'ВК просит войти или пройти проверку. Обновите страницу ВК и повторите поиск.',
    NOT_FOUND: 'Такая стена не найдена. Проверьте ссылку.',
    WALL_UNAVAILABLE: 'ВК не отдал эту стену. Проверьте ссылку и доступ к странице.',
    LAYOUT_CHANGED: 'ВК изменил формат страницы, и расширение не смогло прочитать посты.',
    RESOLVE: 'Не удалось определить стену. Откройте сообщество или профиль либо вставьте ссылку на них.',
  };

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
    .theme {
      --bg: #fff; --surface: #f5f6f8; --text: #000; --muted: #6d7885; --line: #dce1e6;
      --accent: #0077ff; --on-accent: #fff; --danger: #e64646;
    }
    .theme[data-theme="dark"] {
      --bg: #222223; --surface: #2c2d2e; --text: #e1e3e6; --muted: #929699; --line: #3a3b3c;
      --accent: #529ef4; --on-accent: #0b1a2b; --danger: #ff5c5c;
      color-scheme: dark;
    }
    .launcher {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      padding: 9px 14px; border: 0; border-radius: 20px; cursor: pointer;
      background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 500;
      box-shadow: 0 2px 10px rgba(0, 0, 0, .25);
    }
    .panel {
      position: fixed; right: 16px; top: 64px; bottom: 16px; z-index: 2147483000;
      width: 380px; max-width: calc(100vw - 32px); display: flex; flex-direction: column;
      background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 6px 28px rgba(0, 0, 0, .28); font-size: 13px; line-height: 1.4;
    }
    [hidden] { display: none !important; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--line); }
    h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .close { border: 0; background: none; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; }
    form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
    label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
    .wide { grid-column: 1 / -1; }
    input[type="text"], input[type="date"] {
      width: 100%; height: 34px; padding: 0 10px; font-size: 13px; color: var(--text);
      background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color-scheme: light;
    }
    .theme[data-theme="dark"] input { color-scheme: dark; }
    input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .check { display: flex; align-items: center; gap: 6px; color: var(--text); font-size: 13px; }
    .primary, .secondary { height: 34px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; }
    .primary { border: 0; background: var(--accent); color: var(--on-accent); }
    .secondary { border: 1px solid var(--line); background: none; color: var(--text); }
    .status { padding: 8px 16px; color: var(--muted); min-height: 34px; }
    .status.error { color: var(--danger); }
    .results { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 0 16px 8px; list-style: none; }
    .post { display: block; padding: 10px 12px; margin-bottom: 8px; border-radius: 8px; background: var(--surface); color: inherit; text-decoration: none; }
    .post:hover { outline: 1px solid var(--accent); }
    .date { color: var(--accent); font-weight: 500; }
    .text { margin: 4px 0; white-space: pre-line; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
    .text:empty { display: none; }
    .meta { color: var(--muted); font-size: 12px; }
    .more { margin: 0 16px 12px; }
  `;

  const TEMPLATE = `
    <div class="theme">
      <button class="launcher" type="button">Посты по дате</button>
      <section class="panel" hidden aria-label="Поиск постов по дате">
        <header>
          <h2>Поиск постов по дате</h2>
          <button class="close" type="button" aria-label="Закрыть">×</button>
        </header>
        <form>
          <label class="wide">Стена (ссылка, короткое имя или wall-123)
            <input type="text" name="wall" autocomplete="off" spellcheck="false">
          </label>
          <label>С даты <input type="date" name="from"></label>
          <label>По дату <input type="date" name="to"></label>
          <label class="wide">Слово в тексте (необязательно)
            <input type="text" name="query" autocomplete="off">
          </label>
          <label class="check wide"><input type="checkbox" name="own"> Только посты владельца стены</label>
          <button class="primary wide" type="submit">Найти</button>
        </form>
        <div class="status" role="status"></div>
        <ul class="results"></ul>
        <button class="secondary more" type="button" hidden>Продолжить поиск</button>
      </section>
    </div>`;

  const host = document.createElement('div');
  host.id = 'vk-date-search-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.append(style);
  shadow.append(document.createRange().createContextualFragment(TEMPLATE));
  document.documentElement.append(host); // вне body: переходы внутри ВК панель не трогают

  const find = (selector) => shadow.querySelector(selector);
  const theme = find('.theme');
  const launcher = find('.launcher');
  const panel = find('.panel');
  const form = find('form');
  const submitButton = find('.primary');
  const statusLine = find('.status');
  const resultList = find('.results');
  const moreButton = find('.more');

  let wallFollowsPage = true; // поле стены следует за адресом, пока его не изменили вручную
  let activeSearch = null;    // последний поиск; controller задан, пока он выполняется

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

  async function fetchText(url, options) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { credentials: 'include', ...options });
      if (response.status === 404) throw new Error('NOT_FOUND');
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_RETRIES) throw new Error(`HTTP ${response.status}`);
        await sleep(1500 * (attempt + 1), options.signal);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (/^\/(login|challenge|blank)/.test(new URL(response.url).pathname)) throw new Error('AUTH');

      const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'windows-1251';
      return new TextDecoder(charset).decode(await response.arrayBuffer());
    }
  }

  async function resolveOwnerId(input, signal) {
    const wall = core.parseWallInput(input);
    if (!wall) throw new Error('RESOLVE');
    if (wall.ownerId != null) return wall.ownerId;

    let html;
    try {
      html = await fetchText(`${location.origin}/${encodeURIComponent(wall.screenName)}`, { signal });
    } catch (error) {
      // Служебные разделы вроде /feed могут уводить на другой домен, и fetch падает с TypeError.
      if (error instanceof TypeError) throw new Error('RESOLVE');
      throw error;
    }
    const ownerId = core.readOwnerIdFromPage(html);
    if (ownerId == null) throw new Error('RESOLVE');
    return ownerId;
  }

  function createPageLoader(ownerId, ownOnly, search) {
    const cache = new Map();
    let hasRequested = false;
    return async (offset) => {
      if (!cache.has(offset)) {
        const { signal } = search.controller; // у каждого запуска поиска свой сигнал отмены
        if (hasRequested) await sleep(REQUEST_DELAY_MS, signal);
        hasRequested = true;
        const body = await fetchText(`${location.origin}/al_wall.php?act=get_wall`, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body: new URLSearchParams({
            act: 'get_wall', al: 1, owner_id: ownerId, offset,
            type: ownOnly ? 'own' : 'all', fixed: '', onlyCache: false,
          }),
          signal,
        });
        cache.set(offset, core.parseWallResponse(body));
      }
      return cache.get(offset);
    };
  }

  function formatDate(unixSeconds) {
    return new Date(unixSeconds * 1000).toLocaleString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function describeAttachments(types) {
    const counts = new Map();
    for (const type of types) {
      const label = ATTACHMENT_LABELS[type];
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(', ');
  }

  function renderPost(post) {
    const link = document.createElement('a');
    link.className = 'post';
    link.href = `${location.origin}/wall${post.id}`;
    link.target = '_blank';
    link.rel = 'noopener';

    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = formatDate(post.date);

    const attachments = describeAttachments(post.attachments);
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = post.text || (attachments ? '' : 'Без текста');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [
      post.isRepost ? 'репост' : '',
      attachments,
      `❤ ${post.likes}`,
      `💬 ${post.comments}`,
      `👁 ${post.views}`,
    ].filter(Boolean).join(' · ');

    link.append(date, text, meta);
    const row = document.createElement('li');
    row.append(link);
    return row;
  }

  function renderResults(found) {
    const posts = [...found.values()].sort((a, b) => b.date - a.date);
    resultList.replaceChildren(...posts.map(renderPost));
  }

  function setStatus(message, isError = false) {
    statusLine.textContent = message;
    statusLine.classList.toggle('error', isError);
  }

  function setRunning(isRunning) {
    submitButton.textContent = isRunning ? 'Остановить' : 'Найти';
    if (isRunning) moreButton.hidden = true;
  }

  function reportFailure(error, search) {
    if (error.name === 'AbortError') {
      setStatus(`Поиск остановлен. Найдено постов: ${search.found.size}.`);
      return;
    }
    setStatus(ERROR_MESSAGES[error.message] ?? `Не удалось загрузить стену: ${error.message}`, true);
  }

  async function runScan(search) {
    setRunning(true);
    try {
      search.nextOffset = await core.scanRange({
        loadPage: search.loadPage,
        offset: search.nextOffset,
        from: search.from,
        matches: search.matches,
        maxRequests: REQUESTS_PER_RUN,
        onPage(matched, pageSize) {
          search.scanned += pageSize;
          for (const post of matched) search.found.set(post.id, post);
          renderResults(search.found);
          setStatus(`Просмотрено постов: ${search.scanned}. Найдено: ${search.found.size}.`);
        },
      });

      if (search.nextOffset == null) {
        setStatus(search.found.size
          ? `Готово. Найдено постов: ${search.found.size}.`
          : 'За этот период постов нет. Если стена закрыта, войдите в ВК или проверьте доступ к ней.');
      } else {
        moreButton.hidden = false;
        setStatus(`Просмотрено постов: ${search.scanned}. Найдено: ${search.found.size}. Период просмотрен не полностью.`);
      }
    } catch (error) {
      reportFailure(error, search);
    } finally {
      search.controller = null;
      setRunning(false);
    }
  }

  async function startSearch() {
    const values = new FormData(form);
    const from = parseDay(values.get('from'), 0, 0, 0);
    const to = parseDay(values.get('to'), 23, 59, 59);

    if (from == null && to == null) return setStatus('Укажите хотя бы одну дату.', true);
    if (from != null && to != null && from > to) return setStatus('Начальная дата позже конечной.', true);

    const search = {
      controller: new AbortController(),
      found: new Map(),
      scanned: 0,
      from,
      matches: core.createMatcher({ from, to, query: values.get('query') }),
    };
    activeSearch = search;
    resultList.replaceChildren();
    setRunning(true);
    setStatus('Ищу нужные даты на стене…');

    try {
      const ownerId = await resolveOwnerId(values.get('wall'), search.controller.signal);
      search.loadPage = createPageLoader(ownerId, values.get('own') === 'on', search);
      search.nextOffset = await core.findStartOffset(search.loadPage, to);

      // Закреплённый пост стоит первым независимо от даты и мог остаться выше найденного места.
      const firstPage = await search.loadPage(0);
      for (const post of firstPage.posts.filter(search.matches)) search.found.set(post.id, post);
    } catch (error) {
      reportFailure(error, search);
      search.controller = null;
      setRunning(false);
      return;
    }
    await runScan(search);
  }

  function parseDay(value, hours, minutes, seconds) {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, hours, minutes, seconds).getTime() / 1000;
  }

  function syncWallField() {
    if (wallFollowsPage) form.elements.wall.value = location.href;
  }

  function applyTheme() {
    const channels = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number);
    const isOpaque = channels && (channels.length < 4 || channels[3] > 0);
    const isDark = isOpaque
      ? channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114 < 128
      : matchMedia('(prefers-color-scheme: dark)').matches;
    theme.dataset.theme = isDark ? 'dark' : 'light';
  }

  function togglePanel() {
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    launcher.hidden = willOpen;
    if (willOpen) {
      applyTheme();
      syncWallField();
      form.elements.from.focus();
    }
  }

  launcher.addEventListener('click', togglePanel);
  find('.close').addEventListener('click', togglePanel);
  form.elements.wall.addEventListener('input', () => { wallFollowsPage = false; });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (activeSearch?.controller) {
      activeSearch.controller.abort();
      return;
    }
    syncWallField();
    startSearch();
  });

  moreButton.addEventListener('click', () => {
    activeSearch.controller = new AbortController();
    runScan(activeSearch);
  });

  // Сочетания клавиш ВК не должны срабатывать, пока вводят текст в панели.
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') togglePanel();
  });

  applyTheme();
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'toggle-panel') togglePanel();
  });
})();
