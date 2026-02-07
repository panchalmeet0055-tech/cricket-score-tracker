const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Initialize SQLite database
const db = new Database('cricket.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    team1_name TEXT NOT NULL,
    team2_name TEXT NOT NULL,
    team1_score INTEGER DEFAULT 0,
    team1_wickets INTEGER DEFAULT 0,
    team1_overs REAL DEFAULT 0.0,
    team2_score INTEGER DEFAULT 0,
    team2_wickets INTEGER DEFAULT 0,
    team2_overs REAL DEFAULT 0.0,
    status TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming', 'live', 'completed')),
    current_batting TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('photo', 'video')),
    source TEXT NOT NULL CHECK(source IN ('raspberry_pi', 'esp32')),
    captured_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (captured_by) REFERENCES users(id)
  );
`);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/captures', express.static('public/captures'));

const sessionMiddleware = session({
  secret: 'cricket-score-tracker-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);

// Share session with Socket.IO
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden - Admin access required' });
  }
  next();
};

// Camera stream URLs (configure these based on your devices)
let cameraConfig = {
  raspberryPi: {
    url: 'http://raspberrypi.local:8080/stream',
    enabled: true
  },
  esp32: {
    url: 'http://192.168.1.9:81/stream',
    enabled: true
  }
};

// AUTH ROUTES
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const id = uuidv4();

    db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)')
      .run(id, username, hashedPassword, role);

    res.json({ success: true, message: 'Registration successful' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role
    };

    res.json({ 
      success: true, 
      user: { username: user.username, role: user.role }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// MATCH/SCORE ROUTES
app.get('/api/matches', (req, res) => {
  const matches = db.prepare('SELECT * FROM matches ORDER BY created_at DESC').all();
  res.json(matches);
});

app.get('/api/matches/:id', (req, res) => {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!match) {
    return res.status(404).json({ error: 'Match not found' });
  }
  res.json(match);
});

app.post('/api/matches', requireAdmin, (req, res) => {
  try {
    const { team1_name, team2_name, status = 'upcoming' } = req.body;

    if (!team1_name || !team2_name) {
      return res.status(400).json({ error: 'Both team names are required' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO matches (id, team1_name, team2_name, status, current_batting)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, team1_name, team2_name, status, team1_name);

    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    
    io.emit('match:created', match);
    res.json(match);
  } catch (error) {
    console.error('Create match error:', error);
    res.status(500).json({ error: 'Failed to create match' });
  }
});

app.put('/api/matches/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existingMatch = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    if (!existingMatch) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const allowedFields = [
      'team1_name', 'team2_name', 'team1_score', 'team1_wickets', 'team1_overs',
      'team2_score', 'team2_wickets', 'team2_overs', 'status', 'current_batting'
    ];

    const setClauses = [];
    const values = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    db.prepare(`UPDATE matches SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    
    io.emit('match:updated', match);
    res.json(match);
  } catch (error) {
    console.error('Update match error:', error);
    res.status(500).json({ error: 'Failed to update match' });
  }
});

app.delete('/api/matches/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    
    const result = db.prepare('DELETE FROM matches WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    io.emit('match:deleted', { id });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete match error:', error);
    res.status(500).json({ error: 'Failed to delete match' });
  }
});

// STREAM PROXY ROUTES (to bypass CORS)
app.get('/api/stream/:camera', requireAuth, (req, res) => {
  const { camera } = req.params;
  
  let streamUrl;
  if (camera === 'esp32' && cameraConfig.esp32.enabled) {
    streamUrl = cameraConfig.esp32.url;
  } else if (camera === 'raspberrypi' && cameraConfig.raspberryPi.enabled) {
    streamUrl = cameraConfig.raspberryPi.url;
  } else {
    return res.status(404).json({ error: 'Camera not found or disabled' });
  }

  // Proxy the MJPEG stream
  const proxyReq = http.request(streamUrl, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`Stream proxy error for ${camera}:`, err.message);
    if (!res.headersSent) {
      res.status(503).json({ error: 'Camera stream unavailable' });
    }
  });

  req.on('close', () => {
    proxyReq.destroy();
  });

  proxyReq.end();
});

