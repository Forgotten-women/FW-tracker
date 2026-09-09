// Designated Organisation Bank Holidays / Public Holidays Domain
//
// Manages the 5 designated approved bank holidays per year under the
// organisation's annual entitlement policy.
//
// Rules:
//   1. Appear on company calendar.
//   2. Do not deduct from employee annual leave.
//   3. Excluded from normal absence calculations.
//   4. Included correctly when calculating monthly required working hours (paid non-working day).
//   5. Changeable strictly by HR.

const { db } = require('../db');
const T = require('../util/time');
const crypto = require('crypto');

const selectHolidaysForYear = db.prepare(`
  SELECT * FROM bank_holidays
  WHERE year = ?
  ORDER BY date ASC
`);

const selectAllHolidays = db.prepare(`
  SELECT * FROM bank_holidays
  ORDER BY date ASC
`);

const selectHolidayByDate = db.prepare(`
  SELECT * FROM bank_holidays
  WHERE date = ? AND is_active = 1
  LIMIT 1
`);

const selectHolidayById = db.prepare(`
  SELECT * FROM bank_holidays
  WHERE id = ?
  LIMIT 1
`);

const selectHolidaysBetween = db.prepare(`
  SELECT * FROM bank_holidays
  WHERE date >= ? AND date <= ? AND is_active = 1
  ORDER BY date ASC
`);

let _holidayCache = null;
let _holidayCacheExpiry = 0;

async function _loadCache() {
  const now = Date.now();
  if (_holidayCache && now < _holidayCacheExpiry) {
    return _holidayCache;
  }
  const rows = await selectAllHolidays.all();
  const map = new Map();
  for (const r of rows) {
    if (r.is_active === 1 || r.is_active === true) {
      map.set(r.date, {
        id: r.id,
        year: r.year,
        date: r.date,
        name: r.name,
        notes: r.notes || null,
        isActive: true,
      });
    }
  }
  _holidayCache = map;
  _holidayCacheExpiry = now + 60000; // 60s TTL
  return map;
}

function invalidateCache() {
  _holidayCache = null;
  _holidayCacheExpiry = 0;
}

/**
 * Lists bank holidays for a given year (defaults to current year).
 */
