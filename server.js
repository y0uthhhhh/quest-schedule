require('dotenv').config();
const express = require('express');
const path = require('path');
const { TelegramBot } = require('node-telegram-bot-api');
const { db, initDb } = require('./db');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Telegram-бот ---
if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не найден в .env');
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN);

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'сотрудник';
  bot.sendMessage(msg.chat.id,
    `Привет, ${name}! 👋\n\n` +
    `Это бот для бронирования смен в квестах.\n\n` +
    `Чтобы открыть расписание — нажми кнопку «Расписание» рядом с полем ввода (или значок меню слева).`,
  );
});

// Узнать chat_id беседы (для настройки уведомлений)
bot.onText(/\/getchatid/, (msg) => {
  const threadLine = msg.message_thread_id
    ? `\nThread ID: \`${msg.message_thread_id}\` ← ЭТО НУЖНО В TELEGRAM_THREAD_ID`
    : '\nThread ID: — (это не ветка, а основной чат)';
  bot.sendMessage(
    msg.chat.id,
    `Chat ID: \`${msg.chat.id}\`\nТип: ${msg.chat.type}\nНазвание: ${msg.chat.title || '—'}${threadLine}`,
    { parse_mode: 'Markdown', message_thread_id: msg.message_thread_id }
  );
});

// Узнать свой Telegram ID
bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Ваш Telegram ID: \`${msg.from.id}\`\nИмя: ${msg.from.first_name || '—'}\nUsername: @${msg.from.username || '—'}`
  );
});

bot.on('polling_error', (err) => {
  console.error('⚠️ Ошибка бота:', err.message);
});

// Безопасная отправка сообщения — не ломает основной поток при ошибке
async function sendTelegramMessage(chatId, text, options = {}) {
  if (!chatId) return false;
  try {
    await bot.sendMessage(chatId, text, options);
    return true;
  } catch (err) {
    console.error(`⚠️ Не удалось отправить в ${chatId}:`, err.message);
    return false;
  }
}

