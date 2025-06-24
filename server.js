const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const geoip = require('geoip-lite');
const UAParser = require('ua-parser-js');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const axios = require('axios');

app.use(cookieParser());
app.use(express.static('public'));
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb'}));


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

// --- Add this API endpoint for Ollama profile generation ---
app.post('/api/generate-profile', async (req, res) => {
  try {
    const { userId, actions } = req.body;
    if (!actions || !Array.isArray(actions)) {
      return res.status(400).json({ error: 'Invalid actions' });
    }

    // Take the last 10-20 actions as a sample (adjust as needed)
    const sampleActions = actions.slice(-20);

    // Pre-process for summary
    const pageViews = actions.filter(a => a.type === 'page_view');
    const clicks = actions.filter(a => a.type === 'click');
    const keystrokes = actions.filter(a => a.type === 'keystroke');
    const topPages = {};
    pageViews.forEach(a => {
      const url = a.data?.url || 'unknown';
      topPages[url] = (topPages[url] || 0) + 1;
    });
    const sortedPages = Object.entries(topPages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([url, count]) => `${url} (${count} views)`)
      .join(', ');

    const keystrokeSamples = keystrokes.slice(0, 3).map(k => k.data?.value).filter(Boolean);

    // Compose a prompt with real action data
    const prompt = `
Given this user's real session data, generate:
1. An advertising profile (interests, likely demographics, possible purchase intent, etc).
2. A concise summary of the user's behavior.

Session summary:
- Top pages: ${sortedPages || 'none'}
- Total clicks: ${clicks.length}
- Example keystrokes: ${keystrokeSamples.join('; ') || 'none'}

Here are actual user actions (JSON array, most recent first):
${JSON.stringify(sampleActions, null, 2)}
You are should generate a detailed profile based on this data, focusing on what elements they click on the most and where they move their mouse to the most.
The content of the website is the shop page for my OBD devices, so provide me with key advertising insights based on this context and what features the user is most likely interested in and how i can get them to buy the device and the purpose of this is to increase conversion rates on my stores website`;

    // Call Ollama
    const ollamaRes = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma3:1b',
        prompt: prompt,
        stream: false
      })
    });

    if (!ollamaRes.ok) {
      return res.status(500).json({ error: 'Ollama request failed' });
    }
    const ollamaData = await ollamaRes.json();
    res.json({ result: ollamaData.response || ollamaData.message || 'No response from model.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- New endpoint for advanced user analysis with timeframe and metrics ---
app.post('/api/analyze-user', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    // Read fresh data from file
    const rawData = fs.readFileSync('database.json', 'utf8');
    const db = JSON.parse(rawData);
    
    const { userId, startTime, endTime } = req.body;
    
    if (!db.users || !db.users[userId]) {
      return res.status(404).json({ 
        error: 'User not found',
        availableUsers: Object.keys(db.users || {}) 
      });
    }

    const user = db.users[userId];
    
    // Ensure actions array exists
    if (!user.actions) {
      user.actions = [];
    }

    // Filter actions by timeframe if specified
    const filteredActions = user.actions.filter(action => {
      try {
        const actionTime = new Date(action.timestamp);
        return (!startTime || actionTime >= new Date(startTime)) && 
               (!endTime || actionTime <= new Date(endTime));
      } catch (e) {
        console.error('Error parsing action timestamp:', action.timestamp);
        return false;
      }
    });

    // Calculate behavior metrics
    const firstSeen = new Date(user.firstSeen || user.actions[0]?.timestamp || Date.now());
    const lastSeen = new Date(user.lastSeen || user.actions.slice(-1)[0]?.timestamp || Date.now());
    const sessionDuration = (lastSeen - firstSeen) / 1000;
    
    const clickActions = filteredActions.filter(a => a.type === 'click');
    const pageViews = filteredActions.filter(a => a.type === 'page_view');
    const lastPage = pageViews.slice(-1)[0]?.data?.url;

    // Prepare the response data
    const responseData = {
      userId,
      userInfo: {
        ip: user.ip,
        geo: user.geo || {},
        device: user.device || {},
        firstSeen: firstSeen.toISOString(),
        lastSeen: lastSeen.toISOString(),
        totalTime: user.totalTime || sessionDuration
      },
      metrics: {
        totalActions: filteredActions.length,
        sessionDuration,
        actionsPerMinute: filteredActions.length / (sessionDuration / 60),
        clickCount: clickActions.length,
        pageViewCount: pageViews.length,
        lastPage,
        actionTypes: filteredActions.reduce((acc, action) => {
          acc[action.type] = (acc[action.type] || 0) + 1;
          return acc;
        }, {})
      },
      sampleActions: filteredActions.slice(0, 5).map(action => ({
        type: action.type,
        timestamp: action.timestamp,
        data: action.data ? Object.keys(action.data) : null
      }))
    };

    // Prepare analysis prompt
    const prompt = `Analyze this user behavior data:
    
User: ${userId}
Location: ${responseData.userInfo.geo.city || 'Unknown'}, ${responseData.userInfo.geo.country || 'Unknown'}
Device: ${responseData.userInfo.device.browser || 'Unknown'} on ${responseData.userInfo.device.os || 'Unknown OS'}
Session: ${Math.round(responseData.metrics.sessionDuration)} seconds
Actions: ${responseData.metrics.totalActions} (${Object.entries(responseData.metrics.actionTypes).map(([k,v]) => `${k}:${v}`).join(', ')})

Last page viewed: ${responseData.metrics.lastPage || 'unknown'}

Please analyze:
1. Engagement patterns
2. Potential interests
3. Any unusual behavior
4. Suggested optimization opportunities`;

    // Get AI analysis
    const ollamaResponse = await axios.post('http://localhost:11434/api/generate', {
      model: 'gemma3:1b',
      prompt: prompt,
      stream: false
    });

    // Return complete response
    res.json({
      success: true,
      analysis: ollamaResponse.data.response,
      data: responseData,
      debug: {
        rawUserData: user,
        filteredActionCount: filteredActions.length
      }
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ 
      error: 'Analysis failed',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});