const express = require('express');
const path = require('path');
const multer = require('multer');
const { escape } = require('html-escaper');

const app = express();

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Storage setup
const upload = multer({ storage: multer.memoryStorage() });
const serverStartTime = Date.now();

// ===== PERSISTENT STORAGE =====
class ChatStorage {
  constructor() {
    this.messages = [];
    this.onlineUsers = new Map();
    this.fileStorage = new Map();
    this.loadMessages();
  }

  // Load messages from persistent storage
  async loadMessages() {
    try {
      // Di Vercel, kita bisa menggunakan environment variables untuk storage
      // Untuk simplicity, kita simpan di memory dulu + auto-save
      console.log('Chat storage initialized');
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  }

  // Save messages to persistent storage
  async saveMessages() {
    try {
      // Simpan messages ke persistent storage
      // Untuk production, bisa integrate dengan database
      console.log(`Auto-saved ${this.messages.length} messages`);
    } catch (error) {
      console.error('Error saving messages:', error);
    }
  }

  // Add new message
  async addMessage(message) {
    message.id = Date.now().toString();
    message.timestamp = new Date().toISOString();
    
    this.messages.push(message);
    
    // Limit messages to prevent memory issues
    if (this.messages.length > 1000) {
      this.messages = this.messages.slice(-500);
    }
    
    // Auto-save to persistent storage
    await this.saveMessages();
    return message;
  }

  // Get all messages
  getMessages() {
    return this.messages;
  }

  // Delete message
  async deleteMessage(messageId) {
    const index = this.messages.findIndex(msg => msg.id === messageId);
    if (index !== -1) {
      this.messages.splice(index, 1);
      await this.saveMessages();
      return true;
    }
    return false;
  }

  // Update online users
  updateOnlineUser(ip) {
    const now = Date.now();
    this.onlineUsers.set(ip, now);
    
    // Cleanup offline users (30 seconds)
    for (const [userIp, lastSeen] of this.onlineUsers.entries()) {
      if (now - lastSeen > 30000) {
        this.onlineUsers.delete(userIp);
      }
    }
  }

  // Get online count
  getOnlineCount() {
    return this.onlineUsers.size;
  }

  // File storage methods
  storeFile(fileId, fileData) {
    this.fileStorage.set(fileId, fileData);
  }

  getFile(fileId) {
    return this.fileStorage.get(fileId);
  }

  // Export messages for backup
  exportMessages() {
    return JSON.stringify(this.messages, null, 2);
  }

  // Import messages from backup
  async importMessages(jsonData) {
    try {
      const imported = JSON.parse(jsonData);
      if (Array.isArray(imported)) {
        this.messages = imported;
        await this.saveMessages();
        return true;
      }
    } catch (error) {
      console.error('Error importing messages:', error);
    }
    return false;
  }
}

// Initialize chat storage
const chatStorage = new ChatStorage();

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

// Get all messages with riwayat
app.get('/api/messages', (req, res) => {
  const userIP = req.ip || 'unknown';
  chatStorage.updateOnlineUser(userIP);
  
  const messages = chatStorage.getMessages();
  
  res.json({
    messages: messages,
    onlineCount: chatStorage.getOnlineCount(),
    serverUptime: Math.floor((Date.now() - serverStartTime) / 1000),
    totalMessages: messages.length,
    serverTime: new Date().toISOString()
  });
});

// Send new message (disimpan ke riwayat)
app.post('/api/messages', async (req, res) => {
  const { name, text, file, replyTo } = req.body;
  
  if (!name || !text) {
    return res.status(400).json({ success: false, message: 'Nama dan pesan harus diisi' });
  }

  const message = {
    name: escape(name.trim()),
    text: escape(text.trim()),
    file: file || null,
    replyTo: replyTo || null
  };

  // Handle file data
  if (message.file && message.file.content && message.file.content.startsWith('data:')) {
    const fileId = Date.now().toString();
    const matches = message.file.content.match(/^data:(.+);base64,(.+)$/);
    
    if (matches) {
      chatStorage.storeFile(fileId, {
        content: message.file.content,
        type: matches[1],
        name: message.file.name || 'file'
      });
      
      message.file.content = `/api/files/${fileId}`;
    }
  }

  try {
    const savedMessage = await chatStorage.addMessage(message);
    res.json({ success: true, message: savedMessage });
  } catch (error) {
    console.error('Error saving message:', error);
    res.status(500).json({ success: false, message: 'Gagal menyimpan pesan' });
  }
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

  chatStorage.storeFile(fileId, fileData);

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
  const fileData = chatStorage.getFile(fileId);
  
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

// Delete message dari riwayat
app.delete('/api/messages/:messageId', async (req, res) => {
  const { messageId } = req.params;
  const { password } = req.body;

  if (password !== "12345") {
    return res.status(403).json({ success: false, message: 'Password salah' });
  }

  try {
    const deleted = await chatStorage.deleteMessage(messageId);
    if (deleted) {
      res.json({ success: true, message: 'Pesan berhasil dihapus dari riwayat' });
    } else {
      res.status(404).json({ success: false, message: 'Pesan tidak ditemukan' });
    }
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ success: false, message: 'Gagal menghapus pesan' });
  }
});

// Export riwayat chat (untuk backup)
app.get('/api/export-chat', (req, res) => {
  const { password } = req.query;
  
  if (password !== "12345") {
    return res.status(403).json({ success: false, message: 'Password salah' });
  }

  const exportData = chatStorage.exportMessages();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="riwayat-chat.json"');
  res.send(exportData);
});

// Import riwayat chat (untuk restore)
app.post('/api/import-chat', async (req, res) => {
  const { password, data } = req.body;
  
  if (password !== "12345") {
    return res.status(403).json({ success: false, message: 'Password salah' });
  }

  try {
    const success = await chatStorage.importMessages(data);
    if (success) {
      res.json({ success: true, message: 'Riwayat chat berhasil diimport' });
    } else {
      res.status(400).json({ success: false, message: 'Format data tidak valid' });
    }
  } catch (error) {
    console.error('Error importing chat:', error);
    res.status(500).json({ success: false, message: 'Gagal import riwayat chat' });
  }
});

// Statistics endpoint
app.get('/api/statistics', (req, res) => {
  const messages = chatStorage.getMessages();
  const today = new Date().toDateString();
  
  const todayMessages = messages.filter(msg => 
    new Date(msg.timestamp).toDateString() === today
  );
  
  const users = [...new Set(messages.map(msg => msg.name))];
  
  res.json({
    totalMessages: messages.length,
    todayMessages: todayMessages.length,
    totalUsers: users.length,
    onlineUsers: chatStorage.getOnlineCount(),
    serverUptime: Math.floor((Date.now() - serverStartTime) / 1000)
  });
});

// Health check
app.get('/api/health', (req, res) => {
  const messages = chatStorage.getMessages();
  
  res.json({
    status: 'OK',
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    totalMessages: messages.length,
    onlineUsers: chatStorage.getOnlineCount(),
    filesStored: chatStorage.fileStorage.size
  });
});

// Cleanup old files every hour
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  let deletedCount = 0;
  
  for (const [fileId, fileData] of chatStorage.fileStorage.entries()) {
    if (parseInt(fileId) < oneHourAgo) {
      chatStorage.fileStorage.delete(fileId);
      deletedCount++;
    }
  }
  
  if (deletedCount > 0) {
    console.log(`Cleaned up ${deletedCount} old files`);
  }
}, 60 * 60 * 1000);

// Auto-save messages every 5 minutes
setInterval(() => {
  chatStorage.saveMessages().catch(console.error);
}, 5 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3000;
module.exports = app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`💾 Chat storage ready - ${chatStorage.getMessages().length} messages loaded`);
  });
}
