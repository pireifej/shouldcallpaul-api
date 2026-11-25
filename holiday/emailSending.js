'use strict';
const { fail, cookieToken } = require('./security');
const { chooseEmail, emailContent } = require('./email');
const { version } = require('./greetings');

function publicAttempt(attempt) {
  return { id: attempt.id, state: attempt.state, acceptedByGmail: attempt.state === 'accepted',
    deliveryConfirmed: false,
    requiresReview: ['sending', 'unknown'].includes(attempt.state) };
}

class EmailSending {
  constructor(store, google) { this.store = store; this.google = google; }
  async send(subject, batchId, draftId, input, request) {
    if (!input || Object.keys(input).some(k => !['version', 'attemptId', 'confirmed'].includes(k))) {
      throw fail('INVALID_FIELDS');
    }
    version(input.version);
    if (input.confirmed !== true) throw fail('EMAIL_SEND_CONFIRMATION_REQUIRED');
    if (typeof input.attemptId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.attemptId)) {
      throw fail('INVALID_SEND_ATTEMPT_ID');
    }
    const previous = await this.store.emailAttempt(subject, input.attemptId);
    if (previous) {
      if (previous.batch_id !== batchId || previous.draft_id !== draftId) throw fail('SEND_ATTEMPT_CONFLICT', 409);
      return { attempt: publicAttempt(previous), replay: true };
    }
    const before = await this.store.batch(subject, batchId);
    if (before.version !== input.version) throw fail('VERSION_CONFLICT', 409);
    const snapshot = before.drafts.find(d => d.id === draftId);
    if (!snapshot) throw fail('DRAFT_NOT_FOUND', 404);
    if (snapshot.method !== 'email') throw fail('EMAIL_DRAFT_REQUIRED');
    const token = await this.store.accessToken(subject, this.google, { requireEmail: true });
    const contact = await this.google.get(token, snapshot.resourceName);
    chooseEmail(contact, snapshot.emailAddress);
    emailContent(snapshot.subject, snapshot.message);
    const claim = await this.store.beginEmailSend(subject, batchId, draftId,
      input.version, input.attemptId, async (draft, client) => {
        // Recheck the durable owner/browser session at final send authorization.
        const session = await this.store.session(cookieToken(request), client);
        if (session?.owner_sub !== subject) throw fail('OWNER_SESSION_REQUIRED', 401);
        const owner = await this.store.owner(subject, client);
        if (!owner.connected) throw fail('GOOGLE_RECONNECT_REQUIRED', 409);
        chooseEmail(contact, draft.emailAddress);
        emailContent(draft.subject, draft.message);
        const pref = (await this.store.preferences(subject, client)).find(p => p.resourceName === draft.resourceName);
        if (pref?.selected === false) throw fail('CONTACT_NOT_SELECTED', 409);
        const batch = await this.store.batch(subject, batchId, client);
        const key = batch.occasion === 'custom' ? `custom:${batch.customOccasionLabel}` : batch.occasion;
        if (pref?.occasions?.[key] === 'opt_out') throw fail('CONTACT_OCCASION_OPTED_OUT', 409);
      });
    if (claim.replay) return { attempt: publicAttempt(claim.attempt), replay: true };
    let state, messageId = null;
    try {
      const result = await this.google.sendEmail(token, {
        to: claim.draft.emailAddress, subject: claim.draft.subject, message: claim.draft.message
      });
      state = 'accepted'; messageId = result.messageId;
    } catch (error) { state = error.code === 'EMAIL_REJECTED' ? 'rejected' : 'unknown'; }
    try {
      const attempt = await this.store.finishEmailSend(subject, batchId, draftId, input.attemptId, state, messageId);
      return { attempt: publicAttempt(attempt), replay: false };
    } catch {
      // Claim was committed before the network call. Never retry on persistence failure.
      throw fail('EMAIL_OUTCOME_UNKNOWN', 409);
    }
  }
}
module.exports = { EmailSending, publicAttempt };
