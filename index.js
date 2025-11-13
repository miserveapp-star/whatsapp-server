import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import fs from 'fs';
import pino from 'pino';

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'miserve_whatsapp_2024_SUPERSECRET123';
const AUTH_DIR = './auth_info_baileys';

app.use(cors());
app.use(express.json());

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let phoneNumber = null;

const logger = pino({ level: 'silent' });

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }
  
  const token = authHeader.substring(7);
  
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Token non valido' });
  }
  
  next();
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      // printQRInTerminal rimosso (deprecato)
      logger,
      browser: ['MiServe', 'Chrome', '120.0.0'],
      getMessage: async (key) => {
        return { conversation: '' };
      }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('[WHATSAPP] 📱 QR Code generato');
        connectionStatus = 'qr_ready';
        qrCodeData = await QRCode.toDataURL(qr);
        // Mostra QR in console solo per debug
        qrcode.generate(qr, { small: true });
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log('[WHATSAPP] ❌ Connessione chiusa');
        connectionStatus = 'disconnected';
        phoneNumber = null;
        qrCodeData = null;
        
        if (shouldReconnect) {
          console.log('[WHATSAPP] 🔄 Riconnessione in corso...');
          setTimeout(() => connectToWhatsApp(), 3000);
        } else {
          console.log('[WHATSAPP] 🚫 Logout effettuato');
        }
      } 
      else if (connection === 'open') {
        console.log('[WHATSAPP] ✅ Connesso con successo!');
        connectionStatus = 'connected';
        qrCodeData = null;
        
        const user = sock.user;
        phoneNumber = user?.id?.split(':')[0] || null;
        console.log('[WHATSAPP] 📞 Numero:', phoneNumber);
      }
    });
    
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore connessione:', error);
    setTimeout(() => connectToWhatsApp(), 5000);
  }
}

// Avvia connessione WhatsApp
connectToWhatsApp();

// ROUTES
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MiServe WhatsApp Server',
    version: '1.0.1',
    connectionStatus: connectionStatus,
    connected: connectionStatus === 'connected'
  });
});

app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    qrCode: qrCodeData,
    phoneNumber: phoneNumber,
    timestamp: new Date().toISOString()
  });
});

app.post('/send', authenticate, async (req, res) => {
  try {
    const { phoneNumber: targetNumber, message } = req.body;
    
    if (!targetNumber || !message) {
      return res.status(400).json({ 
        success: false,
        error: 'phoneNumber e message richiesti' 
      });
    }
    
    if (!sock || connectionStatus !== 'connected') {
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp non connesso' 
      });
    }
    
    console.log('[WHATSAPP] 📤 Invio messaggio a:', targetNumber);
    
    const cleanNumber = targetNumber.replace(/\D/g, '');
    const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    
    const result = await sock.sendMessage(jid, { text: message });
    
    console.log('[WHATSAPP] ✅ Messaggio inviato');
    
    res.json({ 
      success: true,
      messageId: result.key.id || Date.now().toString()
    });
    
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore invio:', error);
    res.status(500).json({ 
      success: false,
      error: 'Errore invio messaggio',
      details: error.message 
    });
  }
});

app.post('/disconnect', authenticate, async (req, res) => {
  try {
    console.log('[WHATSAPP] 🔌 Richiesta disconnessione');
    
    if (sock) {
      await sock.logout();
      sock = null;
    }
    
    connectionStatus = 'disconnected';
    phoneNumber = null;
    qrCodeData = null;
    
    console.log('[WHATSAPP] ✅ Disconnesso');
    
    res.json({ success: true });
    
    setTimeout(() => {
      console.log('[WHATSAPP] 🔄 Riavvio connessione...');
      connectToWhatsApp();
    }, 2000);
    
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore disconnessione:', error);
    res.status(500).json({ 
      success: false,
      error: 'Errore disconnessione' 
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server WhatsApp in ascolto su porta ${PORT}`);
  console.log(`🔐 Auth token configurato`);
});