// Single frame capture from camera (for photo capture)
app.get('/api/snapshot/:camera', requireAuth, async (req, res) => {
  const { camera } = req.params;
  
  let snapshotUrl;
  if (camera === 'esp32' && cameraConfig.esp32.enabled) {
    // ESP32 CameraWebServer: stream is at :81/stream, capture is at port 80 /capture
    try {
      const streamUrl = new URL(cameraConfig.esp32.url);
      // Capture endpoint is on port 80, not 81
      snapshotUrl = `${streamUrl.protocol}//${streamUrl.hostname}/capture`;
    } catch (e) {
      snapshotUrl = 'http://192.168.1.9/capture';
    }
  } else if (camera === 'raspberrypi' && cameraConfig.raspberryPi.enabled) {
    snapshotUrl = cameraConfig.raspberryPi.url.replace('/stream', '/snapshot');
  } else {
    return res.status(404).json({ error: 'Camera not found or disabled' });
  }

  console.log(`Fetching snapshot from: ${snapshotUrl}`);

  try {
    const proxyReq = http.request(snapshotUrl, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'no-cache'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`Snapshot error for ${camera}:`, err.message);
      if (!res.headersSent) {
        res.status(503).json({ error: 'Camera snapshot unavailable' });
      }
    });

    proxyReq.end();
  } catch (error) {
    res.status(503).json({ error: 'Failed to capture snapshot' });
  }
});

// CAMERA CONFIG ROUTES
app.get('/api/camera-config', requireAuth, (req, res) => {
  res.json(cameraConfig);
});

app.put('/api/camera-config', requireAdmin, (req, res) => {
  const { raspberryPi, esp32 } = req.body;
  
  if (raspberryPi) {
    cameraConfig.raspberryPi = { ...cameraConfig.raspberryPi, ...raspberryPi };
  }
  if (esp32) {
    cameraConfig.esp32 = { ...cameraConfig.esp32, ...esp32 };
  }
  
  io.emit('camera:config-updated', cameraConfig);
  res.json(cameraConfig);
});

// CAPTURE ROUTES
app.post('/api/capture', requireAdmin, (req, res) => {
  try {
    const { imageData, source, type = 'photo' } = req.body;

    if (!imageData || !source) {
      return res.status(400).json({ error: 'Image data and source are required' });
    }

    const id = uuidv4();
    const extension = type === 'video' ? 'webm' : 'jpg';
    const filename = `${source}_${Date.now()}.${extension}`;
    const filepath = path.join(__dirname, 'public', 'captures', filename);

    // Decode base64 and save
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '')
                                .replace(/^data:video\/\w+;base64,/, '');
    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));

    db.prepare(`
      INSERT INTO captures (id, filename, type, source, captured_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, filename, type, source, req.session.user.id);

    res.json({ 
      success: true, 
      capture: { id, filename, type, source, url: `/captures/${filename}` }
    });
  } catch (error) {
    console.error('Capture error:', error);
    res.status(500).json({ error: 'Failed to save capture' });
  }
});

app.get('/api/captures', requireAuth, (req, res) => {
  const captures = db.prepare(`
    SELECT c.*, u.username as captured_by_username 
    FROM captures c 
    JOIN users u ON c.captured_by = u.id 
    ORDER BY c.created_at DESC
  `).all();
  res.json(captures);
});

app.delete('/api/captures/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    
    // Get capture info first
    const capture = db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    if (!capture) {
      return res.status(404).json({ error: 'Capture not found' });
    }
    
    // Delete file
    const filepath = path.join(__dirname, 'public', 'captures', capture.filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    
    // Delete from database
    db.prepare('DELETE FROM captures WHERE id = ?').run(id);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete capture error:', error);
    res.status(500).json({ error: 'Failed to delete capture' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  const session = socket.request.session;
  console.log('Client connected:', socket.id);

  // Send current matches on connect
  const matches = db.prepare('SELECT * FROM matches ORDER BY created_at DESC').all();
  socket.emit('matches:init', matches);

  // Quick score update (for admin live scoring)
  socket.on('score:quick-update', (data) => {
    if (!session.user || session.user.role !== 'admin') {
      return socket.emit('error', { message: 'Unauthorized' });
    }

    const { matchId, team, runs, wicket } = data;
    
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match) return;

    const scoreField = team === 'team1' ? 'team1_score' : 'team2_score';
    const wicketField = team === 'team1' ? 'team1_wickets' : 'team2_wickets';

    const newScore = match[scoreField] + (runs || 0);
    const newWickets = Math.min(10, match[wicketField] + (wicket ? 1 : 0));

    db.prepare(`
      UPDATE matches 
      SET ${scoreField} = ?, ${wicketField} = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(newScore, newWickets, matchId);

    const updatedMatch = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    io.emit('match:updated', updatedMatch);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve index.html for all other routes (SPA support)
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Cricket Score Tracker running on http://localhost:${PORT}`);
});
