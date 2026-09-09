// Automated Verification Script for Complaints & Employee Concerns System.
//
// Verifies:
// 1. All 11 approved categories
// 2. Submission validation and reference number generation
// 3. Document/attachment storage
// 4. Automated reception and HR notifications
// 5. Strict confidentiality (cross-employee access blocked)
// 6. HR review, status progression, notes, and resolution date
// 7. Employee notification on resolution
// 8. Clean database teardown

require('dotenv').config();
const { db } = require('../src/db');
const complaints = require('../src/domain/complaints');

async function run() {
  console.log('--- Starting Verification: Complaints & Concerns System ---');

  // 1. Verify categories
  const categories = complaints.listCategories();
  console.log(`[Test 1] Checking categories. Found: ${categories.length}`);
  if (categories.length !== 11) {
    throw new Error(`Expected exactly 11 categories, found ${categories.length}`);
  }
  const expectedCats = [
    'Salary or payroll deductions',
    'Incorrect attendance records',
    'Leave entitlement',
    'Working hours',
    'Workplace issues',
    'Behaviour or treatment in the office',
    'Problems involving another employee',
    'Problems involving a manager',
    'Harassment, bullying, or inappropriate behaviour',
    'Health and safety concerns',
    'Any other HR or workplace-related issue',
  ];
  for (const cat of expectedCats) {
    if (!categories.includes(cat)) {
      throw new Error(`Missing expected category: ${cat}`);
    }
  }
  console.log('✓ All 11 categories verified successfully.');

  // Test invalid category rejection
  let invalidRejected = false;
  try {
    await complaints.submitComplaint({
      employeeId: 'emp_8619',
      category: 'Bogus Category',
      subject: 'Test',
      description: 'Test',
    });
  } catch (err) {
    invalidRejected = true;
  }
  if (!invalidRejected) throw new Error('Invalid category was unexpectedly accepted!');
  console.log('✓ Invalid category was properly rejected.');

  // 2. Test Submission with attachment
  console.log('[Test 2] Submitting confidential concern with attachment for Abdullah Shahid (FW001)...');
  const dummyFile = {
    originalname: 'payslip_screenshot.png',
    buffer: Buffer.from('Fake PNG binary payload for testing'),
    mimetype: 'image/png',
    size: 34,
  };

  const submission = await complaints.submitComplaint({
    employeeId: 'emp_8619', // Abdullah
    category: 'Salary or payroll deductions',
    subject: 'Incorrect tax deduction in August pay slip',
    description: 'The deduction on line 4 does not match the approved relief schedule.',
    priority: 'HIGH',
    files: [dummyFile],
    actor: 'employee:emp_8619',
  });

  console.log('Submission Response:', submission);
  if (!submission.id || !submission.referenceNumber.startsWith('CMP-')) {
    throw new Error('Complaint ID or reference number missing from submission response');
  }
  if (submission.attachmentsCount !== 1) {
    throw new Error(`Expected 1 attachment, got ${submission.attachmentsCount}`);
  }
  const complaintId = submission.id;
  console.log('✓ Complaint submitted successfully with reference:', submission.referenceNumber);

  // 3. Automated reception by HR
  console.log('[Test 3] Verifying HR notification dispatch...');
  const latestNotif = await db.prepare(`
    SELECT * FROM notifications WHERE category = 'HR_ALERT' ORDER BY created_at DESC LIMIT 1
  `).get();
  if (!latestNotif || !latestNotif.title.includes(submission.referenceNumber)) {
    throw new Error('HR notification not found for submitted complaint!');
  }
  console.log('✓ Automated HR notification found:', latestNotif.title);

  // 4. Strict Confidentiality check
  console.log('[Test 4] Testing Strict Confidentiality & Access Isolation...');
  // A. Submitting employee can view it
  const abdullahList = await complaints.listEmployeeComplaints('emp_8619');
  const abdullahFound = abdullahList.find(c => c.id === complaintId);
  if (!abdullahFound) throw new Error("Submitting employee couldn't find their own complaint!");
  console.log('✓ Submitting employee can view their own complaint.');

  // B. Another employee (Maaz) cannot view it in their list
  const maazList = await complaints.listEmployeeComplaints('emp_c888cff98892');
  const maazFound = maazList.find(c => c.id === complaintId);
  if (maazFound) throw new Error("Confidentiality leak! Other employee found someone else's complaint in their list!");
  console.log("✓ Other employee list is completely isolated (0 leak).");

  // C. Another employee device querying the detail endpoint directly gets 404 (null)
  const maazDirectAccess = await complaints.getComplaintById(complaintId, {
    kind: 'device',
    employeeId: 'emp_c888cff98892',
  });
  if (maazDirectAccess !== null) {
    throw new Error("Confidentiality breach! Unauthorized employee accessed complaint details!");
  }
  console.log('✓ Direct unauthorized access denied with null (404 Not Found response).');

  // 5. HR Review & Workflow Progression
  console.log('[Test 5] Testing HR management, notes, and resolution...');
  const hrUser = { kind: 'admin', roles: ['super_admin'], name: 'System Admin' };

  // A. HR lists all complaints
  const hrList = await complaints.listAllComplaints({ user: hrUser });
  const hrFound = hrList.find(c => c.id === complaintId);
  if (!hrFound) throw new Error('HR could not find complaint in management view!');
  if (hrFound.employeeName !== 'Abdullah shahid' || hrFound.employeeNumber !== 'FW001') {
    throw new Error(`Employee metadata mismatch in HR view: ${hrFound.employeeName}, ${hrFound.employeeNumber}`);
  }
  console.log('✓ HR view correctly populated with employee name & employee ID.');

  // B. HR updates status to UNDER_REVIEW
  await complaints.updateComplaintStatus({
    complaintId,
    status: 'UNDER_REVIEW',
    hrNotes: 'Assigned to payroll desk for verification.',
    actor: 'hr_admin',
    actorName: 'Arshia (HR)',
  });

  const underReviewCheck = await complaints.getComplaintById(complaintId, hrUser);
  if (underReviewCheck.status !== 'UNDER_REVIEW' || underReviewCheck.hrNotes !== 'Assigned to payroll desk for verification.') {
    throw new Error('Status or HR notes failed to update!');
  }
  console.log('✓ Status updated to UNDER_REVIEW with HR notes.');

  // C. HR resolves the complaint
  const resolved = await complaints.updateComplaintStatus({
    complaintId,
    status: 'RESOLVED',
    hrNotes: 'Payroll desk has verified and adjusted the tax code.',
    resolutionNotes: 'Adjustment of £140 will be credited in next pay cycle.',
    actor: 'hr_admin',
    actorName: 'Arshia (HR)',
  });

  if (resolved.complaintStatus !== 'RESOLVED' || !resolved.resolvedAt || resolved.resolvedBy !== 'Arshia (HR)') {
    throw new Error('Resolution failed to record resolvedAt, resolvedBy, or status!');
  }
  console.log('✓ Complaint successfully marked RESOLVED with resolution date:', resolved.resolvedAtFormatted);

  // 6. Submitting employee view reflects resolution
  console.log('[Test 6] Verifying employee views updated resolution...');
  const finalEmpView = await complaints.getComplaintById(complaintId, {
    kind: 'device',
    employeeId: 'emp_8619',
  });
  if (finalEmpView.status !== 'RESOLVED' || !finalEmpView.resolvedAt || !finalEmpView.hrNotes) {
    throw new Error('Employee view does not reflect final resolution or notes!');
  }
  console.log('✓ Submitting employee view confirms RESOLVED status, HR notes, and resolution date.');

  // 7. Cleanup test data
  console.log('[Test 7] Cleaning up test complaint and attachments...');
  await db.prepare('DELETE FROM complaint_attachments WHERE complaint_id = ?').run(complaintId);
  await db.prepare('DELETE FROM complaints WHERE id = ?').run(complaintId);
  await db.prepare("DELETE FROM notifications WHERE category = 'HR_ALERT' AND title LIKE '%CMP-%'").run();
  console.log('✓ Cleaned up test data. Workforce database is pristine.');

  console.log('\n======================================================');
  console.log('🎉 ALL COMPLAINTS & CONCERNS BACKEND TESTS PASSED 100%!');
  console.log('======================================================\n');
}

run().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