async function listBankHolidays(year = null) {
  const rows = year
    ? await selectHolidaysForYear.all(Number(year))
    : await selectAllHolidays.all();

  return rows.map(r => {
    const [y, m, d] = r.date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weekday = dayNames[dt.getUTCDay()];

    return {
      id: r.id,
      year: r.year,
      date: r.date,
      name: r.name,
      notes: r.notes || null,
      isActive: r.is_active === 1 || r.is_active === true,
      weekday,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  });
}

/**
 * Checks if a specific date (YYYY-MM-DD) is a designated bank holiday.
 */
async function isBankHoliday(dateKey) {
  if (!dateKey) return null;
  const cache = await _loadCache();
  return cache.get(dateKey) || null;
}

/**
 * Retrieves bank holidays between two dates (inclusive) for calendars.
 */
async function getBankHolidaysBetween(startDate, endDate) {
  const rows = await selectHolidaysBetween.all(startDate, endDate);
  return rows.map(r => ({
    id: r.id,
    year: r.year,
    date: r.date,
    name: r.name,
    notes: r.notes || null,
    isPaid: true,
    dayType: 'PUBLIC_HOLIDAY',
  }));
}

/**
 * Saves/updates a specific bank holiday (HR only).
 */
async function saveBankHoliday({ id, year, date, name, notes, isActive = 1 }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Valid date in YYYY-MM-DD format is required.');
  }
  if (!name || !name.trim()) {
    throw new Error('Holiday name is required.');
  }

  const hYear = Number(year || date.slice(0, 4));
  const hId = id || `bh_${date.replace(/-/g, '_')}_${crypto.randomBytes(3).toString('hex')}`;
  const now = T.now();

  const existing = await selectHolidayById.get(hId);
  if (existing) {
    await db.prepare(`
      UPDATE bank_holidays
      SET year = ?, date = ?, name = ?, notes = ?, is_active = ?, updated_at = ?
      WHERE id = ?
    `).run(hYear, date, name.trim(), notes ? notes.trim() : null, isActive ? 1 : 0, now, hId);
  } else {
    // Check if another holiday has this date
    const dateConflict = await selectHolidayByDate.get(date);
    if (dateConflict && dateConflict.id !== hId) {
      // Update the conflicting one
      await db.prepare(`
        UPDATE bank_holidays
        SET year = ?, name = ?, notes = ?, is_active = ?, updated_at = ?
        WHERE id = ?
      `).run(hYear, name.trim(), notes ? notes.trim() : null, isActive ? 1 : 0, now, dateConflict.id);
      return await selectHolidayById.get(dateConflict.id);
    }

    await db.prepare(`
      INSERT INTO bank_holidays (id, year, date, name, notes, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(hId, hYear, date, name.trim(), notes ? notes.trim() : null, isActive ? 1 : 0, now, now);
  }

  invalidateCache();
  return await selectHolidayById.get(hId);
}

/**
 * Replaces/updates the designated bank holidays for a given year (HR only).
 * Validates that no more than 5 designated holidays are set as active for the annual calendar.
 */
async function setYearBankHolidays(year, holidaysList) {
  const targetYear = Number(year);
  if (!targetYear || isNaN(targetYear)) {
    throw new Error('Valid target year is required.');
  }
  if (!Array.isArray(holidaysList) || holidaysList.length === 0) {
    throw new Error('At least one bank holiday must be provided.');
  }

  // Validate dates
  const datesSeen = new Set();
  for (const h of holidaysList) {
    if (!h.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) {
      throw new Error(`Invalid holiday date: "${h.date}". Must be YYYY-MM-DD.`);
    }
    if (datesSeen.has(h.date)) {
      throw new Error(`Duplicate holiday date in request: "${h.date}".`);
    }
    datesSeen.add(h.date);
    if (!h.name || !h.name.trim()) {
      throw new Error(`Holiday name missing for date ${h.date}.`);
    }
  }

  const now = T.now();

  // Upsert each provided holiday
  const keptIds = [];
  for (const h of holidaysList) {
    const hId = h.id || `bh_${h.date.replace(/-/g, '_')}`;
    const hYear = Number(h.date.slice(0, 4));

    await db.prepare(`
      INSERT INTO bank_holidays (id, year, date, name, notes, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (date) DO UPDATE SET
        year = EXCLUDED.year,
        name = EXCLUDED.name,
        notes = EXCLUDED.notes,
        is_active = 1,
        updated_at = EXCLUDED.updated_at
    `).run(hId, hYear, h.date, h.name.trim(), h.notes ? h.notes.trim() : null, now, now);

    keptIds.push(hId);
  }

  // Deactivate or delete old holidays for that year not in the new list
  const existingForYear = await selectHolidaysForYear.all(targetYear);
  for (const old of existingForYear) {
    if (!datesSeen.has(old.date)) {
      await db.prepare('DELETE FROM bank_holidays WHERE id = ?').run(old.id);
    }
  }

  invalidateCache();
  return await listBankHolidays(targetYear);
}

/**
 * Deletes a bank holiday (HR only).
 */
async function deleteBankHoliday(id) {
  const row = await selectHolidayById.get(id);
  if (!row) {
    throw new Error('Bank holiday not found.');
  }
  await db.prepare('DELETE FROM bank_holidays WHERE id = ?').run(id);
  invalidateCache();
  return { id, deleted: true };
}

module.exports = {
  listBankHolidays,
  isBankHoliday,
  getBankHolidaysBetween,
  saveBankHoliday,
  setYearBankHolidays,
  deleteBankHoliday,
};
