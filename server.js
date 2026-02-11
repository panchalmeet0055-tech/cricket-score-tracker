const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Database variables
let db = null;
const DB_PATH = path.join(__dirname, 'cricket.db');

// Helper functions for sql.js
function dbRun(sql, params = []) {
  try {
    db.run(sql, params);
    const changes = db.getRowsModified();
    saveDatabase();
    return { changes };
  } catch (e) {
    console.error('DB Run Error:', e.message, 'SQL:', sql);
    throw e;
  }
}

function dbGet(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  } catch (e) {
    console.error('DB Get Error:', e);
    return null;
  }
}

function dbAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (e) {
    console.error('DB All Error:', e);
    return [];
  }
}

function saveDatabase() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('Save DB Error:', e);
  }
}

// Initialize database
async function initDatabase() {
  // Configure sql.js to find the WASM file in node_modules
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
  });
  
  try {
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(fileBuffer);
      console.log('Database loaded from file');
    } else {
      db = new SQL.Database();
      console.log('New database created');
    }
  } catch (e) {
    console.log('Creating new database due to error:', e.message);
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
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
      status TEXT DEFAULT 'upcoming',
      current_batting TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS captures (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      captured_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scorecard_batsmen (
      id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      player_name TEXT NOT NULL,
      runs INTEGER DEFAULT 0,
      balls INTEGER DEFAULT 0,
      fours INTEGER DEFAULT 0,
      sixes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'yet_to_bat',
      dismissal_info TEXT DEFAULT '',
      batting_position INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scorecard_bowlers (
      id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      player_name TEXT NOT NULL,
      overs REAL DEFAULT 0,
      maidens INTEGER DEFAULT 0,
      runs_conceded INTEGER DEFAULT 0,
      wickets INTEGER DEFAULT 0,
      bowling_position INTEGER DEFAULT 0
    )
  `);

  saveDatabase();
  console.log('Database initialized');
}

// Middleware
app.use(express.json({ limit: '50mb' }));
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

// Camera stream URLs
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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

    const existingUser = dbGet('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const now = new Date().toISOString();

    dbRun('INSERT INTO users (id, username, password, role, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, username, hashedPassword, role, now]);

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

    const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
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
  const matches = dbAll('SELECT * FROM matches ORDER BY created_at DESC');
  res.json(matches);
});

app.get('/api/matches/:id', (req, res) => {
  const match = dbGet('SELECT * FROM matches WHERE id = ?', [req.params.id]);
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
    const now = new Date().toISOString();
    
    dbRun(`
      INSERT INTO matches (id, team1_name, team2_name, status, current_batting, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, team1_name, team2_name, status, team1_name, now, now]);

    const match = dbGet('SELECT * FROM matches WHERE id = ?', [id]);
    
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

    const existingMatch = dbGet('SELECT * FROM matches WHERE id = ?', [id]);
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

    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    dbRun(`UPDATE matches SET ${setClauses.join(', ')} WHERE id = ?`, values);

    const match = dbGet('SELECT * FROM matches WHERE id = ?', [id]);
    
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
    
    const result = dbRun('DELETE FROM matches WHERE id = ?', [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Clean up scorecard data - use db.run directly to avoid multiple saves
    try {
      db.run('DELETE FROM scorecard_batsmen WHERE match_id = ?', [id]);
      db.run('DELETE FROM scorecard_bowlers WHERE match_id = ?', [id]);
      saveDatabase();
    } catch (e) {
      console.error('Scorecard cleanup error (non-fatal):', e.message);
    }

    io.emit('match:deleted', { id });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete match error:', error);
    res.status(500).json({ error: 'Failed to delete match' });
  }
});

// STREAM PROXY ROUTES
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

// Single frame capture
app.get('/api/snapshot/:camera', requireAuth, async (req, res) => {
  const { camera } = req.params;
  
  let snapshotUrl;
  if (camera === 'esp32' && cameraConfig.esp32.enabled) {
    try {
      const streamUrl = new URL(cameraConfig.esp32.url);
      snapshotUrl = `${streamUrl.protocol}//${streamUrl.hostname}/capture`;
    } catch (e) {
      snapshotUrl = 'http://192.168.1.9/capture';
    }
  } else if (camera === 'raspberrypi' && cameraConfig.raspberryPi.enabled) {
    snapshotUrl = cameraConfig.raspberryPi.url.replace('/stream', '/snapshot');
  } else {
    return res.status(404).json({ error: 'Camera not found or disabled' });
  }

  try {
    const proxyReq = http.request(snapshotUrl, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'no-cache'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
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

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '')
                                .replace(/^data:video\/\w+;base64,/, '');
    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));

    const now = new Date().toISOString();
    dbRun(`
      INSERT INTO captures (id, filename, type, source, captured_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, filename, type, source, req.session.user.id, now]);

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
  const captures = dbAll(`
    SELECT c.*, u.username as captured_by_username 
    FROM captures c 
    LEFT JOIN users u ON c.captured_by = u.id 
    ORDER BY c.created_at DESC
  `);
  res.json(captures);
});

app.delete('/api/captures/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    
    const capture = dbGet('SELECT * FROM captures WHERE id = ?', [id]);
    if (!capture) {
      return res.status(404).json({ error: 'Capture not found' });
    }
    
    const filepath = path.join(__dirname, 'public', 'captures', capture.filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    
    dbRun('DELETE FROM captures WHERE id = ?', [id]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Delete capture error:', error);
    res.status(500).json({ error: 'Failed to delete capture' });
  }
});

// SCORECARD ROUTES

// Get full scorecard for a match
app.get('/api/matches/:id/scorecard', (req, res) => {
  try {
    const { id } = req.params;
    const match = dbGet('SELECT * FROM matches WHERE id = ?', [id]);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const team1Batsmen = dbAll(
      'SELECT * FROM scorecard_batsmen WHERE match_id = ? AND team_name = ? ORDER BY batting_position ASC',
      [id, match.team1_name]
    );
    const team2Batsmen = dbAll(
      'SELECT * FROM scorecard_batsmen WHERE match_id = ? AND team_name = ? ORDER BY batting_position ASC',
      [id, match.team2_name]
    );
    const team1Bowlers = dbAll(
      'SELECT * FROM scorecard_bowlers WHERE match_id = ? AND team_name = ? ORDER BY bowling_position ASC',
      [id, match.team1_name]
    );
    const team2Bowlers = dbAll(
      'SELECT * FROM scorecard_bowlers WHERE match_id = ? AND team_name = ? ORDER BY bowling_position ASC',
      [id, match.team2_name]
    );

    res.json({
      match,
      team1: {
        name: match.team1_name,
        batsmen: team1Batsmen,
        bowlers: team1Bowlers
      },
      team2: {
        name: match.team2_name,
        batsmen: team2Batsmen,
        bowlers: team2Bowlers
      }
    });
  } catch (error) {
    console.error('Get scorecard error:', error);
    res.status(500).json({ error: 'Failed to get scorecard' });
  }
});

// Add batsman
app.post('/api/matches/:id/scorecard/batsman', requireAdmin, (req, res) => {
  try {
    const { id: matchId } = req.params;
    const { team_name, player_name, runs, balls, fours, sixes, status, dismissal_info, batting_position } = req.body;

    if (!team_name || !player_name) {
      return res.status(400).json({ error: 'Team name and player name are required' });
    }

    const match = dbGet('SELECT * FROM matches WHERE id = ?', [matchId]);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const id = uuidv4();
    const pos = batting_position || (dbAll(
      'SELECT * FROM scorecard_batsmen WHERE match_id = ? AND team_name = ?',
      [matchId, team_name]
    ).length + 1);

    dbRun(`
      INSERT INTO scorecard_batsmen (id, match_id, team_name, player_name, runs, balls, fours, sixes, status, dismissal_info, batting_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, matchId, team_name, player_name, runs || 0, balls || 0, fours || 0, sixes || 0, status || 'yet_to_bat', dismissal_info || '', pos]);

    const batsman = dbGet('SELECT * FROM scorecard_batsmen WHERE id = ?', [id]);
    io.emit('scorecard:updated', { matchId });
    res.json(batsman);
  } catch (error) {
    console.error('Add batsman error:', error);
    res.status(500).json({ error: 'Failed to add batsman' });
  }
});

