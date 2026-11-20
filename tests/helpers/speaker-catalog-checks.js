'use strict';
const assert = require('node:assert/strict');
const catalog = require('../../portfolio/speaker-catalog');
const { transaction, saveEntry, readSpeakerMenu } = require('../../portfolio/store');

module.exports = async ({t,pool,api,request}) => {
  const feed = async () => (await request('/speaker/speaker_menu')).body.categories.flatMap(c => c.items);
  let first, second, topicId;
  await t.test('inline creation is atomic, private-copy safe, and immediately eligible only when public and complete', async () => {
    const before = (await api('/api/resume/workshops')).length;
    const invalid = await request('/api/resume/workshops','POST',{
      entry:{label:'Private Client Symposium'},published:true,completion_status:'complete',
      catalog:{new_topics:[{title:'Unsafe',description:'Private Client Symposium',category_id:'ai_technology'}]}
    });
    assert.equal(invalid.status,400);
    assert.equal((await api('/api/resume/workshops')).length,before);
    first = await api('/api/resume/workshops','POST',{
      entry:{label:'Acme Venue November Session',desc:'SECRET client logistics and fees',details:{location:'Private Venue'}},
      published:true,completion_status:'complete',
      catalog:{new_topics:[{title:'Responsible Career Tools',description:'Use AI responsibly to organize authentic experience.',
        category_id:'ai_technology',public_copy_confirmed:true}]}
    });
    topicId = first.catalog.topic_ids[0];
    assert.equal(first.completion_status,'complete');
    const item = (await feed()).find(i => i.id === topicId);
    assert.deepEqual(Object.keys(item).sort(),['description','id','title','type']);
    assert.ok(!JSON.stringify(item).includes('Acme'));
    assert.ok(!JSON.stringify(item).includes('SECRET'));
    assert.equal((await feed()).filter(i => i.id === topicId).length,1);
    assert.ok(!(await request('/resume/workshops')).body.records.find(r => r.id === first.id).catalog);
  });
  await t.test('repeated deliveries, title normalization, imports and repeated saves reuse permanent topics', async () => {
    second = await api('/api/resume/workshops','POST',{
      entry:{label:'  RESPONSIBLE Career Tools!! ',details:{location:'Other Venue'}},published:true,completion_status:'complete'
    });
    assert.deepEqual(second.catalog.topic_ids,[topicId]);
    await api(`/api/resume/workshops/${second.id}`,'PATCH',{entry:{desc:'Correction'}});
    assert.equal((await feed()).filter(i => i.id === topicId).length,1);
    const imported = await transaction(pool,db => saveEntry(db,'workshops',{
      entry:{label:'Responsible Career Tools'},published:true
    },null,{imported:true}));
    assert.equal(imported.completion_status,'complete');
    assert.deepEqual(imported.catalog.topic_ids,[topicId]);
    await api(`/api/resume/workshops/${imported.id}`,'DELETE');
  });
  await t.test('draft, scheduled, cancelled, unpublished and private CRM records cannot make offerings eligible', async () => {
    const topic = await api('/api/speaker-menu/topics','POST',{
      id:'not-delivered-topic',category_id:'ai_technology',published:true,
      content:{title:'Undelivered Topic',description:'Reusable description',type:'workshop'},public_copy_confirmed:true
    });
    for (const state of ['draft','scheduled','cancelled']) {
      const draft = await api('/api/resume/workshops','POST',{
        entry:{label:'Undelivered Topic',details:{date:'December 31, 2099'}},published:true,completion_status:state
      });
      assert.ok(!(await feed()).some(i => i.id === topic.id));
      await api(`/api/resume/workshops/${draft.id}`,'DELETE');
    }
    const defaultDraft = await api('/api/resume/workshops','POST',{entry:{label:'Undelivered Topic'},published:true});
    assert.equal(defaultDraft.completion_status,'draft');
    assert.ok(!(await feed()).some(i => i.id === topic.id));
    await api(`/api/resume/workshops/${defaultDraft.id}`,'PATCH',{published:false,completion_status:'complete'});
    await api('/api/workshops','POST',{organization_name:'Private client',workshop_title:'Undelivered Topic',status:'Complete'});
    assert.ok(!(await feed()).some(i => i.id === topic.id));
    await api(`/api/resume/workshops/${defaultDraft.id}`,'DELETE');
  });
  await t.test('manual hidden, archived, topic publication and category publication overrides survive reconciliation', async () => {
    for (const flag of ['catalog_hidden','archived']) {
      await api(`/api/speaker-menu/topics/${topicId}`,'PATCH',{[flag]:true});
      await api(`/api/resume/workshops/${first.id}`,'PATCH',{entry:{desc:'Edited again'}});
      assert.ok(!(await feed()).some(i => i.id === topicId));
      await api(`/api/speaker-menu/topics/${topicId}`,'PATCH',{[flag]:false});
      assert.ok((await feed()).some(i => i.id === topicId));
    }
    await api(`/api/speaker-menu/topics/${topicId}`,'PATCH',{published:false});
    await api(`/api/resume/workshops/${first.id}`,'PATCH',{completion_status:'complete'});
    assert.ok(!(await feed()).some(i => i.id === topicId));
    await api(`/api/speaker-menu/topics/${topicId}`,'PATCH',{published:true});
    await api('/api/speaker-menu/categories/ai_technology','PATCH',{published:false});
    assert.ok(!(await request('/speaker/speaker_menu')).body.categories.some(c => c.id === 'ai_technology'));
    await api('/api/speaker-menu/categories/ai_technology','PATCH',{published:true});
  });
  await t.test('unpublishing, correction, status changes and deleting the last delivery immediately remove eligibility', async () => {
    await api(`/api/resume/workshops/${first.id}`,'PATCH',{published:false});
    assert.ok((await feed()).some(i => i.id === topicId));
    await api(`/api/resume/workshops/${second.id}`,'PATCH',{entry:{label:'An Unmatched Corrected Subject'}});
    assert.ok(!(await feed()).some(i => i.id === topicId));
    await api(`/api/resume/workshops/${first.id}`,'PATCH',{published:true,completion_status:'cancelled'});
    assert.ok(!(await feed()).some(i => i.id === topicId));
    await api(`/api/resume/workshops/${first.id}`,'PATCH',{completion_status:'complete'});
    assert.ok((await feed()).some(i => i.id === topicId));
    await api(`/api/resume/workshops/${first.id}`,'DELETE');
    assert.ok(!(await feed()).some(i => i.id === topicId));
    assert.ok((await api('/api/speaker-menu')).topics.some(i => i.id === topicId));
  });
  await t.test('ambiguity needs an explicit decision; remembered multi-topic mappings apply to later identical records', async () => {
    for (const id of ['alpha-offering','beta-offering']) await api('/api/speaker-menu/topics','POST',{
      id,category_id:'public_speaking',published:true,
      content:{title:id,description:'Client-neutral communication skills',type:'workshop'},
      aliases:['Combined Training'],public_copy_confirmed:true
    });
    const ambiguous = await api('/api/speaker-menu/catalog-suggestions?title=Combined%20Training');
    assert.equal(ambiguous.state,'ambiguous');
    assert.equal(ambiguous.candidates.length,2);
    const needsReview = await api('/api/resume/workshops','POST',{entry:{label:'Combined Training'},published:true,completion_status:'complete'});
    assert.deepEqual(needsReview.catalog.topic_ids,[]);
    assert.ok((await api('/api/speaker-menu/catalog-review')).needs_review.some(r => r.id === needsReview.id));
    await api(`/api/resume/workshops/${needsReview.id}`,'PATCH',{catalog:{topic_ids:['alpha-offering','beta-offering']}});
    const next = await api('/api/resume/workshops','POST',{entry:{label:'COMBINED TRAINING!'},published:true,completion_status:'complete'});
    assert.deepEqual(next.catalog.topic_ids,['alpha-offering','beta-offering']);
    await api(`/api/resume/workshops/${next.id}`,'PATCH',{catalog:{topic_ids:[]}});
    await api(`/api/resume/workshops/${next.id}`,'PATCH',{entry:{desc:'Do not undo explicit unlink'}});
    assert.deepEqual((await api(`/api/resume/workshops/${next.id}`)).catalog.topic_ids,[]);
    const bad = await request(`/api/resume/workshops/${needsReview.id}`,'PATCH',{
      entry:{label:'Must Roll Back'},catalog:{topic_ids:['unknown']}
    });
    assert.equal(bad.status,400);
    assert.equal((await api(`/api/resume/workshops/${needsReview.id}`)).entry.label,'Combined Training');
  });
  await t.test('initial cleanup preserves stable IDs, archives proposed topics and is idempotent', async () => {
    const menu = await api('/api/speaker-menu');
    const career = menu.topics.find(t => t.id === 'ai_career_search');
    assert.equal(career.content.title,'AI & the Modern Career');
    assert.ok(!career.content.description.includes('RPI'));
    for (const id of ['no_code_app_building','parents_guide_ai_safety','parents_guide_ai_homework']) {
      assert.equal(menu.topics.find(t => t.id === id).archived,true);
      assert.ok(!(await feed()).some(t => t.id === id));
    }
    const delivery = await api('/api/resume/workshops','POST',{
      entry:{label:'AI & The Modern Career: Navigating Hiring Tech and Elevating Your Search'},published:true,completion_status:'complete'
    });
    assert.deepEqual(delivery.catalog.topic_ids,['ai_career_search']);
    assert.equal((await feed()).filter(i => i.id === 'ai_career_search').length,1);
    const snapshot = await api('/api/speaker-menu');
    await transaction(pool,db => catalog.initialize(db));
    assert.deepEqual(await api('/api/speaker-menu'),snapshot);
  });
  await t.test('public reads use SELECT only, preserve aliases, omit empty categories and have no backend cache', async () => {
    const readOnly = {query(sql,params) {assert.match(sql.trim(),/^SELECT\b/);return pool.query(sql,params);}};
    const expected = await readSpeakerMenu(readOnly);
    for (const url of ['/speaker/speaker_menu','/speaker/speaker_menu.json','/speaker_data/speaker_menu.json']) {
      assert.deepEqual((await request(url)).body,expected);
    }
    assert.ok(expected.categories.every(c => c.items.length));
    for (const url of ['/api/speaker-menu/catalog-review','/api/speaker-menu/catalog-suggestions?title=AI']) {
      assert.equal((await request(url,'GET',undefined,false)).status,401);
    }
    assert.equal((await request(`/api/resume/workshops/${second.id}`,'PATCH',{completion_status:'future-ish'})).status,400);
  });
};
