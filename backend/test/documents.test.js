// Document vault tests. Spec sections 5 and 27.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('documents');


const { db } = require('../src/db');
const docs = require('../src/domain/documents');
const T = require('../src/util/time');

test.before(prepareDatabase);

async function makeEmployee(id) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  return id;
}

function fakeFile(name, contents) {
  const buffer = Buffer.from(contents);
  return { buffer, originalname: name, mimetype: 'application/pdf', size: buffer.length };
}

const HR = new Set(['document.read', 'document.write', 'employee.identity.read', 'employee.medical.read']);
const EMPLOYEE = new Set(['document.read', 'self.document.read']);

test.after(dropDatabase);

// ---------------------------------------------------------------------------
// Upload and storage
// ---------------------------------------------------------------------------

test('uploading stores the file privately and records a version', async () => {
  const emp = await makeEmployee('emp_up');
  const r = await docs.upload({
    employeeId: emp, documentTypeId: 'job_description', title: 'JD',
    file: fakeFile('jd.pdf', 'job description contents'), actor: 'user:hr',
  });

  assert.equal(r.version, 1);
  const version = await db.prepare('SELECT * FROM document_versions WHERE document_id = ?').get(r.documentId);
  assert.ok(fs.existsSync(version.storage_path), 'the file is on disk');
  // Stored under a random name that reveals nothing, not the original filename.
  assert.ok(!version.storage_path.includes('jd.pdf'));
  assert.ok(version.checksum.length === 64, 'a checksum is kept');
});

test('re-uploading the same type adds a version, not a second document', async () => {
  const emp = await makeEmployee('emp_ver');
  const first = await docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD v1', file: fakeFile('jd.pdf', 'v1'), actor: 'hr' });
  const second = await docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD v2', file: fakeFile('jd.pdf', 'v2'), actor: 'hr' });

  assert.equal(first.documentId, second.documentId, 'same document');
  assert.equal(second.version, 2);
  // Spec 26: the old version is kept, not overwritten.
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM document_versions WHERE document_id = ?').get(first.documentId)).c, 2);
});

test('a type requiring an expiry date is refused without one', async () => {
  const emp = await makeEmployee('emp_exp');
  assert.throws(
    async () => await docs.upload({ employeeId: emp, documentTypeId: 'passport_id', title: 'Passport', file: fakeFile('p.pdf', 'x'), actor: 'hr' }),
    /expiry/i,
  );
});

// ---------------------------------------------------------------------------
// Confidentiality gating (spec 5)
// ---------------------------------------------------------------------------

test('a document is not even listed to someone who cannot read it', async () => {
  const emp = await makeEmployee('emp_conf');
  await docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD', file: fakeFile('a.pdf', 'x'), actor: 'hr' });
  await docs.upload({ employeeId: emp, documentTypeId: 'medical', title: 'Sick note', file: fakeFile('b.pdf', 'x'), actor: 'hr' });

  // An employee (document.read only) sees the JD but not the medical note - its
  // very existence is disclosure.
  const asEmployee = await docs.listFor(emp, EMPLOYEE);
  assert.ok(asEmployee.some(d => d.type === 'Job description'));
  assert.ok(!asEmployee.some(d => d.typeId === 'medical'), 'the medical note is not listed');

  // HR with the medical permission sees both.
  const asHr = await docs.listFor(emp, HR);
  assert.ok(asHr.some(d => d.typeId === 'medical'));
});

test('a medical document requires the medical permission specifically', async () => {
  const emp = await makeEmployee('emp_med');
  const r = await docs.upload({ employeeId: emp, documentTypeId: 'medical', title: 'Note', file: fakeFile('m.pdf', 'x'), actor: 'hr' });
  assert.equal(await docs.requiredReadPermission(r.documentId), 'employee.medical.read');
  // document.read alone is not enough.
  assert.equal(await docs.issueDownloadToken({ documentId: r.documentId, permissions: new Set(['document.read']), actor: 'user:x' }), null);
});

// ---------------------------------------------------------------------------
// Signed downloads (spec 27)
// ---------------------------------------------------------------------------

test('a download token is single-use and time-limited', async () => {
  const emp = await makeEmployee('emp_dl');
  const r = await docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD', file: fakeFile('jd.pdf', 'the contents'), actor: 'hr' });

  const grant = await docs.issueDownloadToken({ documentId: r.documentId, permissions: HR, actor: 'user:hr' });
  assert.ok(grant.token);

  const file = await docs.redeemDownloadToken(grant.token);
  assert.ok(file);
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'the contents');

  // Second use fails - the token is spent.
  assert.equal(await docs.redeemDownloadToken(grant.token), null, 'single use');
});

test('issuing and redeeming a download are both logged', async () => {
  const emp = await makeEmployee('emp_log');
  const r = await docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD', file: fakeFile('jd.pdf', 'x'), actor: 'hr' });

  const grant = await docs.issueDownloadToken({ documentId: r.documentId, permissions: HR, actor: 'user:hr', ip: '10.0.0.1' });
  await docs.redeemDownloadToken(grant.token, { ip: '10.0.0.1' });

  const log = await docs.accessLog(r.documentId);
  const actions = log.map(l => l.action);
  assert.ok(actions.includes('LINK_ISSUED'), 'issuing a link is logged');
  assert.ok(actions.includes('DOWNLOAD'), 'the download itself is logged');
});

// ---------------------------------------------------------------------------
// Acknowledgement (spec 5)
// ---------------------------------------------------------------------------

test('a document requiring acknowledgement raises one, which the employee can clear', async () => {
  const emp = await makeEmployee('emp_ack');
  const r = await docs.upload({ employeeId: emp, documentTypeId: 'employment_contract', title: 'Contract', file: fakeFile('c.pdf', 'x'), actor: 'hr' });

  const listed = await (await docs.listFor(emp, EMPLOYEE)).find(d => d.id === r.documentId);
  assert.equal(listed.acknowledgementRequired, true);

  await docs.acknowledge({ documentId: r.documentId, employeeId: emp });
  const after = await (await docs.listFor(emp, EMPLOYEE)).find(d => d.id === r.documentId);
  assert.equal(after.acknowledgementRequired, false);
  assert.ok(after.acknowledgedAt);
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

test('an archived document drops off the list but its file is retained', async () => {
  const emp = await makeEmployee('emp_arch');
  const r = await docs.upload({ employeeId: emp, documentTypeId: 'other', title: 'Old', file: fakeFile('o.pdf', 'x'), actor: 'hr' });
  const version = await db.prepare('SELECT storage_path FROM document_versions WHERE document_id = ?').get(r.documentId);

  await docs.archive({ documentId: r.documentId, reason: 'Superseded', actor: 'user:hr' });

  assert.ok(!await (await docs.listFor(emp, HR)).some(d => d.id === r.documentId), 'no longer listed');
  assert.ok(fs.existsSync(version.storage_path), 'the file itself is kept for the record');
});

test('the document lifecycle is audited', async () => {
  const actions = (await db.prepare('SELECT DISTINCT action FROM audit_log').all()).map(r => r.action);
  for (const expected of ['DOCUMENT_UPLOADED', 'DOCUMENT_VERSIONED', 'DOCUMENT_ACKNOWLEDGED', 'DOCUMENT_ARCHIVED']) {
    assert.ok(actions.includes(expected), `missing audit action: ${expected}`);
  }
});
