const { Pool } = require('pg');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

// Render Postgres'in verdigi DATABASE_URL env variable'ini kullanir.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_session (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function readData(id) {
  const res = await pool.query('SELECT data FROM whatsapp_session WHERE id = $1', [id]);
  if (res.rows.length === 0) return null;
  // Buffer'lari (kripto anahtarlari) dogru sekilde geri cevirmek icin BufferJSON.reviver kullanilir
  return JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver);
}

async function writeData(id, value) {
  const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
  await pool.query(
    `INSERT INTO whatsapp_session (id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
    [id, json]
  );
}

async function removeData(id) {
  await pool.query('DELETE FROM whatsapp_session WHERE id = $1', [id]);
}

// Baileys'in useMultiFileAuthState fonksiyonuyla ayni sekli dondurur,
// ama dosya sistemine degil Postgres'e okuyup yazar.
async function usePostgresAuthState() {
  await ensureTable();

  const creds = (await readData('creds')) || initAuthCreds();
  const keys = (await readData('keys')) || {};

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const value = keys[type]?.[id];
            if (value) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            keys[category] = keys[category] || {};
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) {
                keys[category][id] = value;
              } else {
                delete keys[category][id];
              }
            }
          }
          await writeData('keys', keys);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    clearSession: async () => {
      await removeData('creds');
      await removeData('keys');
    },
  };
}

module.exports = { usePostgresAuthState };
