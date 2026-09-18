require('dotenv').config();

const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { usePostgresAuthState } = require('./pgAuthState');
const { askClaude } = require('./claudeClient');
const { buildSystemPrompt } = require('./prompt');

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IMAGES_DIR = path.join(__dirname, 'images');

// ---------------------------------------------------------------------------
// Urun listesi. products.json'u kendi urunlerinizle guncelleyin; sistem
// promptu bu listeden otomatik uretilir (bkz. prompt.js).
// ---------------------------------------------------------------------------
let PRODUCTS = {};
try {
  PRODUCTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));
} catch (e) {
  console.warn('products.json okunamadi, urun listesi bos olacak.');
}
const SYSTEM_PROMPT = buildSystemPrompt(PRODUCTS);

function bekle(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function rastgeleBekle(minSn, maxSn) {
  const ms = (Math.random() * (maxSn - minSn) + minSn) * 1000;
  return bekle(Math.round(ms));
}

// ---------------------------------------------------------------------------
// Musteri basina oturum: konusma gecmisi + hangi urun gorselleri gonderildi.
// RAM icinde tutulur (restart olunca sifirlanir). Uzun konusmalarda maliyeti
// kontrol altinda tutmak icin gecmis belirli bir uzunlukta tutulur.
// ---------------------------------------------------------------------------
const sessions = {};
const MAX_HISTORY = 30;

function getSession(jid) {
  if (!sessions[jid]) {
    sessions[jid] = { conversation: [], sentImageCodes: new Set() };
  }
  return sessions[jid];
}
function resetSession(jid) {
  sessions[jid] = { conversation: [], sentImageCodes: new Set() };
}

// ---------------------------------------------------------------------------
// Mesaj toplama (musteri art arda birden fazla mesaj yazarsa hepsini
// birlestirip TEK seferde islemek icin) + hesap geneli sirali gonderim
// (birden fazla musteriye ayni anda paralel cevap uretmek "bot gibi"
// algilanip hesabin kisitlanmasina yol acabilir, bu yuzden global bir
// kuyruk uzerinden sirayla islenir).
// ---------------------------------------------------------------------------
const pending = {}; // jid -> { texts: [], timer }
const MESAJ_BEKLEME_MS = 8000;
let islemKuyrugu = Promise.resolve();

function kuyruklaIsle(fn) {
  islemKuyrugu = islemKuyrugu.then(fn).catch((err) => console.error('Kuyruk hatasi:', err));
  return islemKuyrugu;
}

function mesajPlanla(jid, text, sock) {
  if (!pending[jid]) pending[jid] = { texts: [], timer: null };
  pending[jid].texts.push(text);
  if (pending[jid].timer) clearTimeout(pending[jid].timer);
  pending[jid].timer = setTimeout(() => {
    const texts = pending[jid].texts.splice(0);
    pending[jid].timer = null;
    if (texts.length === 0) return;
    const birlesik = texts.join(' ').trim();
    kuyruklaIsle(() => islemGoster(sock, jid, birlesik));
  }, MESAJ_BEKLEME_MS);
}

// ---------------------------------------------------------------------------
// Urun kodu tespiti: musterinin ham metninde products.json'daki kodlardan
// biri geciyor mu (kisa yazim / bastaki sifirlar olmadan da eslesir).
// Gorsel gonderme bu tespite dayanir - Claude'un dogru "marker" yazmasina
// GUVENMEYIZ, kod tarafinda deterministik olarak kontrol ederiz.
// ---------------------------------------------------------------------------
function metindeGecenUrunKodlari(text) {
  const bulunanlar = new Set();
  const adaylar = text.match(/\b\d{1,6}\b/g) || [];
  for (const raw of adaylar) {
    if (PRODUCTS[raw]) { bulunanlar.add(raw); continue; }
    const dolgulu = raw.padStart(4, '0');
    if (PRODUCTS[dolgulu]) { bulunanlar.add(dolgulu); continue; }
  }
  return [...bulunanlar];
}

function urunGorselYolu(kod) {
  const uzantilar = ['.jpg', '.jpeg', '.png', '.webp'];
  for (const uzanti of uzantilar) {
    const p = path.join(IMAGES_DIR, kod + uzanti);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function urunGorselleriGonder(sock, jid, kodlar) {
  for (const kod of kodlar) {
    const yol = urunGorselYolu(kod);
    if (!yol) {
      console.warn(`Gorsel bulunamadi: images/${kod}.(jpg|png|webp) - dosyayi ekleyin.`);
      continue;
    }
    try {
      await sock.sendMessage(jid, { image: fs.readFileSync(yol) });
    } catch (err) {
      console.error('Gorsel gonderilemedi:', kod, err.message);
    }
    await rastgeleBekle(0.6, 1.2);
  }
}

// ---------------------------------------------------------------------------
// Siparis JSON blogunu ayikla
// ---------------------------------------------------------------------------
function siparisiParsEt(metin) {
  const m = metin.match(/###SIPARIS_BASLA###([\s\S]*?)###SIPARIS_BITIS###/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch (e) {
    return { __parseHatasi: true, __hamMetin: m[1].trim() };
  }
}
function siparisGecerliMi(siparis) {
  const zorunlu = ['ad_soyad', 'telefon', 'adres', 'urun', 'beden', 'adet'];
  const eksikler = zorunlu.filter((k) => !siparis[k] || String(siparis[k]).trim() === '');
  return { gecerli: eksikler.length === 0, eksikler };
}

async function telegramGonder(siparis, whatsappNumber, deneme = 0) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID tanimli degil, bildirim atlanıyor.');
    return;
  }
  const toplamSatiri = siparis.toplam ? `\nToplam: ${siparis.toplam} TL` : '';
  const text =
    `🆕 YENİ SİPARİŞ (Kapıda Ödeme)\n\n` +
    `Ad Soyad: ${siparis.ad_soyad}\n` +
    `Telefon: ${siparis.telefon}\n` +
    `Adres: ${siparis.adres}\n` +
    `Ürün: ${siparis.urun}\n` +
    `Beden: ${siparis.beden}\n` +
    `Adet: ${siparis.adet}` +
    toplamSatiri +
    `\nWhatsApp No: ${whatsappNumber}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    console.error('Telegram gonderim hatasi:', err.message);
    if (deneme < 2) {
      await bekle(3000);
      return telegramGonder(siparis, whatsappNumber, deneme + 1);
    }
  }
}

async function telegramGonderHam(hamMetin) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const text = '⚠️ SİPARİŞ FORMATI BOZUK — MANUEL KONTROL GEREKİYOR!\n\n' + hamMetin;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (err) {
    console.error('Telegram (ham) gonderim hatasi:', err.message);
  }
}

function isCancelWord(text) {
  const t = text.trim().toLowerCase();
  return ['iptal', 'vazgeç', 'vazgec'].includes(t);
}

// ---------------------------------------------------------------------------
// Bir musterinin biriken mesajini isler: gorsel gonderir, Claude'a sorar,
// siparis JSON'unu yakalar, cevabi WhatsApp'a gonderir.
// ---------------------------------------------------------------------------
async function islemGoster(sock, jid, birlesikMetin) {
  const session = getSession(jid);

  if (isCancelWord(birlesikMetin)) {
    resetSession(jid);
    await insanGibiGonder(sock, jid, 'Siparişiniz iptal edildi. Tekrar başlamak isterseniz ürün kodunu yazabilirsiniz.');
    return;
  }

  // Kod tespiti + gorsel gonderme (Claude'dan BAGIMSIZ, deterministik)
  const kodlar = metindeGecenUrunKodlari(birlesikMetin).filter((k) => !session.sentImageCodes.has(k));
  if (kodlar.length > 0) {
    await urunGorselleriGonder(sock, jid, kodlar);
    kodlar.forEach((k) => session.sentImageCodes.add(k));
  }

  session.conversation.push({ role: 'user', content: birlesikMetin });
  if (session.conversation.length > MAX_HISTORY) {
    session.conversation = session.conversation.slice(-MAX_HISTORY);
  }

  let yanit;
  try {
    console.log('-> Claude APIye istek gonderiliyor, JID:', jid, 'Mesaj:', birlesikMetin);
    yanit = await askClaude(session.conversation, SYSTEM_PROMPT);
    console.log('<- Claude APIden yanit basariyla alindi. Yanit uzunlugu:', yanit ? yanit.length : 0);
    console.log('<- Claude Yaniti:', yanit);
  } catch (err) {
    console.error('Claude hatasi yakalandi:', err.message);
    await insanGibiGonder(sock, jid, 'Şu an teknik bir sorun var, birazdan tekrar yazabilir misiniz?');
    session.conversation.pop(); // basarisiz turu gecmisten cikar
    return;
  }

  const temizMetin = yanit.replace(/###SIPARIS_BASLA###[\s\S]*?###SIPARIS_BITIS###/g, '').trim();
  session.conversation.push({ role: 'assistant', content: temizMetin });

  if (temizMetin) {
    await insanGibiGonder(sock, jid, temizMetin);
  }

  const siparis = siparisiParsEt(yanit);
  if (siparis) {
    if (siparis.__parseHatasi) {
      await telegramGonderHam(siparis.__hamMetin);
      resetSession(jid);
    } else {
      const { gecerli, eksikler } = siparisGecerliMi(siparis);
      if (gecerli) {
        await telegramGonder(siparis, jid.split('@')[0]);
        resetSession(jid); // siparis tamamlandi, sonraki mesaj yeni bir siparis gibi baslasin
      } else {
        console.error('SİPARİŞ EKSİK ALANLA GELDİ:', eksikler.join(', '));
        await telegramGonderHam('⚠️ EKSİK ALAN(LAR): ' + eksikler.join(', ') + '\n\n' + JSON.stringify(siparis, null, 2));
      }
    }
  }
}

async function insanGibiGonder(sock, jid, text) {
  try {
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  } catch (e) {
    // yoksay
  }
  await rastgeleBekle(1, 3);
  await sock.sendMessage(jid, { text });
  await sock.sendPresenceUpdate('paused', jid).catch(() => {});
}

// ---------------------------------------------------------------------------
// Express: saglik kontrolu + QR kodu goruntuleme sayfasi
// ---------------------------------------------------------------------------
const app = express();
let latestQR = null;
let connectionStatus = 'Başlatılıyor...';

app.get('/', (req, res) => {
  res.send(`Bot durumu: ${connectionStatus}. QR kodu için /qr adresine gidin.`);
});

app.get('/qr', async (req, res) => {
  if (connectionStatus === 'Bağlandı') {
    return res.send('WhatsApp zaten bağlı. Yeni QR kod gerekmiyor.');
  }
  if (!latestQR) {
    return res.send('QR kodu henüz üretilmedi, birkaç saniye sonra sayfayı yenileyin.');
  }
  try {
    const dataUrl = await QRCode.toDataURL(latestQR);
    res.send(`
      <html>
        <body style="text-align:center; font-family: sans-serif;">
          <h2>WhatsApp'ı Bağla</h2>
          <p>WhatsApp &gt; Ayarlar &gt; Bağlı Cihazlar &gt; Cihaz Bağla ile bu kodu tarayın.</p>
          <img src="${dataUrl}" />
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('QR kodu oluşturulamadı: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Web sunucu ${PORT} portunda çalışıyor. QR için /qr adresini açın.`);
});

// ---------------------------------------------------------------------------
// Baileys ile WhatsApp baglantisi
// ---------------------------------------------------------------------------
let isReconnecting = false;
let currentSock = null;

async function startBot() {
  const { state, saveCreds, clearSession } = await usePostgresAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
  });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = 'QR kodu bekleniyor';
    }

    if (connection === 'open') {
      isReconnecting = false;
      connectionStatus = 'Bağlandı';
      latestQR = null;
      console.log('WhatsApp bağlantısı başarılı.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const conflict = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;
      console.log('Bağlantı kapandı.', statusCode, '- Çıkış yapıldı mı:', loggedOut, '- Çakışma mı:', conflict);

      sock.ev.removeAllListeners();

      if (isReconnecting) {
        return;
      }
      isReconnecting = true;

      if (loggedOut) {
        connectionStatus = 'Çıkış yapıldı, yeni QR hazırlanıyor...';
        latestQR = null;
        clearSession()
          .catch((err) => console.error('Oturum temizlenirken hata:', err))
          .finally(() => {
            setTimeout(() => startBot(), 3000);
          });
      } else if (conflict) {
        connectionStatus = 'Çakışma tespit edildi, bekleniyor...';
        setTimeout(() => startBot(), 10000);
      } else {
        connectionStatus = 'Bağlantı koptu, yeniden bağlanılıyor...';
        setTimeout(() => startBot(), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const jid = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!text) continue;

      mesajPlanla(jid, text, sock);
    }
  });
}

startBot().catch((err) => {
  console.error('Bot başlatılamadı:', err);
});