// Update batsman
app.put('/api/matches/:id/scorecard/batsman/:batsmanId', requireAdmin, (req, res) => {
  try {
    const { batsmanId } = req.params;
    const updates = req.body;

    const existing = dbGet('SELECT * FROM scorecard_batsmen WHERE id = ?', [batsmanId]);
    if (!existing) {
      return res.status(404).json({ error: 'Batsman not found' });
    }

    const allowedFields = ['player_name', 'runs', 'balls', 'fours', 'sixes', 'status', 'dismissal_info', 'batting_position'];
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

    values.push(batsmanId);
    dbRun(`UPDATE scorecard_batsmen SET ${setClauses.join(', ')} WHERE id = ?`, values);

    const batsman = dbGet('SELECT * FROM scorecard_batsmen WHERE id = ?', [batsmanId]);
    io.emit('scorecard:updated', { matchId: req.params.id });
    res.json(batsman);
  } catch (error) {
    console.error('Update batsman error:', error);
    res.status(500).json({ error: 'Failed to update batsman' });
  }
});

// Delete batsman
app.delete('/api/matches/:id/scorecard/batsman/:batsmanId', requireAdmin, (req, res) => {
  try {
    const { batsmanId } = req.params;
    const result = dbRun('DELETE FROM scorecard_batsmen WHERE id = ?', [batsmanId]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Batsman not found' });
    }
    io.emit('scorecard:updated', { matchId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete batsman error:', error);
    res.status(500).json({ error: 'Failed to delete batsman' });
  }
});

// Add bowler
app.post('/api/matches/:id/scorecard/bowler', requireAdmin, (req, res) => {
  try {
    const { id: matchId } = req.params;
    const { team_name, player_name, overs, maidens, runs_conceded, wickets, bowling_position } = req.body;

    if (!team_name || !player_name) {
      return res.status(400).json({ error: 'Team name and player name are required' });
    }

    const match = dbGet('SELECT * FROM matches WHERE id = ?', [matchId]);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const id = uuidv4();
    const pos = bowling_position || (dbAll(
      'SELECT * FROM scorecard_bowlers WHERE match_id = ? AND team_name = ?',
      [matchId, team_name]
    ).length + 1);

    dbRun(`
      INSERT INTO scorecard_bowlers (id, match_id, team_name, player_name, overs, maidens, runs_conceded, wickets, bowling_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, matchId, team_name, player_name, overs || 0, maidens || 0, runs_conceded || 0, wickets || 0, pos]);

    const bowler = dbGet('SELECT * FROM scorecard_bowlers WHERE id = ?', [id]);
    io.emit('scorecard:updated', { matchId });
    res.json(bowler);
  } catch (error) {
    console.error('Add bowler error:', error);
    res.status(500).json({ error: 'Failed to add bowler' });
  }
});

// Update bowler
app.put('/api/matches/:id/scorecard/bowler/:bowlerId', requireAdmin, (req, res) => {
  try {
    const { bowlerId } = req.params;
    const updates = req.body;

    const existing = dbGet('SELECT * FROM scorecard_bowlers WHERE id = ?', [bowlerId]);
    if (!existing) {
      return res.status(404).json({ error: 'Bowler not found' });
    }

    const allowedFields = ['player_name', 'overs', 'maidens', 'runs_conceded', 'wickets', 'bowling_position'];
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

    values.push(bowlerId);
    dbRun(`UPDATE scorecard_bowlers SET ${setClauses.join(', ')} WHERE id = ?`, values);

    const bowler = dbGet('SELECT * FROM scorecard_bowlers WHERE id = ?', [bowlerId]);
    io.emit('scorecard:updated', { matchId: req.params.id });
    res.json(bowler);
  } catch (error) {
    console.error('Update bowler error:', error);
    res.status(500).json({ error: 'Failed to update bowler' });
  }
});

// Delete bowler
app.delete('/api/matches/:id/scorecard/bowler/:bowlerId', requireAdmin, (req, res) => {
  try {
    const { bowlerId } = req.params;
    const result = dbRun('DELETE FROM scorecard_bowlers WHERE id = ?', [bowlerId]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Bowler not found' });
    }
    io.emit('scorecard:updated', { matchId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete bowler error:', error);
    res.status(500).json({ error: 'Failed to delete bowler' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  const session = socket.request.session;
  console.log('Client connected:', socket.id);

  const matches = dbAll('SELECT * FROM matches ORDER BY created_at DESC');
  socket.emit('matches:init', matches);

  socket.on('score:quick-update', (data) => {
    if (!session.user || session.user.role !== 'admin') {
      return socket.emit('error', { message: 'Unauthorized' });
    }

    const { matchId, team, runs, wicket } = data;
    
    const match = dbGet('SELECT * FROM matches WHERE id = ?', [matchId]);
    if (!match) return;

    const scoreField = team === 'team1' ? 'team1_score' : 'team2_score';
    const wicketField = team === 'team1' ? 'team1_wickets' : 'team2_wickets';

    const newScore = match[scoreField] + (runs || 0);
    const newWickets = Math.min(10, match[wicketField] + (wicket ? 1 : 0));

    dbRun(`
      UPDATE matches 
      SET ${scoreField} = ?, ${wicketField} = ?, updated_at = ? 
      WHERE id = ?
    `, [newScore, newWickets, new Date().toISOString(), matchId]);

    const updatedMatch = dbGet('SELECT * FROM matches WHERE id = ?', [matchId]);
    io.emit('match:updated', updatedMatch);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Serve index.html for all other routes (catch-all for SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;

console.log(`Starting Cricket Score Tracker...`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`PORT env var: ${process.env.PORT || 'not set, using default 3000'}`);
console.log(`Binding to port: ${PORT}`);

initDatabase().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Cricket Score Tracker running on http://0.0.0.0:${PORT}`);
    console.log(`Server is ready to accept connections`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
