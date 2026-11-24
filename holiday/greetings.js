'use strict';
const { fail, contactId, text, template } = require('./security');

const OCCASIONS = ['thanksgiving', 'christmas', 'easter', 'new_year', 'custom'];
const OCCASION_LABELS = { thanksgiving: 'Thanksgiving', christmas: 'Christmas',
  easter: 'Easter', new_year: 'New Year' };
function version(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('VERSION_REQUIRED');
  return value;
}
function only(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(key => !keys.includes(key))) throw fail('INVALID_FIELDS');
}
function occasion(input) {
  if (!OCCASIONS.includes(input.occasion)) throw fail('INVALID_OCCASION');
  const customOccasionLabel = input.occasion === 'custom' ? text(input.customOccasionLabel, 200).trim() : null;
  if (input.occasion === 'custom' && !customOccasionLabel) throw fail('CUSTOM_OCCASION_LABEL_REQUIRED');
  return { occasion: input.occasion, customOccasionLabel };
}
function choosePhone(contact, requested) {
  const numbers = contact.phoneNumbers.map(p => p.canonicalNumber || p.value).filter(Boolean);
  const unique = [...new Set(numbers)];
  if (!unique.length) throw fail('CONTACT_HAS_NO_PHONE', 409);
  if (requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string' || !unique.includes(requested)) throw fail('CONTACT_PHONE_CHANGED', 409);
    return requested;
  }
  if (unique.length !== 1) throw fail('PHONE_SELECTION_REQUIRED');
  return unique[0];
}
function preference(input) {
  only(input, ['resourceName', 'version', 'greetingName', 'familyMode', 'familyCustom',
    'preferredPhoneNumber', 'personalNote', 'occasions']);
  const data = {
    greetingName: text(input.greetingName ?? '', 200),
    familyMode: input.familyMode ?? 'off',
    familyCustom: text(input.familyCustom ?? '', 500),
    preferredPhoneNumber: input.preferredPhoneNumber ?? null,
    personalNote: text(input.personalNote ?? '', 2000),
    occasions: input.occasions ?? {}
  };
  if (!['off', 'family', 'custom'].includes(data.familyMode) ||
    (data.familyMode === 'custom' && !data.familyCustom.trim())) throw fail('INVALID_FAMILY_WORDING');
  if (data.preferredPhoneNumber !== null) text(data.preferredPhoneNumber, 200);
  if (!data.occasions || typeof data.occasions !== 'object' || Array.isArray(data.occasions) ||
    Object.keys(data.occasions).length > 100) throw fail('INVALID_OCCASION_PREFERENCES');
  for (const [key, value] of Object.entries(data.occasions)) {
    if ((!OCCASIONS.includes(key) && !/^custom:.{1,200}$/.test(key)) ||
      !['ask', 'opt_in', 'opt_out'].includes(value)) throw fail('INVALID_OCCASION_PREFERENCES');
  }
  return data;
}
class Greetings {
  constructor(store, google) { this.store = store; this.google = google; }
  async contact(subject, resourceName) {
    const token = await this.store.accessToken(subject, this.google);
    return this.google.get(token, contactId(resourceName));
  }
  async savePreference(subject, input) {
    const data = preference(input);
    const resource = contactId(input.resourceName), expected = version(input.version);
    const contact = await this.contact(subject, resource);
    if (data.preferredPhoneNumber !== null) choosePhone(contact, data.preferredPhoneNumber);
    return this.store.savePreference(subject, resource, expected, data);
  }
  async createBatch(subject, input) {
    only(input, ['occasion', 'customOccasionLabel', 'baseTemplate', 'recipients']);
    const data = { ...occasion(input), baseTemplate: text(input.baseTemplate, 10000), queuePosition: 0 };
    template(data.baseTemplate, {});
    if (!Array.isArray(input.recipients) || !input.recipients.length || input.recipients.length > 200) {
      throw fail('EXPLICIT_RECIPIENTS_REQUIRED');
    }
    const preferences = new Map((await this.store.preferences(subject)).map(p => [p.resourceName, p]));
    const seen = new Set(), drafts = [];
    for (const recipient of input.recipients) {
      only(recipient, ['resourceName', 'phoneNumber', 'message', 'confirmedForOccasion']);
      const resourceName = contactId(recipient.resourceName);
      if (seen.has(resourceName)) throw fail('DUPLICATE_RECIPIENT');
      seen.add(resourceName);
      const pref = preferences.get(resourceName);
      const occasionKey = data.occasion === 'custom' ? `custom:${data.customOccasionLabel}` : data.occasion;
      const decision = pref?.occasions?.[occasionKey] || 'ask';
      if (decision === 'opt_out') throw fail('CONTACT_OCCASION_OPTED_OUT', 409);
      if (decision === 'ask' && recipient.confirmedForOccasion !== true) {
        throw fail('OCCASION_CONFIRMATION_REQUIRED');
      }
      const contact = await this.contact(subject, resourceName);
      const phoneNumber = choosePhone(contact, recipient.phoneNumber ?? pref?.preferredPhoneNumber);
      const message = recipient.message === undefined ? template(data.baseTemplate, {
        name: pref?.greetingName || contact.givenName || contact.displayName,
        family: pref?.familyMode === 'family' ? 'you and your family' :
          pref?.familyMode === 'custom' ? pref.familyCustom : '',
        occasion: data.customOccasionLabel || OCCASION_LABELS[data.occasion],
        note: pref?.personalNote || ''
      }) : text(recipient.message, 20000);
      drafts.push({ resourceName, displayName: contact.displayName, phoneNumber, message, state: 'draft' });
    }
    return this.store.createBatch(subject, data, drafts);
  }
  async patchBatch(subject, id, input) {
    only(input, ['version', 'occasion', 'customOccasionLabel', 'baseTemplate', 'queuePosition']);
    return this.store.changeBatch(subject, id, version(input.version), batch => {
      if (input.occasion !== undefined || input.customOccasionLabel !== undefined) {
        Object.assign(batch, occasion({ occasion: input.occasion ?? batch.occasion,
          customOccasionLabel: input.customOccasionLabel ?? batch.customOccasionLabel }));
      }
      if (input.baseTemplate !== undefined) {
        template(input.baseTemplate, {}); batch.baseTemplate = input.baseTemplate;
      }
      if (input.queuePosition !== undefined) {
        if (!Number.isSafeInteger(input.queuePosition) || input.queuePosition < 0 ||
          input.queuePosition > batch.drafts.length) throw fail('INVALID_QUEUE_POSITION');
        batch.queuePosition = input.queuePosition;
      }
      // Editing a reusable template never overwrites individually edited drafts.
    });
  }
  async patchDraft(subject, id, draftId, input, action = 'edit') {
    only(input, action === 'sent' ? ['version', 'confirmed'] :
      ['version', 'message', 'phoneNumber', 'state', 'queuePosition']);
    if (action === 'sent' && input.confirmed !== true) throw fail('MANUAL_CONFIRMATION_REQUIRED');
    // Load contact before taking the versioned write lock; recheck version within it.
    let contact;
    if (action === 'opened' || input.phoneNumber !== undefined) {
      const before = await this.store.batch(subject, id);
      if (before.version !== version(input.version)) throw fail('VERSION_CONFLICT', 409);
      const draft = before.drafts.find(d => d.id === draftId);
      if (!draft) throw fail('DRAFT_NOT_FOUND', 404);
      contact = await this.contact(subject, draft.resourceName);
    }
    return this.store.changeBatch(subject, id, version(input.version), batch => {
      const draft = batch.drafts.find(d => d.id === draftId);
      if (!draft) throw fail('DRAFT_NOT_FOUND', 404);
      if (input.message !== undefined) draft.message = text(input.message, 20000);
      if (input.phoneNumber !== undefined) draft.phoneNumber = choosePhone(contact, input.phoneNumber);
      if (input.queuePosition !== undefined) {
        if (!Number.isSafeInteger(input.queuePosition) || input.queuePosition < 0 ||
          input.queuePosition > batch.drafts.length) throw fail('INVALID_QUEUE_POSITION');
        batch.queuePosition = input.queuePosition;
      }
      if (action === 'opened') {
        // Confirm saved number still exists; never silently fall back to another.
        choosePhone(contact, draft.phoneNumber);
        if (input.state !== undefined) throw fail('INVALID_DRAFT_STATE');
        draft.state = 'opened_in_messages';
        draft.openedAt = new Date().toISOString();
        return { handoff: { phoneNumber: draft.phoneNumber, message: draft.message } };
      }
      if (action === 'sent') {
        draft.state = 'manually_marked_sent';
        draft.manuallyMarkedSentAt = new Date().toISOString();
      } else if (input.state !== undefined) {
        if (!['draft', 'skipped'].includes(input.state)) throw fail('INVALID_DRAFT_STATE');
        draft.state = input.state;
      }
    });
  }
}
module.exports = { Greetings, version, choosePhone, preference, occasion };
