const express = require('express');
const path = require('path');
const multer = require('multer');
const { escape } = require('html-escaper');

const app = express();

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Simple memory storage
const messages = [];
const onlineUsers = new Map();
const fileStorage = new Map();
const serverStartTime = Date.now();

// File upload setup
const upload = multer({ storage: multer.memoryStorage() });

// ===== ROUTES =====

// Serve HTML files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// API Routes
app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, message: 'Nama harus diisi' });
  }
});

// Get all messages
app.get('/api/messages', (req, res) => {
  const userIP = req.ip || 'unknown';
  onlineUsers.set(userIP, Date.now());
  
  // Cleanup offline users (30 seconds)
  const now = Date.now();
  for (const [ip, lastSeen] of onlineUsers.entries()) {
    if (now - lastSeen > 30000) {
      onlineUsers.delete(ip);
    }
  }
  
  res.json({
    messages: messages,
    onlineCount: onlineUsers.size,
    serverUptime: Math.floor((Date.now() - serverStartTime) / 1000)
  });
});

// Send new message
app.post('/api/messages', (req, res) => {
  const { name, text, file, replyTo } = req.body;
  
  if (!name || !text) {
    return res.status(400).json({ success: false, message: 'Nama dan pesan harus diisi' });
  }

  const message = {
    id: Date.now().toString(),
    name: escape(name.trim()),
    text: escape(text.trim()),
    timestamp: new Date().toISOString(),
    file: file || null,
    replyTo: replyTo || null
  };

  // Handle file data
  if (message.file && message.file.content && message.file.content.startsWith('data:')) {
    const fileId = Date.now().toString();
    const matches = message.file.content.match(/^data:(.+);base64,(.+)$/);
    
    if (matches) {
      fileStorage.set(fileId, {
        content: message.file.content,
        type: matches[1],
        name: message.file.name || 'file'
      });
      
      message.file.content = `/api/files/${fileId}`;
    }
  }

  messages.push(message);
  
  // Limit messages to prevent memory issues
  if (messages.length > 200) {
    messages.splice(0, 50);
  }

  res.json({ success: true, message: message });
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Tidak ada file yang diupload' });
  }

  const fileId = Date.now().toString();
  const fileData = {
    name: req.file.originalname,
    type: req.file.mimetype,
    size: req.file.size,
    content: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
  };

  fileStorage.set(fileId, fileData);

  res.json({
    success: true,
    file: {
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size,
      content: `/api/files/${fileId}`
    }
  });
});

// Serve uploaded files
app.get('/api/files/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  const fileData = fileStorage.get(fileId);
  
  if (!fileData) {
    return res.status(404).send('File tidak ditemukan');
  }

  const matches = fileData.content.match(/^data:(.+);base64,(.+)$/);
  if (matches) {
    res.setHeader('Content-Type', matches[1]);
    res.send(Buffer.from(matches[2], 'base64'));
  } else {
    res.status(404).send('File format tidak valid');
  }
});

// Delete message
app.delete('/api/messages/:messageId', (req, res) => {
  const { messageId } = req.params;
  const { password } = req.body;

  if (password !== "12345") {
    return res.status(403).json({ success: false, message: 'Password salah' });
  }

  const index = messages.findIndex(msg => msg.id === messageId);
  if (index !== -1) {
    messages.splice(index, 1);
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
    messages: messages.length,
    onlineUsers: onlineUsers.size,
    files: fileStorage.size
  });
});

// Cleanup old files every hour
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [fileId, fileData] of fileStorage.entries()) {
    if (parseInt(fileId) < oneHourAgo) {
      fileStorage.delete(fileId);
    }
  }
}, 60 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3000;

// Export for Vercel
module.exports = app;

// Only listen locally when not in Vercel
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}
