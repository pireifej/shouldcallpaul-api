'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const crmRoutes = require('../routes/crm');

class FakeCrmPool {
  constructor() {
    this.nextId = 1;
    this.clock = Date.parse('2026-08-21T12:00:00.000Z');
    this.notes = [];
    this.legacyData = {
      positionNotes: 'Existing job note',
      contactNotes: 'Existing contact note',
      workshopNotes: 'Existing workshop note',
      interviewPrep: 'Existing interview prep note'
    };
  }

  nextTimestamp() {
    this.clock += 1000;
    return new Date(this.clock);
  }

  row(note) {
    return {
      id: note.id,
      title: note.title,
      content: note.content,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    };
  }

  async query(sql, params = []) {
    if (sql.includes('FROM crm_global_notes') && sql.includes('ORDER BY')) {
      return {
        rows: [...this.notes]
          .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
          .map(note => this.row(note))
      };
    }

    if (sql.startsWith('INSERT INTO crm_global_notes')) {
      const now = this.nextTimestamp();
      const note = {
        id: this.nextId++,
        title: params[0],
        content: params[1],
        createdAt: now,
        updatedAt: now
      };
      this.notes.push(note);
      return { rows: [this.row(note)] };
    }

    if (sql.startsWith('UPDATE crm_global_notes')) {
      const id = params[params.length - 1];
      const note = this.notes.find(candidate => candidate.id === id);
      if (!note) return { rows: [] };

      let valueIndex = 0;
      if (sql.includes('title = $')) note.title = params[valueIndex++];
      if (sql.includes('content = $')) note.content = params[valueIndex++];
      note.updatedAt = this.nextTimestamp();
      return { rows: [this.row(note)] };
    }

    if (sql.startsWith('DELETE FROM crm_global_notes')) {
      const id = params[0];
      const index = this.notes.findIndex(note => note.id === id);
      if (index === -1) return { rows: [] };
      const [deleted] = this.notes.splice(index, 1);
      return { rows: [{ id: deleted.id }] };
    }

    throw new Error(`Unexpected test query: ${sql}`);
  }
}

function makeServer(pool) {
  const app = express();
  app.use(express.json());
  app.use(crmRoutes({
    auditPool: pool,
    authenticate: (req, res, next) => {
      if (req.headers.authorization !== 'Bearer test') {
        return res.status(401).json({ error: 'Authentication required' });
      }
      next();
    },
    openai: {}
  }));
  return app;
}

let server;
let baseUrl;
let pool;

test.before(async () => {
  pool = new FakeCrmPool();
  server = makeServer(pool).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function request(path, options = {}) {
  const headers = {
    authorization: 'Bearer test',
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {})
  };
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

test('global notes require authentication', async () => {
  const response = await fetch(`${baseUrl}/api/global-notes`);
  assert.equal(response.status, 401);
});

test('list starts empty and creation returns a trimmed title with default content', async () => {
  let response = await request('/api/global-notes');
  assert.deepEqual((await response.json()).data, []);

  response = await request('/api/global-notes', {
    method: 'POST',
    body: JSON.stringify({ title: '  DevOps  ' })
  });
  assert.equal(response.status, 200);
  const note = (await response.json()).data;
  assert.equal(note.title, 'DevOps');
  assert.equal(note.content, '');
  assert.ok(note.createdAt);
  assert.ok(note.updatedAt);
});

test('empty and overlong titles are rejected', async () => {
  for (const title of ['', '   ', 'x'.repeat(201)]) {
    const response = await request('/api/global-notes', {
      method: 'POST',
      body: JSON.stringify({ title })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  }
});

test('multiline Markdown content is preserved exactly', async () => {
  const content = '**Question**\n\n- Use *blue-green* deployment\n- Preserve this line exactly';
  const response = await request('/api/global-notes', {
    method: 'POST',
    body: JSON.stringify({ title: 'Interview', content })
  });
  assert.equal((await response.json()).data.content, content);
});

test('PATCH updates content and title independently', async () => {
  let response = await request('/api/global-notes/1', {
    method: 'PATCH',
    body: JSON.stringify({ content: 'Updated\ncontent' })
  });
  assert.equal(response.status, 200);
  let note = (await response.json()).data;
  assert.equal(note.title, 'DevOps');
  assert.equal(note.content, 'Updated\ncontent');

  response = await request('/api/global-notes/1', {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Cloud DevOps' })
  });
  assert.equal(response.status, 200);
  note = (await response.json()).data;
  assert.equal(note.title, 'Cloud DevOps');
  assert.equal(note.content, 'Updated\ncontent');
});

test('list sorts by updatedAt descending', async () => {
  const response = await request('/api/global-notes');
  const notes = (await response.json()).data;
  assert.equal(notes.length, 2);
  assert.equal(notes[0].title, 'Cloud DevOps');
  assert.ok(new Date(notes[0].updatedAt) >= new Date(notes[1].updatedAt));
});

test('PATCH validates fields, IDs, and unknown notes', async () => {
  let response = await request('/api/global-notes/1', {
    method: 'PATCH',
    body: JSON.stringify({})
  });
  assert.equal(response.status, 400);

  response = await request('/api/global-notes/not-a-number', {
    method: 'PATCH',
    body: JSON.stringify({ content: 'x' })
  });
  assert.equal(response.status, 400);

  response = await request('/api/global-notes/99999', {
    method: 'PATCH',
    body: JSON.stringify({ content: 'x' })
  });
  assert.equal(response.status, 404);
});

test('DELETE removes only the requested global note and leaves existing CRM data alone', async () => {
  const before = structuredClone(pool.legacyData);
  const response = await request('/api/global-notes/1', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { deleted_id: 1 });
  assert.deepEqual(pool.legacyData, before);

  const listResponse = await request('/api/global-notes');
  const notes = (await listResponse.json()).data;
  assert.equal(notes.some(note => note.id === 1), false);
  assert.equal(notes.length, 1);

  const missingResponse = await request('/api/global-notes/1', { method: 'DELETE' });
  assert.equal(missingResponse.status, 404);
});