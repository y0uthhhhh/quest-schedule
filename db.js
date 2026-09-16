const { createClient } = require('@libsql/client');

// Принудительно направляем fetch через прокси
if (process.env.HTTPS_PROXY || process.env.https_proxy) {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log('✅ Прокси для fetch подключен');
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        username TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS client_bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_date TEXT NOT NULL,
        slot_time TEXT NOT NULL,
        location TEXT NOT NULL,
        quest_name TEXT NOT NULL,
        client_name TEXT,
        client_phone TEXT,
        comment TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(slot_date, slot_time, location)
      )`,
      `CREATE TABLE IF NOT EXISTS staff_shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_date TEXT NOT NULL,
        slot_time TEXT NOT NULL,
        location TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(slot_date, slot_time, location, user_id)
      )`,
    ],
    'write'
  );
  console.log('✅ Таблицы в Turso готовы');
}

module.exports = { db, initDb };