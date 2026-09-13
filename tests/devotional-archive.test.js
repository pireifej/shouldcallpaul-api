'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const devotionalRoutes = require('../routes/devotional');

const SAVED_ARTICLES = [
  {
    id: 1,
    date: '2020-01-02',
    lang: 'en',
    title: 'Older English article',
    bible_verse: 'Be still, and know that I am God.',
    verse_reference: 'Psalm 46:10',
    article_body: 'A reflection on quiet trust.',
    prayer: 'Lord, teach us to rest in You.',
    theme: 'Peace',
    image_url: 'https://example.com/older.jpg',
    created_at: '2020-01-02T08:00:00.000Z',
    audio_url: 'https://example.com/older.mp3'
  },
  {
    id: 2,
    date: '2020-01-03',
    lang: 'es',
    title: 'Artículo en español',
    bible_verse: 'Todo lo puedo en Cristo.',
    verse_reference: 'Filipenses 4:13',
    article_body: 'Una reflexión sobre la esperanza.',
    prayer: 'Señor, fortalece nuestra fe.',
    theme: 'Esperanza',
    image_url: 'https://example.com/spanish.jpg',
    created_at: '2020-01-03T08:00:00.000Z',
    audio_url: null
  },
  {
    id: 4,
    date: '2020-01-01',
    lang: 'es',
    title: 'Older Spanish article',
    bible_verse: 'El Señor es mi pastor.',
    verse_reference: 'Salmo 23:1',
    article_body: 'Una reflexión sobre el cuidado de Dios.',
    prayer: 'Señor, guíanos hoy.',
    theme: 'Guidance',
    image_url: null,
    created_at: '2020-01-01T08:00:00.000Z',
    audio_url: null
  },
  {
    id: 5,
    date: '2020-01-03',
    lang: 'en',
    title: 'English article B',
    bible_verse: 'The Lord is my shepherd.',
    verse_reference: 'Psalm 23:1',
    article_body: 'A reflection on God’s care.',
    prayer: 'Lord, guide us today.',
    theme: 'Guidance',
    image_url: 'https://example.com/b.jpg',
    created_at: '2020-01-03T08:00:00.000Z',
    audio_url: null
  },
  {
    id: 6,
    date: '2020-01-03',
    lang: 'en',
    title: 'English article A',
    bible_verse: 'The Lord is near.',
    verse_reference: 'Psalm 145:18',
    article_body: 'A reflection on God’s presence.',
    prayer: 'Lord, draw near to us.',
    theme: 'Presence',
    image_url: 'https://example.com/a.jpg',
    created_at: '2020-01-03T08:00:00.000Z',
    audio_url: null
  },
  {
    id: 3,
    date: '2999-01-01',
    lang: 'en',
    title: 'Future article',
    bible_verse: 'Future verse',
    verse_reference: 'Future 1:1',
    article_body: 'This must not appear yet.',
    prayer: 'Future prayer.',
    theme: 'Future',
    image_url: null,
    created_at: '2999-01-01T08:00:00.000Z',
    audio_url: null
  }
];

class FakeDailyBreadPool {
  constructor(rows) {
    this.rows = rows;
    this.queries = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });

    if (sql.includes('WHERE id = $1')) {
      return {
        rows: this.rows.filter(row => row.id === params[0])
      };
    }

    if (sql.includes('COUNT(*)')) {
      const [lang, today] = params;
      return {
        rows: [{
          total: this.rows.filter(row => row.lang === lang && row.date <= today).length
        }]
      };
    }

    if (sql.includes('ORDER BY date DESC, id DESC')) {
      const [lang, today, limit, offset] = params;
      const filtered = this.rows
        .filter(row => row.lang === lang && row.date <= today)
        .sort((left, right) => right.date.localeCompare(left.date) || right.id - left.id);
      return { rows: filtered.slice(offset, offset + limit) };
    }

    throw new Error(`Unexpected test query: ${sql}`);
  }
}

function makeServer(pool, generationCalls) {
  const app = express();
  app.use(express.json());
  app.use(devotionalRoutes({
    pool,
    authenticate: (req, res, next) => {
      if (req.headers.authorization !== 'Bearer test') {
        return res.status(401).json({ error: 'Authentication required' });
      }
      next();
    },
    requirePro: (req, res, next) => next(),
    requireUserSession: (req, res, next) => next(),
    generateDailyDevotional: async () => {
      generationCalls.count++;
      throw new Error('Generation should not be called by archive reads');
    }
  }));
  return app;
}

let server;
let baseUrl;
let pool;
let generationCalls;

test.before(async () => {
  pool = new FakeDailyBreadPool(SAVED_ARTICLES);
  generationCalls = { count: 0 };
  server = makeServer(pool, generationCalls).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

async function request(path, body, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    body: JSON.stringify(body)
  });
}

