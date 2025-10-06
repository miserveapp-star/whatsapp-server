const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'miapp-secret-token-2024';

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let phoneNumber = null;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`Using WA version ${version.join('.')}, isLatest: ${isLatest}`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = qr;
      connectionStatus = 'qr_ready';
      console.log('QR Code generato');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connessione chiusa. Riconnessione:', shouldReconnect);
      
      if (shouldReconnect) {
        connectionStatus = 'disconnected';
        qrCodeData = null;
        phoneNumber = null;
        setTimeout(connectToWhatsApp, 3000);
      } else {
        connectionStatus = 'logged_out';
        qrCodeData = null;
        phoneNumber = null;
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      qrCodeData = null;
      phoneNumber = sock.user?.id?.split(':')[0] || null;
      console.log('Connesso a WhatsApp:', phoneNumber);
    } else if (connection === 'connecting') {
      connectionStatus = 'connecting';
      console.log('Connessione in corso...');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    console.log('Nuovo messaggio ricevuto:', JSON.stringify(m, null, 2));
  });
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'MiApp WhatsApp Server',
    version: '1.0.0'
  });
});

app.get('/status', (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  res.json({
    status: connectionStatus,
    phoneNumber: phoneNumber,
    qrCode: qrCodeData,
    timestamp: new Date().toISOString()
  });
});

app.post('/send', async (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ 
      error: 'WhatsApp non connesso',
      status: connectionStatus 
    });
  }

  const { phoneNumber: recipient, message } = req.body;

  if (!recipient || !message) {
    return res.status(400).json({ error: 'phoneNumber e message sono obbligatori' });
  }

  try {
    const formattedNumber = recipient.replace(/\D/g, '');
    const jid = formattedNumber + '@s.whatsapp.net';

    await sock.sendMessage(jid, { text: message });

    res.json({ 
      success: true, 
      message: 'Messaggio inviato',
      to: recipient,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Errore invio messaggio:', error);
    res.status(500).json({ 
      error: 'Errore invio messaggio',
      details: error.message 
    });
  }
});

app.post('/disconnect', async (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  if (sock) {
    await sock.logout();
    connectionStatus = 'logged_out';
    qrCodeData = null;
    phoneNumber = null;
    res.json({ success: true, message: 'Disconnesso da WhatsApp' });
  } else {
    res.json({ success: false, message: 'Nessuna connessione attiva' });
  }
});

app.listen(PORT, () => {
  console.log(`Server avviato su porta ${PORT}`);
  connectToWhatsApp();
});