// Форматирование даты для сообщений: "20 сентября, 15:30"
function formatDateHuman(dateStr, timeStr) {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getDate()} ${months[d.getMonth()]}, ${timeStr}`;
}

// --- Express ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ УТИЛИТЫ ============

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Текущее время в часовом поясе приложения (Россия, Москва)
function now() {
  return new Date();
}

// Формат даты YYYY-MM-DD
function formatDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Получить начало текущей недели (понедельник)
function getMonday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0 = Вс
  const diff = (day === 0 ? -6 : 1 - day);
  date.setDate(date.getDate() + diff);
  return date;
}

// Последняя доступная для брони дата: конец следующей недели (воскресенье)
function getBookingWindowEnd() {
  const monday = getMonday(now());
  // Понедельник текущей недели + 13 дней = воскресенье следующей недели
  const end = new Date(monday);
  end.setDate(end.getDate() + 13);
  return end;
}

// Открыта ли дата для бронирования (не закрыта окном)
function isSlotOpen(dateStr) {
  const end = getBookingWindowEnd();
  const endKey = formatDateKey(end);
  return dateStr <= endKey;
}

// Является ли слот архивным (время начала уже прошло)
function isArchived(dateStr, timeStr) {
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  return dt < now();
}

// До начала меньше 72 часов?
function isWithin72Hours(dateStr, timeStr) {
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  const diffMs = dt.getTime() - now().getTime();
  return diffMs < 72 * 60 * 60 * 1000;
}

// Статус слота для фронта
function getSlotStatus(dateStr, timeStr) {
  if (isArchived(dateStr, timeStr)) return 'archived';
  if (!isSlotOpen(dateStr)) return 'closed';
  return 'active';
}

// ============ API ============

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', now: now().toISOString(), windowEnd: formatDateKey(getBookingWindowEnd()) });
});

// --- Авторизация через Telegram ---
function verifyTelegramAuth(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest();

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) return null;

  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

app.post('/api/auth', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'Нет initData' });

    const tgUser = verifyTelegramAuth(initData);
    if (!tgUser) return res.status(401).json({ error: 'Неверная подпись Telegram' });

    const existing = await db.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [String(tgUser.id)],
    });

    let user;
    if (existing.rows.length === 0) {
      const info = await db.execute({
        sql: `INSERT INTO users (telegram_id, first_name, username, is_admin)
              VALUES (?, ?, ?, 0)`,
        args: [String(tgUser.id), tgUser.first_name || 'Сотрудник', tgUser.username || null],
      });
      user = {
        id: Number(info.lastInsertRowid),
        telegram_id: String(tgUser.id),
        first_name: tgUser.first_name || 'Сотрудник',
        is_admin: 0,
      };
    } else {
      user = {
        id: existing.rows[0].id,
        telegram_id: existing.rows[0].telegram_id,
        first_name: existing.rows[0].first_name,
        is_admin: existing.rows[0].is_admin,
      };
    }

    res.json({ ok: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка авторизации' });
  }
});

// --- Расписание ---
app.get('/api/schedule', async (req, res) => {
  try {
    const { from, days } = req.query;
    if (!from) return res.status(400).json({ error: 'Нужен параметр from (YYYY-MM-DD)' });

    const numDays = Math.min(parseInt(days) || 7, 31);
    const dates = [];
    const start = new Date(from + 'T00:00:00');
    for (let i = 0; i < numDays; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      dates.push(formatDateKey(d));
    }

    const placeholders = dates.map(() => '?').join(',');

    const bookingsRes = await db.execute({
      sql: `SELECT id, slot_date, slot_time, location, quest_name, client_name, comment
            FROM client_bookings WHERE slot_date IN (${placeholders})`,
      args: dates,
    });

    const shiftsRes = await db.execute({
      sql: `SELECT ss.slot_date, ss.slot_time, ss.location, u.first_name, u.id as user_id
            FROM staff_shifts ss
            JOIN users u ON u.id = ss.user_id
            WHERE ss.slot_date IN (${placeholders})`,
      args: dates,
    });

    const result = {};
    for (const d of dates) result[d] = {};

    for (const b of bookingsRes.rows) {
      const key = `${b.location}|${b.slot_time}`;
      result[b.slot_date][key] = result[b.slot_date][key] || { quest: null, staff: [] };
      result[b.slot_date][key].quest = b.quest_name;
      result[b.slot_date][key].client = b.client_name;
      result[b.slot_date][key].booking_id = Number(b.id);
      result[b.slot_date][key].comment = b.comment;
    }

    for (const s of shiftsRes.rows) {
      const key = `${s.location}|${s.slot_time}`;
      result[s.slot_date][key] = result[s.slot_date][key] || { quest: null, staff: [] };
      result[s.slot_date][key].staff.push({ id: Number(s.user_id), name: s.first_name });
    }

    const windowEnd = formatDateKey(getBookingWindowEnd());
    res.json({ dates, data: result, windowEnd });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- Добавить клиентскую бронь (только админ) ---
// --- Добавить клиентскую бронь (только админ) ---
app.post('/api/client-booking', async (req, res) => {
  try {
    const { slot_date, slot_time, location, quest_name, admin_id } = req.body;
    const comment = req.body.comment || null;

    if (!slot_date || !slot_time || !location || !quest_name) {
      return res.status(400).json({ error: 'Нужны поля: slot_date, slot_time, location, quest_name' });
    }

    // Проверяем, что запрос от админа
    const adminIdNum = safeNum(admin_id);
    if (adminIdNum === null) {
      return res.status(403).json({ error: 'Нужен admin_id' });
    }
    const adminRes = await db.execute({
      sql: 'SELECT is_admin FROM users WHERE id = ?',
      args: [adminIdNum],
    });
    if (adminRes.rows.length === 0 || !adminRes.rows[0].is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }

    // Создаём бронь
    const info = await db.execute({
      sql: `INSERT INTO client_bookings
              (slot_date, slot_time, location, quest_name, comment)
            VALUES (?, ?, ?, ?, ?)`,
      args: [slot_date, slot_time, location, quest_name, comment],
    });

    const bookingId = Number(info.lastInsertRowid);
    res.json({ ok: true, id: bookingId });

    // --- Уведомления (после ответа, чтобы не задерживать UI) ---
    try {
      const staffRes = await db.execute({
        sql: `SELECT u.telegram_id, u.first_name, u.username
              FROM staff_shifts ss
              JOIN users u ON u.id = ss.user_id
              WHERE ss.slot_date = ? AND ss.slot_time = ? AND ss.location = ?`,
        args: [slot_date, slot_time, location],
      });

      const staff = staffRes.rows;
      const dateHuman = formatDateHuman(slot_date, slot_time);
      const commentLine = comment ? `\n💬 Комментарий: ${comment}` : '';

      // 1. Личка каждому сотруднику
      for (const s of staff) {
        const text =
          `🎮 Новая игра!\n\n` +
          `📍 Локация: ${location}\n` +
          `🎯 Квест: ${quest_name}\n` +
          `📅 ${dateHuman}` +
          commentLine +
          `\n\nТы ответственный за этот слот.`;
        await sendTelegramMessage(s.telegram_id, text);
      }

      // 2. Общее сообщение в беседу
      const chatId = process.env.TELEGRAM_CHAT_ID;
      const threadId = process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : null;
      if (chatId) {
        let mentions;
        if (staff.length === 0) {
          mentions = '— (никто не записан)';
        } else {
          mentions = staff.map(s =>
            s.username ? `@${s.username}` : s.first_name
          ).join(', ');
        }

        const groupText =
          `🎮 Новая бронь\n\n` +
          `📍 Локация: ${location}\n` +
          `🎯 Квест: ${quest_name}\n` +
          `📅 ${dateHuman}\n` +
          `👥 Ответственные: ${mentions}` +
          commentLine;

        const opts = threadId ? { message_thread_id: threadId } : {};
        await sendTelegramMessage(chatId, groupText, opts);
      }
    } catch (notifyErr) {
      console.error('⚠️ Ошибка уведомлений:', notifyErr.message);
    }

  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'На этот слот уже есть бронь' });
    }
    console.error(err);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// --- Удалить клиентскую бронь (только админ) ---
app.delete('/api/client-booking/:id', async (req, res) => {
  try {
    const id = safeNum(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Неверный id брони' });

    // Сначала находим бронь, чтобы знать данные для уведомлений
    const bookingRes = await db.execute({
      sql: 'SELECT slot_date, slot_time, location, quest_name FROM client_bookings WHERE id = ?',
      args: [id],
    });
    if (bookingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Бронь не найдена' });
    }
    const booking = bookingRes.rows[0];

    // Удаляем
    await db.execute({
      sql: 'DELETE FROM client_bookings WHERE id = ?',
      args: [id],
    });

    res.json({ ok: true, deleted: 1 });

    // --- Уведомления (после ответа) ---
    try {
      const staffRes = await db.execute({
        sql: `SELECT u.telegram_id, u.first_name, u.username
              FROM staff_shifts ss
              JOIN users u ON u.id = ss.user_id
              WHERE ss.slot_date = ? AND ss.slot_time = ? AND ss.location = ?`,
        args: [booking.slot_date, booking.slot_time, booking.location],
      });
      const staff = staffRes.rows;
      const dateHuman = formatDateHuman(booking.slot_date, booking.slot_time);

      // 1. Личка каждому
      for (const s of staff) {
        const text =
          `❌ Игра отменена\n\n` +
          `📍 Локация: ${booking.location}\n` +
          `🎯 Квест: ${booking.quest_name}\n` +
          `📅 ${dateHuman}`;
        await sendTelegramMessage(s.telegram_id, text);
      }

      // 2. В беседу
      const chatId = process.env.TELEGRAM_CHAT_ID;
      const threadId = process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : null;
      if (chatId) {
        let mentions;
        if (staff.length === 0) {
          mentions = '—';
        } else {
          mentions = staff.map(s =>
            s.username ? `@${s.username}` : s.first_name
          ).join(', ');
        }

        const groupText =
          `❌ Бронь отменена\n\n` +
          `📍 Локация: ${booking.location}\n` +
          `🎯 Квест: ${booking.quest_name}\n` +
          `📅 ${dateHuman}\n` +
          `👥 Ответственные: ${mentions}`;

        const opts = threadId ? { message_thread_id: threadId } : {};
        await sendTelegramMessage(chatId, groupText, opts);
      }
    } catch (notifyErr) {
      console.error('⚠️ Ошибка уведомлений при удалении:', notifyErr.message);
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// --- Запись сотрудника на слот ---
app.post('/api/shift', async (req, res) => {
  try {
    const { slot_date, slot_time, location } = req.body;
    const user_id = safeNum(req.body.user_id);
    if (!slot_date || !slot_time || !location || user_id === null) {
      return res.status(400).json({ error: 'Нужны поля: slot_date, slot_time, location, user_id' });
    }

    // Проверки статуса слота
    if (isArchived(slot_date, slot_time)) {
      return res.status(400).json({ error: 'Этот слот уже прошёл' });
    }
    if (!isSlotOpen(slot_date)) {
      return res.status(400).json({ error: 'Бронирование на эту дату ещё не открыто' });
    }

    // Проверяем лимит 4 человека
    const countRes = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM staff_shifts
            WHERE slot_date = ? AND slot_time = ? AND location = ?`,
      args: [slot_date, slot_time, location],
    });
    if (Number(countRes.rows[0].cnt) >= 4) {
      return res.status(409).json({ error: 'Слот заполнен (максимум 4)' });
    }

    // Проверяем дубликат
    const existRes = await db.execute({
      sql: `SELECT id FROM staff_shifts
            WHERE slot_date = ? AND slot_time = ? AND location = ? AND user_id = ?`,
      args: [slot_date, slot_time, location, user_id],
    });
    if (existRes.rows.length > 0) {
      return res.status(409).json({ error: 'Вы уже записаны на этот слот' });
    }

    const info = await db.execute({
      sql: `INSERT INTO staff_shifts (slot_date, slot_time, location, user_id)
            VALUES (?, ?, ?, ?)`,
      args: [slot_date, slot_time, location, user_id],
    });

    // Возвращаем признак «близко к игре»
    const warning = isWithin72Hours(slot_date, slot_time)
      ? 'До игры меньше 72 часов, снять вас сможет только админ'
      : null;

    res.json({ ok: true, id: Number(info.lastInsertRowid), warning });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// --- Отписка сотрудника (самостоятельная) ---
