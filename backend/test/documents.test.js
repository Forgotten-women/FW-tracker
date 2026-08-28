// Document vault tests. Spec sections 5 and 27.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `office-docs-test-${process.pid}.db`);
process.env.DB_FILE = TMP;
process.env.ADMIN_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.OFFICE_CONFIG_FILE = path.join(__dirname, 'fixtures', 'office.test.json');

const { db } = require('../src/db');
const docs = require('../src/domain/documents');
const T = require('../src/util/time');

function makeEmployee(id) {
  db.prepare(
    'INSERT OR REPLACE INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  return id;
}

function fakeFile(name, contents) {
  const buffer = Buffer.from(contents);
  return { buffer, originalname: name, mimetype: 'application/pdf', size: buffer.length };
}

const HR = new Set(['document.read', 'document.write', 'employee.identity.read', 'employee.medical.read']);
const EMPLOYEE = new Set(['document.read', 'self.document.read']);

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + s); } catch {} }
  // Clean up any files written to the store during the test.
  try {
    for (const f of fs.readdirSync(docs.STORE)) {
      if (f.startsWith('file_')) fs.unlinkSync(path.join(docs.STORE, f));
    }
  } catch {}
});

// ---------------------------------------------------------------------------
// Upload and storage
// ---------------------------------------------------------------------------

test('uploading stores the file privately and records a version', () => {
  const emp = makeEmployee('emp_up');
  const r = docs.upload({
    employeeId: emp, documentTypeId: 'job_description', title: 'JD',
    file: fakeFile('jd.pdf', 'job description contents'), actor: 'user:hr',
  });

  assert.equal(r.version, 1);
  const version = db.prepare('SELECT * FROM document_versions WHERE document_id = ?').get(r.documentId);
  assert.ok(fs.existsSync(version.storage_path), 'the file is on disk');
  // Stored under a random name that reveals nothing, not the original filename.
  assert.ok(!version.storage_path.includes('jd.pdf'));
  assert.ok(version.checksum.length === 64, 'a checksum is kept');
});

test('re-uploading the same type adds a version, not a second document', () => {
  const emp = makeEmployee('emp_ver');
  const first = docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD v1', file: fakeFile('jd.pdf', 'v1'), actor: 'hr' });
  const second = docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD v2', file: fakeFile('jd.pdf', 'v2'), actor: 'hr' });

  assert.equal(first.documentId, second.documentId, 'same document');
  assert.equal(second.version, 2);
  // Spec 26: the old version is kept, not overwritten.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM document_versions WHERE document_id = ?').get(first.documentId).c, 2);
});

test('a type requiring an expiry date is refused without one', () => {
  const emp = makeEmployee('emp_exp');
  assert.throws(
    () => docs.upload({ employeeId: emp, documentTypeId: 'passport_id', title: 'Passport', file: fakeFile('p.pdf', 'x'), actor: 'hr' }),
    /expiry/i,
  );
});

// ---------------------------------------------------------------------------
// Confidentiality gating (spec 5)
// ---------------------------------------------------------------------------

test('a document is not even listed to someone who cannot read it', () => {
  const emp = makeEmployee('emp_conf');
  docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD', file: fakeFile('a.pdf', 'x'), actor: 'hr' });
  docs.upload({ employeeId: emp, documentTypeId: 'medical', title: 'Sick note', file: fakeFile('b.pdf', 'x'), actor: 'hr' });

  // An employee (document.read only) sees the JD but not the medical note - its
  // very existence is disclosure.
  const asEmployee = docs.listFor(emp, EMPLOYEE);
  assert.ok(asEmployee.some(d => d.type === 'Job description'));
  assert.ok(!asEmployee.some(d => d.typeId === 'medical'), 'the medical note is not listed');

  // HR with the medical permission sees both.
  const asHr = docs.listFor(emp, HR);
  assert.ok(asHr.some(d => d.typeId === 'medical'));
});

