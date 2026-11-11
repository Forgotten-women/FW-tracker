const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('mailer');

const { db } = require('../src/db');
const mailer = require('../src/domain/mailer');
const T = require('../src/util/time');

test.before(prepareDatabase);
test.after(dropDatabase);

async function setSetting(key, value) {
  await db.prepare(`
    INSERT INTO org_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, ?, 'test')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `).run(key, String(value), T.now());
}

async function seedEmployee({ id, name, number, workEmail, personalEmail }) {
  const now = T.now();
  await db.prepare(`
    INSERT INTO employees (id, name, role, employee_number, work_email, active, created_at, updated_at)
    VALUES (?, ?, 'Staff', ?, ?, 1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, work_email = EXCLUDED.work_email
  `).run(id, name, number, workEmail, now, now);

  if (personalEmail !== undefined) {
    await db.prepare(`
      INSERT INTO employee_personal (employee_id, personal_email, updated_at, updated_by)
      VALUES (?, ?, ?, 'test')
      ON CONFLICT (employee_id) DO UPDATE SET personal_email = EXCLUDED.personal_email
    `).run(id, personalEmail, now);
  }
}

test('normalizeRecipients parses, validates, trims, and deduplicates email addresses', () => {
  assert.deepEqual(
    mailer.normalizeRecipients('  Work@Example.com, personal@example.com ; work@example.com, invalid-email,  '),
    ['Work@Example.com', 'personal@example.com'],
  );

  assert.deepEqual(
    mailer.normalizeRecipients([null, 'a@b.org', 'A@B.ORG', 'c@d.org', 'notanemail']),
    ['a@b.org', 'c@d.org'],
  );

  assert.deepEqual(mailer.normalizeRecipients(''), []);
});

test('sendNotificationEmail delivers to both work_email and personal_email via Graph OAuth', async (t) => {
  await setSetting('email_notifications_enabled', '1');
  await setSetting('email_delivery_method', 'oauth');
  await setSetting('email_oauth_refresh_token', 'fake-refresh-token');
  await setSetting('email_oauth_access_token', 'fake-access-token');
  await setSetting('email_oauth_token_expiry', String(Date.now() + 60 * 60 * 1000));
  await setSetting('email_oauth_account_email', 'hr@forgottenwomen.org');

  await seedEmployee({
    id: 'emp_mail_both',
    name: 'Abdullah Shahid',
    number: 'PK016',
    workEmail: 'office@rethinkcharity.org.uk',
    personalEmail: 'abdullahshahid906@gmail.com',
  });

  await seedEmployee({
    id: 'emp_mail_same',
    name: 'Same Email Person',
    number: 'PK998',
    workEmail: 'same@forgottenwomen.org',
    personalEmail: 'SAME@forgottenwomen.org',
  });

  await seedEmployee({
    id: 'emp_mail_personal_only',
    name: 'Personal Only Person',
    number: 'PK999',
    workEmail: null,
    personalEmail: 'onlypersonal@gmail.com',
  });

  const capturedPayloads = [];
  const origFetch = global.fetch;
  t.after(() => {
    global.fetch = origFetch;
  });

  global.fetch = async (url, opts) => {
    if (String(url) === 'https://graph.microsoft.com/v1.0/me/sendMail') {
      capturedPayloads.push(JSON.parse(opts.body));
      return { status: 202, ok: true, text: async () => '' };
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  // 1. Both work and personal emails present -> both must be in toRecipients
  const resBoth = await mailer.sendNotificationEmail({
    employeeId: 'emp_mail_both',
    category: 'WARNING',
    title: 'Late Arrival Warning',
    body: 'Please arrive on time.',
    severity: 'warning',
  });
  assert.equal(resBoth.sent, true);
  assert.deepEqual(resBoth.recipients, [
    'office@rethinkcharity.org.uk',
    'abdullahshahid906@gmail.com',
  ]);
  assert.equal(capturedPayloads.length, 1);
  assert.deepEqual(
    capturedPayloads[0].message.toRecipients.map(r => r.emailAddress.address),
    ['office@rethinkcharity.org.uk', 'abdullahshahid906@gmail.com'],
  );

  // 2. Identical work and personal emails -> deduplicated to 1 recipient
  const resSame = await mailer.sendNotificationEmail({
    employeeId: 'emp_mail_same',
    category: 'LEAVE',
    title: 'Leave Approved',
    body: 'Your leave has been approved.',
    severity: 'info',
  });
  assert.equal(resSame.sent, true);
  assert.deepEqual(resSame.recipients, ['same@forgottenwomen.org']);

  // 3. Only personal email present -> delivered to personal email
  const resPersonalOnly = await mailer.sendNotificationEmail({
    employeeId: 'emp_mail_personal_only',
    category: 'DOCUMENT',
    title: 'Document Verified',
    body: 'Your CNIC document was verified.',
    severity: 'info',
  });
  assert.equal(resPersonalOnly.sent, true);
  assert.deepEqual(resPersonalOnly.recipients, ['onlypersonal@gmail.com']);

  // 4. testConnection supports employeeId to test both work & personal emails
  const resTestEmp = await mailer.testConnection({ employeeId: 'emp_mail_both' });
  assert.equal(resTestEmp.status, 'SUCCESS');
  assert.deepEqual(resTestEmp.recipients, [
    'office@rethinkcharity.org.uk',
    'abdullahshahid906@gmail.com',
  ]);
});