test('Daily Bread archive endpoints require authentication', async () => {
  for (const path of ['/getDailyDevotionalById', '/getDailyDevotionalArchive']) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 401);
  }
});

test('fetches a historical article by ID with all display fields', async () => {
  const response = await request('/getDailyDevotionalById', {
    articleId: 1,
    lang: 'en'
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    error: 0,
    result: {
      id: 1,
      date: '2020-01-02',
      lang: 'en',
      title: 'Older English article',
      bible_verse: 'Be still, and know that I am God.',
      verse_reference: 'Psalm 46:10',
      article_body: 'A reflection on quiet trust.',
      prayer: 'Lord, teach us to rest in You.',
      theme: 'Peace',
      image_url: 'https://example.com/older.jpg',
      created_at: '2020-01-02T08:00:00.000Z'
    }
  });
});

test('by-ID lookup preserves the saved language when no translation relation exists', async () => {
  const response = await request('/getDailyDevotionalById', {
    articleId: 2,
    lang: 'en'
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.result.id, 2);
  assert.equal(body.result.lang, 'es');
  assert.equal(body.result.title, 'Artículo en español');
});

test('missing historical article returns the specified 404 response', async () => {
  const response = await request('/getDailyDevotionalById', {
    articleId: 99999,
    lang: 'en'
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.deepEqual(body, {
    error: 1,
    result: null,
    message: 'Daily Bread article not found'
  });
});

test('English archive excludes future articles and orders by date then ID', async () => {
  const response = await request('/getDailyDevotionalArchive', { lang: 'en' });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.result.items.map(item => item.id), [6, 5, 1]);
  assert.equal(body.result.total, 3);
  assert.equal(body.result.limit, 30);
  assert.equal(body.result.offset, 0);
  assert.equal(body.result.has_more, false);
  assert.equal(body.result.items[0].title, 'English article A');
  assert.deepEqual(Object.keys(body.result.items[0]).sort(), [
    'created_at',
    'date',
    'id',
    'image_url',
    'lang',
    'theme',
    'title',
    'verse_reference'
  ]);
});

test('Spanish archive returns saved Spanish articles', async () => {
  const response = await request('/getDailyDevotionalArchive', {
    lang: 'es',
    limit: 100,
    offset: 0
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.result.items.map(item => item.id), [2, 4]);
  assert.equal(body.result.total, 2);
  assert.equal(body.result.has_more, false);
  assert.ok(body.result.items.every(item => item.lang === 'es'));
});

test('archive pagination reports total and has_more correctly', async () => {
  const response = await request('/getDailyDevotionalArchive', {
    lang: 'en',
    limit: 2,
    offset: 0
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.result.items.map(item => item.id), [6, 5]);
  assert.equal(body.result.total, 3);
  assert.equal(body.result.limit, 2);
  assert.equal(body.result.offset, 0);
  assert.equal(body.result.has_more, true);

  const nextResponse = await request('/getDailyDevotionalArchive', {
    lang: 'en',
    limit: 2,
    offset: 2
  });
  const nextBody = await nextResponse.json();
  assert.deepEqual(nextBody.result.items.map(item => item.id), [1]);
  assert.equal(nextBody.result.has_more, false);
});

test('empty archive is a successful response', async () => {
  const response = await request('/getDailyDevotionalArchive', {
    lang: 'es',
    offset: 100
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.result.items, []);
  assert.equal(body.result.total, 2);
  assert.equal(body.result.has_more, false);
});

test('invalid IDs, languages, limits, and offsets are rejected', async () => {
  for (const articleId of [undefined, 0, -1, 1.5, '1.5', true]) {
    const response = await request('/getDailyDevotionalById', {
      ...(articleId === undefined ? {} : { articleId }),
      lang: 'en'
    });
    assert.equal(response.status, 400, `articleId ${String(articleId)} should be rejected`);
  }

  const invalidArchives = [
    { lang: 'fr' },
    { lang: '' },
    { lang: 'en', limit: 0 },
    { lang: 'en', limit: 101 },
    { lang: 'en', limit: 1.5 },
    { lang: 'en', limit: '1.5' },
    { lang: 'en', offset: -1 },
    { lang: 'en', offset: 1.5 },
    { lang: 'en', offset: '1.5' }
  ];

  for (const body of invalidArchives) {
    const response = await request('/getDailyDevotionalArchive', body);
    assert.equal(response.status, 400, `archive input ${JSON.stringify(body)} should be rejected`);
  }
});

test('archive reads never generate or mutate Daily Bread articles', async () => {
  const queryCountBefore = pool.queries.length;

  await request('/getDailyDevotionalById', { articleId: 1, lang: 'en' });
  await request('/getDailyDevotionalArchive', { lang: 'en', limit: 1 });

  assert.equal(generationCalls.count, 0);
  assert.ok(pool.queries.length > queryCountBefore);
  assert.equal(pool.rows.length, SAVED_ARTICLES.length);
});