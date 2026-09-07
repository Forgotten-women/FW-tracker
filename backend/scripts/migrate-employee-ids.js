const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('Connected to database. Checking employees...');

  // Ensure unique index on employee_number
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_number 
    ON employees (employee_number) 
    WHERE employee_number IS NOT NULL;
  `);

  // Query employees ordered by created_at or id
  const res = await client.query(`
    SELECT id, name, employee_number, created_at 
    FROM employees 
    ORDER BY created_at ASC, id ASC;
  `);

  console.log(`Found ${res.rows.length} total employees.`);

  // Find highest existing FW number
  let maxNum = 0;
  for (const row of res.rows) {
    if (row.employee_number) {
      const match = /^FW(\d+)$/i.exec(row.employee_number.trim());
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
  }

  // Pre-determined assignment for initial three if not set:
  // Abdullah shahid -> FW001, Maaz Ali -> FW002, Arshia -> FW003
  const specificMap = {
    'emp_8619': 'FW001',
    'emp_c888cff98892': 'FW002',
    'emp_da0a99a7b275': 'FW003',
  };

  for (const row of res.rows) {
    if (!row.employee_number) {
      let assignedId = specificMap[row.id];
      if (!assignedId) {
        maxNum += 1;
        assignedId = 'FW' + String(maxNum).padStart(3, '0');
      } else {
        const num = parseInt(assignedId.replace(/^FW/i, ''), 10);
        if (num > maxNum) maxNum = num;
      }

      await client.query('UPDATE employees SET employee_number = $1 WHERE id = $2', [assignedId, row.id]);
      console.log(`Assigned ${assignedId} to employee: ${row.name} (${row.id})`);
    } else {
      console.log(`Employee ${row.name} (${row.id}) already has ID: ${row.employee_number}`);
    }
  }

  const finalCheck = await client.query('SELECT id, name, employee_number, active FROM employees ORDER BY employee_number ASC');
  console.log('\n--- Final Employee Records ---');
  console.table(finalCheck.rows);

  await client.end();
  console.log('Migration completed successfully.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