app.delete('/api/shift', async (req, res) => {
  try {
    const { slot_date, slot_time, location } = req.body;
    const user_id = safeNum(req.body.user_id);
    if (!slot_date || !slot_time || !location || user_id === null) {
      return res.status(400).json({ error: 'Нужны поля: slot_date, slot_time, location, user_id' });
    }

    // Проверка 72 часов
    if (isWithin72Hours(slot_date, slot_time)) {
      return res.status(403).json({
        error: 'До игры меньше 72 часов. Снять вас может только админ',
      });
    }

    const info = await db.execute({
      sql: `DELETE FROM staff_shifts
            WHERE slot_date = ? AND slot_time = ? AND location = ? AND user_id = ?`,
      args: [slot_date, slot_time, location, user_id],
    });

    res.json({ ok: true, deleted: info.rowsAffected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// --- Админ: снять любого сотрудника со слота ---
app.delete('/api/shift/admin', async (req, res) => {
  try {
    const { slot_date, slot_time, location } = req.body;
    const admin_id = safeNum(req.body.admin_id);
    const target_user_id = safeNum(req.body.target_user_id);

    if (!slot_date || !slot_time || !location || admin_id === null || target_user_id === null) {
      return res.status(400).json({ error: 'Нужны поля: slot_date, slot_time, location, admin_id, target_user_id' });
    }

    const adminRes = await db.execute({
      sql: 'SELECT is_admin FROM users WHERE id = ?',
      args: [admin_id],
    });
    if (adminRes.rows.length === 0 || !adminRes.rows[0].is_admin) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }

    const info = await db.execute({
      sql: `DELETE FROM staff_shifts
            WHERE slot_date = ? AND slot_time = ? AND location = ? AND user_id = ?`,
      args: [slot_date, slot_time, location, target_user_id],
    });

    res.json({ ok: true, deleted: info.rowsAffected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

// --- Webhook для Telegram ---
app.post('/api/telegram-webhook', async (req, res) => {
  console.log('📥 Webhook получен:', JSON.stringify(req.body).slice(0, 200));
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка webhook:', err);
    res.sendStatus(500);
  }
});

// --- Запуск ---
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
      console.log(`📅 Окно бронирования до: ${formatDateKey(getBookingWindowEnd())}`);
      bot.startPolling();
      console.log(`🤖 Бот в режиме polling.`);
    });
  } catch (err) {
    console.error('❌ Не удалось запустить сервер:', err);
    process.exit(1);
  }
})();
