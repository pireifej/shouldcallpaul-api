'use strict';

// Verified, already-completed public history. Never infer completion from dates
// or copy a CRM record. IDs absent from a database are simply not updated.
const verifiedCompletedIds = [
  'd73eab9e-bc18-4914-8c26-c2d138003e44', 'e7789f1a-6137-4ee4-8cf4-a419299fbf94',
  'ad177f44-9344-492a-bb41-a1ccb1a77d26', 'aa108100-d012-4e30-aff2-e75bfebcf3d7',
  '12436371-6b4c-4924-9525-f66c342c3856', '9662efc7-02fb-477f-a054-0b7fa8155aea',
  'c3c6cba3-8de0-45d4-8e5b-584275ab338c', '77bdc757-8ca3-41c1-89c9-7a4705748bd9',
  '955f14ba-3478-4bec-8476-69b523e5784f', '8aa9d977-20d2-4363-8a54-40e143e0a4cb',
  '1a08f12e-c994-4759-a439-f95debafd7ed', '9bd4eb04-a4c4-4d39-a5df-ef307c918813',
  '2af7b521-cce2-4847-9bbf-321455e58e43', '8bf03309-fe1d-46c3-b453-236d4c335319',
  '0fb35ab2-2757-4663-a60e-431c98f60578', '0df76f68-4872-4481-8ef3-62cd3c47c820',
  '0d26a371-4741-495b-8338-c1df0ce0ca21', '8619409e-a35e-406d-bf37-3d6be057150f',
  'e2815940-466e-4802-b6a4-1b4b759e7d52', '648b6735-a58d-4513-b4e6-814ce53919f7',
  '7b36afe9-b2d6-4ce0-ad60-b9b4760bb95e', '666b0263-8b77-40cb-9ac4-2ac1e3541b7c',
  'a6882b3c-e2e9-41c7-a3f3-b779fe01117d', '63399dd0-99ee-4c41-94a9-371187ba0dc0',
  'd2ac0965-1364-427d-9b53-b31fe27400bc', 'b8e969ea-c5ab-4d89-a535-bfe67014e8de',
  'f5d167d1-ba3f-42b0-9f52-67b8e7821b8f', '176649b2-e946-4482-83c6-df23b83cd5ac',
  'bdf17152-5fc4-4875-ac6b-fc65eb194649', 'f6a1ed72-fc62-4c96-8f3b-7ddb97ce9181',
  '37fb0da2-dae9-45ed-b700-292d9fa597ff', '4fa998ed-b121-4c89-bee3-94d255e38859',
  'c8dae0cc-59aa-4595-b17e-a8df53128261', 'd68334d1-edbb-4c22-9a7a-9f10cc621f42',
  '9b2e295b-0c1d-433e-ac14-7482e3a86398'
];
const career = {
  id: 'ai_career_search',
  oldTitle: 'AI Career Search & ATS Optimization',
  title: 'AI & the Modern Career',
  description: 'Understand AI-assisted hiring and use Gemini and NotebookLM to organize your career experience, tailor applications without inventing qualifications, and discover relevant job opportunities.'
};
const archive = [
  ['no_code_app_building', 'No-Code App Building'],
  ['parents_guide_ai_safety', "The Parent's Guide to AI Safety"],
  ['parents_guide_ai_homework', "The Parent's Guide to AI Homework Companions"]
];
// Only direct wording variants. Do not strip venue/client suffixes or infer
// equivalence for generic event labels, combined subjects, or broad categories.
const aliases = {
  ai_career_search: ['AI & The Modern Career: Navigating Hiring Tech and Elevating Your Search'],
  find_your_voice: ['Speak So Others Will Listen', 'Find Your Voice / Speak So Others Will Listen']
};
module.exports = { verifiedCompletedIds, career, archive, aliases };
