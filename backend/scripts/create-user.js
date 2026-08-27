#!/usr/bin/env node
// Creates a user account.
//
//   npm run user:create -- --email hr@example.org --name "Jane Doe" --role hr
//   npm run user:create -- --email boss@example.org --name "Owner" --role super_admin
//
// The password is read from the OFFICE_TRACKER_PASSWORD environment variable,
// or generated. It is never taken as a command-line argument, because argv is
// visible to other processes and lands in shell history.

const crypto = require('crypto');
const rbac = require('../src/domain/rbac');
const { db } = require('../src/db');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const email = arg('email');
const name = arg('name');
const roles = (arg('role') || 'hr').split(',').map(r => r.trim()).filter(Boolean);
const employeeId = arg('employee') || null;

if (!email || !name) {
  console.error('Usage: npm run user:create -- --email <email> --name "<name>" [--role hr] [--employee emp_xxx]');
  console.error('');
  console.error('Roles: employee | manager | hr | super_admin  (comma-separate for several)');
  console.error('Set OFFICE_TRACKER_PASSWORD to choose the password, otherwise one is generated.');
  process.exit(1);
}

if (employeeId && !db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId)) {
  console.error(`No employee with id ${employeeId}.`);
  process.exit(1);
}

// Generated passwords avoid look-alike characters so they survive being read
// aloud or copied off a screen.
function generatePassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const words = [];
  for (let w = 0; w < 4; w++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    words.push(s);
  }
  return words.join('-');
}

const password = process.env.OFFICE_TRACKER_PASSWORD || generatePassword();
const generated = !process.env.OFFICE_TRACKER_PASSWORD;

try {
  const user = rbac.createUser({
    email, displayName: name, password, roles, employeeId,
    // A generated password must be replaced by its owner, so nobody but that
    // person knows the working credential.
    mustChangePassword: generated,
    actor: 'cli',
  });

  console.log('');
  console.log('  User created');
  console.log('    id     :', user.id);
  console.log('    email  :', user.email);
  console.log('    roles  :', roles.join(', '));
  if (generated) {
    console.log('    password:', password);
    console.log('');
    console.log('  Give this password to its owner over a channel you trust.');
    console.log('  They will be required to change it at first sign-in.');
  }
  console.log('');

  if (roles.includes('super_admin')) {
    console.log('  This account can change attendance, lateness, absence, leave and');
    console.log('  payroll policy. Those settings decide who is recorded as late and');
    console.log('  whose pay is affected, so keep the number of holders small.');
    console.log('');
  }
} catch (err) {
  console.error('Could not create user:', err.message);
  process.exit(1);
}
