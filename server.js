const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const geoip = require('geoip-lite');
const UAParser = require('ua-parser-js');
const fs = require('fs');
const cookieParser = require('cookie-parser');

app.use(cookieParser());
app.use(express.static('public'));

let db = {
  users: {},
  sessions: []
};

// Load existing data
try {
  const data = fs.readFileSync('database.json', 'utf8');
  db = JSON.parse(data);
} catch (err) {
  console.log('No existing database found, starting fresh');
}

// Save data periodically
setInterval(() => {
  fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
}, 30000);
app.get('/', (req, res) => {
  res.sendFile(__dirname/frontend + '/index.html');
});
app.get('/style.css', (req, res) => {
  res.sendFile(__dirname/frontend + '/style.css');
});
app.get('/script.js', (req, res) => {
  res.sendFile(__dirname/frontend + '/script.js');
});
// Admin route
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

app.get('/api/users', (req, res) => {
  res.json({
    users: db.users,
    sessions: db.sessions
  });
});

// Screen dimensions for simulation
const DEFAULT_SCREEN_WIDTH = 1920;
const DEFAULT_SCREEN_HEIGHT = 1080;

io.on('connection', (socket) => {
  // Handle admin connection
  if (socket.handshake.headers.referer && socket.handshake.headers.referer.includes('/admin')) {
    socket.emit('full_user_data', db.users);
    return;
  }

  // Regular user tracking
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'];
  const cookies = socket.handshake.headers.cookie || '';
  const parser = new UAParser(userAgent);
  const ua = parser.getResult();
  
  // Get or create user ID from cookie
  let userId = cookies.split(';').find(c => c.trim().startsWith('tracking_id='));
  userId = userId ? userId.split('=')[1] : `user-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const geo = geoip.lookup(ip.replace('::ffff:', '').replace('::1', '127.0.0.1'));

  if (!db.users[userId]) {
    db.users[userId] = {
      id: userId,
      ip: ip,
      geo: geo || { country: 'Unknown', city: 'Unknown' },
      device: {
        browser: `${ua.browser.name} ${ua.browser.version}`,
        os: `${ua.os.name} ${ua.os.version}`,
        type: ua.device.type || 'desktop',
        screen: { width: DEFAULT_SCREEN_WIDTH, height: DEFAULT_SCREEN_HEIGHT }
      },
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      totalTime: 0,
      actions: []
    };
  }

  // Send initial data to admin panel
  io.emit('user_update', db.users[userId]);

  // Handle tracking events from client
  socket.on('track_event', (data) => {
    const now = new Date();
    const event = {
      type: data.type,
      data: data.data,
      timestamp: now.toISOString(),
      page: data.page || 'unknown'
    };

    // Initialize actions array if it doesn't exist
    if (!db.users[userId].actions) {
      db.users[userId].actions = [];
    }

    db.users[userId].actions.push(event);
    db.users[userId].lastSeen = now.toISOString();

    io.emit('user_action', { 
      userId, 
      event,
      // Include the full action count for verification
      totalActions: db.users[userId].actions.length 
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const disconnectEvent = {
      type: 'disconnect',
      timestamp: new Date().toISOString()
    };
    
    db.users[userId].actions.push(disconnectEvent);
    
    io.emit('user_action', { 
      userId, 
      event: disconnectEvent,
      totalActions: db.users[userId].actions.length
    });
  });
});

http.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
  console.log('Admin panel at http://localhost:3000/admin');
});