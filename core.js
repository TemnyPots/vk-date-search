// Логика без DOM и сети: разбор страницы стены и поиск по датам.
// Файл подключается как content-скрипт и как модуль Node для тестов.
(function (root) {
  'use strict';

  const BATCH_SIZE = 10; // столько постов ВК отдаёт за один запрос

  const NAMED_ENTITIES = {
    quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ',
    laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…',
  };

  function decodeEntities(text) {
    return text.replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (whole, code) => {
      if (code[0] !== '#') return NAMED_ENTITIES[code] ?? whole;
      const isHex = code[1] === 'x' || code[1] === 'X';
      const point = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    });
  }

  function htmlToText(html) {
    if (!html) return '';
    const text = html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
    return decodeEntities(text).trim();
  }

  function readExecBlocks(html, className, key) {
    const pattern = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"[^>]*?data-exec="([^"]*)"`, 'g');
    const blocks = [];
    for (const match of html.matchAll(pattern)) {
      try {
        const value = JSON.parse(decodeEntities(match[1]))[key];
        if (value) blocks.push(value);
      } catch {
        // Один повреждённый блок не должен ломать всю страницу.
      }
    }
    return blocks;
  }

  function toPost(id, date, content) {
    const item = content?.item;
    const repost = content?.repost;
    const text = [htmlToText(item?.text), htmlToText(repost?.text)].filter(Boolean).join('\n\n');
    const attachments = [...(item?.attachments ?? []), ...(repost?.attachments ?? [])];
    return {
      id,
      date,
      text,
      isRepost: Boolean(repost),
      attachments: attachments.map((attachment) => attachment.type).filter(Boolean),
      likes: item?.likes?.count ?? 0,
      comments: item?.comments?.count ?? 0,
      reposts: item?.reposts?.count ?? 0,
      views: item?.views?.count ?? 0,
    };
  }

  function parsePosts(html) {
    // Среди постов встречаются служебные блоки без id и с нулевой датой: они сбили бы поиск по датам.
    const dateBlocks = readExecBlocks(html, 'PostDateBlock__root', 'PostDateBlock/init')
      .filter((block) => block.postRaw && block.date);
    const postIds = new Set(dateBlocks.map((block) => block.postRaw));

    // Своего блока даты нет только у вложенного поста: это оригинал репоста, он идёт следом за постом.
    const contents = new Map();
    let current = null;
    for (const { item } of readExecBlocks(html, 'PostContentContainer__root', 'PostContentContainer/init')) {
      if (!item) continue;
      const id = `${item.owner_id}_${item.id}`;
      if (postIds.has(id)) {
        current = { item, repost: null };
        contents.set(id, current);
      } else if (current) {
        current.repost ??= item;
      }
    }

    const posts = dateBlocks.map((block) => toPost(block.postRaw, block.date, contents.get(block.postRaw)));

    if (!posts.length && /class="[^"]*\b_post\b/.test(html)) {
      throw new Error('LAYOUT_CHANGED');
    }
    return posts;
  }

  // Ответ al_wall.php: {"payload": [код ошибки, [html постов, ...]]}.
  function parseWallResponse(body) {
    let payload;
    try {
      payload = JSON.parse(body).payload;
    } catch {
      throw new Error('AUTH'); // вместо JSON приходит страница входа или проверки
    }
    if (Number(payload?.[0]) !== 0) throw new Error('WALL_UNAVAILABLE');
    const html = payload[1]?.[0];
    return { posts: typeof html === 'string' ? parsePosts(html) : [] };
  }

  // Стена отсортирована от новых к старым, поэтому место в ней ищем бинарным поиском.
  // Смотрим на последний пост порции: закреплённый пост стоит первым и порядок не сбивает.
  // Возвращаем порцию перед границей: даты на стене иногда идут чуть не по порядку.
  async function findStartOffset(loadPage, to) {
    const isAtOrPastTarget = (page) => !page.posts.length || page.posts.at(-1).date <= to;

    const first = await loadPage(0);
    if (to == null || isAtOrPastTarget(first)) return 0;

    // Счётчик постов на странице ВК занижен, поэтому границу стены находим сами.
    let low = 0;
    let high = BATCH_SIZE * 4;
    while (!isAtOrPastTarget(await loadPage(high))) {
      low = high;
      high *= 4;
    }
    while (high - low > BATCH_SIZE) {
      const middle = low + Math.floor((high - low) / 2 / BATCH_SIZE) * BATCH_SIZE;
      if (isAtOrPastTarget(await loadPage(middle))) high = middle;
      else low = middle;
    }
    return low;
  }

  function createMatcher({ from, to, query }) {
    const needle = (query ?? '').trim().toLowerCase();
    return (post) =>
      (from == null || post.date >= from) &&
      (to == null || post.date <= to) &&
      (!needle || post.text.toLowerCase().includes(needle));
  }

  // Возвращает смещение, с которого можно продолжить, или null, если диапазон просмотрен до конца.
  async function scanRange({ loadPage, offset, from, matches, onPage, maxRequests }) {
    for (let request = 0; request < maxRequests; request += 1) {
      const page = await loadPage(offset);
      if (!page.posts.length) return null;
      onPage(page.posts.filter(matches), page.posts.length);
      if (from != null && page.posts.every((post) => post.date < from)) return null;
      offset += page.posts.length;
    }
    return offset;
  }

  // "wall-1", "club1", "id1", ссылка или короткое имя -> { ownerId } или { screenName }.
  function parseWallInput(input) {
    const value = input.trim();
    if (!value) return null;

    const inPopup = value.match(/[?&]w=wall(-?\d+)/);
    if (inPopup) return { ownerId: Number(inPopup[1]) };

    const path = value.replace(/^(https?:\/\/)?([\w-]+\.)*vk\.(com|ru)/i, '').replace(/^\/+/, '');
    const segment = path.split(/[/?#]/)[0];

    const wall = segment.match(/^wall(-?\d+)(_\d+)?$/);
    if (wall) return { ownerId: Number(wall[1]) };
    const community = segment.match(/^(?:club|public|event)(\d+)$/);
    if (community) return { ownerId: -Number(community[1]) };
    const profile = segment.match(/^id(\d+)$/);
    if (profile) return { ownerId: Number(profile[1]) };
    return /^[\w.]+$/.test(segment) ? { screenName: segment } : null;
  }

  // Страница профиля или сообщества содержит предзагруженный ответ utils.resolveScreenName.
  function readOwnerIdFromPage(html) {
    const match = html.match(/"object_id":(\d+),"type":"(\w+)"/)
      ?? html.match(/"entityId":(\d+),"screenType":"(\w+)"/);
    if (!match) return null;
    return /^(user|profile)$/.test(match[2]) ? Number(match[1]) : -Number(match[1]);
  }

  const api = {
    parseWallResponse, findStartOffset, createMatcher, scanRange,
    parseWallInput, readOwnerIdFromPage,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VkDateSearch = api;
})(globalThis);
