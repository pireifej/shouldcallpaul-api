'use strict';
const { fail, text } = require('./security');

// One plain address only, never a display-name/address-list/header value.
function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value) ||
      /[\r\n,;<>]/.test(value)) throw fail('INVALID_EMAIL_ADDRESS');
  return value;
}
function chooseEmail(contact, requested) {
  const values = [...new Set((contact.emailAddresses || []).map(e => e.value).filter(Boolean))];
  if (!values.length) throw fail('CONTACT_HAS_NO_EMAIL', 409);
  if (typeof requested !== 'string' || !values.includes(requested)) {
    throw fail(requested ? 'CONTACT_EMAIL_CHANGED' : 'EMAIL_SELECTION_REQUIRED', requested ? 409 : 400);
  }
  return emailAddress(requested);
}
function emailContent(subject, message) {
  text(subject, 500); text(message, 20000);
  if (!subject.trim() || /[\r\n\x00-\x1f\x7f]/.test(subject)) throw fail('INVALID_EMAIL_SUBJECT');
  if (!message.trim() || message.includes('\0')) throw fail('INVALID_EMAIL_BODY');
  return { subject, message };
}
function mimeMessage({ from, to, subject, message }) {
  emailAddress(from); emailAddress(to); emailContent(subject, message);
  // Base64 transfer encoding keeps body text from ever becoming MIME headers.
  const chunks = [];
  let chunk = '';
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 36) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  const subjectLines = chunks.map(part => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
  const body = Buffer.from(message, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
  return Buffer.from([
    `From: ${from}`, `To: ${to}`, `Subject: ${subjectLines}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body
  ].join('\r\n')).toString('base64url');
}
module.exports = { emailAddress, chooseEmail, emailContent, mimeMessage };
