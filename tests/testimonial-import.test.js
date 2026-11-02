'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTestimonials, matchingRows } = require('../portfolio/testimonial-import');

const sample = `EDUCATORS & SCHOOL STAFF
1. Konstantina H.
Attribution: School Counselor
Context: Week of Respect Assembly
Quote:
“Paul!!!!!! Both impactful and lively....”

WORKSHOP & EVENT ATTENDEES
2. Kathleen McGurrin
Attribution: Human Resources, County of Monmouth
Context: Monmouth County Fall Employee Expo
Year: 2026
Quote:
“Your enthusiasm never wavered!”

3. Kathleen McGurrin
Attribution: Human Resources, County of Monmouth
Context: Monmouth County Employee Development Expo
Quote:
“It was a pleasure working with you!”
`;

test('testimonial source parsing preserves quotations, abbreviated names, groups, order and unknown dates', () => {
  const entries = parseTestimonials(sample, 3);
  assert.equal(entries[0].name, 'Konstantina H.');
  assert.equal(entries[0].quote, 'Paul!!!!!! Both impactful and lively....');
  assert.equal(entries[0].category, 'EDUCATORS & SCHOOL STAFF');
  assert.equal(entries[0].date, '');
  assert.equal(entries[1].category, 'WORKSHOP & EVENT ATTENDEES');
  assert.equal(entries[1].date, '2026');
  assert.equal(entries[1].title, 'Human Resources');
  assert.equal(entries[1].organization, 'County of Monmouth');
  assert.equal(entries[2].date, '');
});

test('testimonial reconciliation distinguishes separate events and explicitly matches the old Glenn entry', () => {
  const rows = [
    { id: 'k-original', name: 'Kathleen McGurrin', event: 'Monmouth County Employee Development Expo' },
    { id: 'g-original', name: 'Glenn Talavera', event: 'Monmouth County Employee Development Expo' }
  ];
  const entries = parseTestimonials(sample, 3);
  assert.equal(matchingRows(rows, entries[1]).length, 0);
  assert.equal(matchingRows(rows, entries[2])[0].id, 'k-original');
  assert.equal(matchingRows(rows, { name: 'Glenn Talavera',
    event: 'Monmouth County · Public Speaking & Active Listening' })[0].id, 'g-original');
});

test('malformed, duplicate, or incomplete testimonial sources fail instead of partially importing', () => {
  assert.throws(() => parseTestimonials(sample), /Expected 18/);
  assert.throws(() => parseTestimonials(sample.replace('2. Kathleen', '9. Kathleen'), 3), /order/);
  assert.throws(() => parseTestimonials(sample.replace('“Paul!!!!!!', 'Paul!!!!!!'), 3), /quoted/);
  assert.throws(() => parseTestimonials(sample.replace('Monmouth County Fall Employee Expo',
    'Monmouth County Employee Development Expo'), 3), /Duplicate source/);
});
