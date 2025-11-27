const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const { escape } = require('html-escaper');

const app = express();

// In-memory storage untuk Vercel
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// Server setup
const serverStartTime = Date.now();
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Data storage in-memory untuk Vercel
let onlineUsers = [];
let messages = [];
const deletePassword = "12345";
const fileStorage = new Map();

// Simulate "online" users dengan timestamp
const updateOnlineUser = (ip) => {
  const now = Date.now();
  const existingUser = onlineUsers.find(user => user.ip === ip);
  
  if (existingUser) {
    existingUser.lastSeen = now;
  } else {
    onlineUsers.push({ 
      ip, 
      lastSeen: now,
      name: `User-${Math.random().toString(36).substr(2, 5)}`
    });
  }
  
  // Hapus user yang inactive > 30 detik
  onlineUsers = onlineUsers.filter(user => now - user.lastSeen < 30000);
};

// Routes
app.get('/login', (req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(publicDir, 'chat.html'));
});

app.get('/chat-history', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  updateOnlineUser(ip);
  res.json(messages);
});

app.get('/chat-updates', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  updateOnlineUser(ip);
  
  const since = req.query.since || 0;
  const newMessages = messages.filter(msg => 
    new Date(msg.timestamp).getTime() > since
  );
  
  res.json({
    messages: newMessages,
    onlineUsers: onlineUsers.length,
    serverUptime: Math.floor((Date.now() - serverStartTime) / 1000),
    lastUpdate: Date.now()
  });
});

app.post('/login', express.json(), (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, message: 'Semua data harus diisi' });
  }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded or file too large.' });
  }
  
  const fileId = Date.now().toString();
  fileStorage.set(fileId, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
    originalname: req.file.originalname,
    size: req.file.size
  });

  const fileData = {
    filename: req.file.originalname,
    path: `/api/file/${fileId}`,
    mimetype: req.file.mimetype,
    fileId: fileId,
    size: req.file.size
  };
  
  res.json({ success: true, file: fileData });
});

app.get('/api/file/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  const fileData = fileStorage.get(fileId);
  
  if (!fileData) {
    return res.status(404).send('File not found');
  }
  
  res.setHeader('Content-Type', fileData.mimetype);
  res.setHeader('Content-Length', fileData.size);
  res.send(fileData.buffer);
});

app.post('/send-message', express.json(), (req, res) => {
  const { name, text, file, replyTo } = req.body;
  
  if (!name || !text) {
    return res.status(400).json({ success: false, message: 'Nama dan pesan harus diisi' });
  }

  const message = {
    name: escape(name.trim()),
    text: escape(text.trim()),
    timestamp: new Date().toISOString(),
    file: file || null,
    replyTo: replyTo || null
  };

  // Handle file data
  if (message.file && message.file.content && message.file.content.startsWith('data:')) {
    const matches = message.file.content.match(/^data:(.+);base64,(.+)$/);
    if (matches && matches[2]) {
      const fileId = Date.now().toString();
      const buffer = Buffer.from(matches[2], 'base64');
      
      fileStorage.set(fileId, {
        buffer: buffer,
        mimetype: matches[1],
        originalname: message.file.name || 'file',
        size: buffer.length
      });
      
      message.file.content = `/api/file/${fileId}`;
    }
  }

  messages.push(message);
  
  // Batasi messages di memory
  if (messages.length > 500) {
    messages = messages.slice(-250);
  }

  res.json({ success: true, message: message });
});

app.post('/delete-message', (req, res) => {
  const { timestamp, password } = req.body;
  if (password !== deletePassword) {
    return res.status(403).json({ success: false, message: 'Akses ditolak: password salah.' });
  }

  const initialLength = messages.length;
  messages = messages.filter(message => message.timestamp !== timestamp);
  
  if (messages.length < initialLength) {
    res.json({ success: true, message: 'Pesan berhasil dihapus' });
  } else {
    res.status(404).json({ success: false, message: 'Pesan tidak ditemukan' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    onlineUsers: onlineUsers.length,
    totalMessages: messages.length,
    totalFiles: fileStorage.size
  });
});

app.get('/', (req, res) => {
  res.redirect('/login');
});

// Cleanup interval
setInterval(() => {
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  let deletedCount = 0;
  
  for (const [fileId, fileData] of fileStorage.entries()) {
    const fileTimestamp = parseInt(fileId);
    if (fileTimestamp < twentyFourHoursAgo) {
      fileStorage.delete(fileId);
      deletedCount++;
    }
  }
  
  if (deletedCount > 0) {
    console.log(`Cleaned up ${deletedCount} old files`);
  }
}, 60 * 60 * 1000);

// Start Server
const PORT = process.env.PORT || 3000;
module.exports = app;

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}/login`);
    console.log('📡 Mode: HTTP Polling (Vercel Compatible)');
  });
}