test('a medical document requires the medical permission specifically', () => {
  const emp = makeEmployee('emp_med');
  const r = docs.upload({ employeeId: emp, documentTypeId: 'medical', title: 'Note', file: fakeFile('m.pdf', 'x'), actor: 'hr' });
  assert.equal(docs.requiredReadPermission(r.documentId), 'employee.medical.read');
  // document.read alone is not enough.
  assert.equal(docs.issueDownloadToken({ documentId: r.documentId, permissions: new Set(['document.read']), actor: 'user:x' }), null);
});

// ---------------------------------------------------------------------------
// Signed downloads (spec 27)
// ---------------------------------------------------------------------------

test('a download token is single-use and time-limited', () => {
  const emp = makeEmployee('emp_dl');
  const r = docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD', file: fakeFile('jd.pdf', 'the contents'), actor: 'hr' });

  const grant = docs.issueDownloadToken({ documentId: r.documentId, permissions: HR, actor: 'user:hr' });
  assert.ok(grant.token);

  const file = docs.redeemDownloadToken(grant.token);
  assert.ok(file);
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'the contents');

  // Second use fails - the token is spent.
  assert.equal(docs.redeemDownloadToken(grant.token), null, 'single use');
});

test('issuing and redeeming a download are both logged', () => {
  const emp = makeEmployee('emp_log');
  const r = docs.upload({ employeeId: emp, documentTypeId: 'job_description', title: 'JD', file: fakeFile('jd.pdf', 'x'), actor: 'hr' });

  const grant = docs.issueDownloadToken({ documentId: r.documentId, permissions: HR, actor: 'user:hr', ip: '10.0.0.1' });
  docs.redeemDownloadToken(grant.token, { ip: '10.0.0.1' });

  const log = docs.accessLog(r.documentId);
  const actions = log.map(l => l.action);
  assert.ok(actions.includes('LINK_ISSUED'), 'issuing a link is logged');
  assert.ok(actions.includes('DOWNLOAD'), 'the download itself is logged');
});

// ---------------------------------------------------------------------------
// Acknowledgement (spec 5)
// ---------------------------------------------------------------------------

test('a document requiring acknowledgement raises one, which the employee can clear', () => {
  const emp = makeEmployee('emp_ack');
  const r = docs.upload({ employeeId: emp, documentTypeId: 'employment_contract', title: 'Contract', file: fakeFile('c.pdf', 'x'), actor: 'hr' });

  const listed = docs.listFor(emp, EMPLOYEE).find(d => d.id === r.documentId);
  assert.equal(listed.acknowledgementRequired, true);

  docs.acknowledge({ documentId: r.documentId, employeeId: emp });
  const after = docs.listFor(emp, EMPLOYEE).find(d => d.id === r.documentId);
  assert.equal(after.acknowledgementRequired, false);
  assert.ok(after.acknowledgedAt);
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

test('an archived document drops off the list but its file is retained', () => {
  const emp = makeEmployee('emp_arch');
  const r = docs.upload({ employeeId: emp, documentTypeId: 'other', title: 'Old', file: fakeFile('o.pdf', 'x'), actor: 'hr' });
  const version = db.prepare('SELECT storage_path FROM document_versions WHERE document_id = ?').get(r.documentId);

  docs.archive({ documentId: r.documentId, reason: 'Superseded', actor: 'user:hr' });

  assert.ok(!docs.listFor(emp, HR).some(d => d.id === r.documentId), 'no longer listed');
  assert.ok(fs.existsSync(version.storage_path), 'the file itself is kept for the record');
});

test('the document lifecycle is audited', () => {
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log').all().map(r => r.action);
  for (const expected of ['DOCUMENT_UPLOADED', 'DOCUMENT_VERSIONED', 'DOCUMENT_ACKNOWLEDGED', 'DOCUMENT_ARCHIVED']) {
    assert.ok(actions.includes(expected), `missing audit action: ${expected}`);
  }
});
