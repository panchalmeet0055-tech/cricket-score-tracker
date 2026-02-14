// State
let currentUser = null;
let matches = [];
let cameraConfig = {};
let currentQuickScoreMatch = null;
let mediaRecorder = null;
let recordedChunks = [];
let capturesList = [];
let currentPreviewIndex = 0;
let currentScorecardMatchId = null;
let currentScorecardTab = 'team1';
let currentAdminScorecardMatchId = null;
let currentAdminScorecardTab = 'team1';
let scorecardData = null;
let esp32PollingInterval = null;

// Socket.IO connection
const socket = io();

// DOM Elements
const navbar = document.getElementById('navbar');
const authPage = document.getElementById('auth-page');
const dashboardPage = document.getElementById('dashboard-page');
const liveStreamPage = document.getElementById('live-stream-page');
const lbwDetectionPage = document.getElementById('lbw-detection-page');
const adminPage = document.getElementById('admin-page');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupEventListeners();
  setupSocketListeners();
});

// Check if user is logged in
async function checkAuth() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      showApp();
    } else {
      showAuth();
    }
  } catch (error) {
    showAuth();
  }
}

// Show auth page
function showAuth() {
  authPage.classList.remove('hidden');
  navbar.classList.add('hidden');
  dashboardPage.classList.add('hidden');
  liveStreamPage.classList.add('hidden');
  lbwDetectionPage.classList.add('hidden');
  adminPage.classList.add('hidden');
}

// Show main app
function showApp() {
  authPage.classList.add('hidden');
  navbar.classList.remove('hidden');
  
  // Update user info
  document.getElementById('user-info').textContent = `${currentUser.username} (${currentUser.role})`;
  
  // Show/hide admin elements
  const adminElements = document.querySelectorAll('.admin-only');
  adminElements.forEach(el => {
    if (currentUser.role === 'admin') {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });
  
  // Show dashboard by default
  showPage('dashboard');
  
  // Load camera config
  loadCameraConfig();
}

// Setup event listeners
function setupEventListeners() {
  // Auth tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const tab = btn.dataset.tab;
      if (tab === 'login') {
        document.getElementById('login-form').classList.remove('hidden');
        document.getElementById('register-form').classList.add('hidden');
      } else {
        document.getElementById('login-form').classList.add('hidden');
        document.getElementById('register-form').classList.remove('hidden');
      }
    });
  });

  // Login form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      
      const data = await res.json();
      
      if (res.ok) {
        currentUser = data.user;
        // Reconnect socket so it picks up the authenticated session
        socket.disconnect();
        socket.connect();
        showApp();
      } else {
        errorEl.textContent = data.error;
      }
    } catch (error) {
      errorEl.textContent = 'Login failed. Please try again.';
    }
  });

  // Register form
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('register-username').value;
    const password = document.getElementById('register-password').value;
    const role = document.querySelector('input[name="role"]:checked').value;
    const errorEl = document.getElementById('register-error');
    const successEl = document.getElementById('register-success');
    
    errorEl.textContent = '';
    successEl.textContent = '';
    
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role })
      });
      
      const data = await res.json();
      
      if (res.ok) {
        successEl.textContent = 'Registration successful! Please login.';
        document.getElementById('register-username').value = '';
        document.getElementById('register-password').value = '';
      } else {
        errorEl.textContent = data.error;
      }
    } catch (error) {
      errorEl.textContent = 'Registration failed. Please try again.';
    }
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    currentUser = null;
    showAuth();
  });

  // Navigation
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = link.dataset.page;
      showPage(page);
    });
  });

  // Create match form
  document.getElementById('create-match-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const team1_name = document.getElementById('team1-name').value;
    const team2_name = document.getElementById('team2-name').value;
    const status = document.getElementById('match-status').value;
    
    try {
      const res = await fetch('/api/matches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team1_name, team2_name, status })
      });
      
      if (res.ok) {
        document.getElementById('team1-name').value = '';
        document.getElementById('team2-name').value = '';
        document.getElementById('match-status').value = 'upcoming';
      }
    } catch (error) {
      console.error('Failed to create match:', error);
    }
  });

  // Edit match form
  document.getElementById('edit-match-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = document.getElementById('edit-match-id').value;
    const updates = {
      team1_score: parseInt(document.getElementById('edit-team1-score').value),
      team1_wickets: parseInt(document.getElementById('edit-team1-wickets').value),
      team1_overs: parseFloat(document.getElementById('edit-team1-overs').value),
      team2_score: parseInt(document.getElementById('edit-team2-score').value),
      team2_wickets: parseInt(document.getElementById('edit-team2-wickets').value),
      team2_overs: parseFloat(document.getElementById('edit-team2-overs').value),
      status: document.getElementById('edit-status').value,
      current_batting: document.getElementById('edit-batting').value
    };
    
    try {
      await fetch(`/api/matches/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      
      closeEditModal();
    } catch (error) {
      console.error('Failed to update match:', error);
    }
  });

  // Capture buttons
  document.querySelectorAll('.btn-capture').forEach(btn => {
    btn.addEventListener('click', () => {
      const source = btn.dataset.source;
      const action = btn.dataset.action;
      
      if (action === 'photo') {
        capturePhoto(source);
      } else if (action === 'video') {
        toggleVideoRecording(btn, source);
      }
    });
  });
}

// Socket listeners
function setupSocketListeners() {
  socket.on('matches:init', (data) => {
    matches = data;
    renderMatches();
    renderAdminMatches();
  });

  socket.on('match:created', (match) => {
    matches.unshift(match);
    renderMatches();
    renderAdminMatches();
  });

  socket.on('match:updated', (match) => {
    const index = matches.findIndex(m => m.id === match.id);
    if (index !== -1) {
      matches[index] = match;
    }
    renderMatches();
    renderAdminMatches();
    
    // Update quick score modal if open
    if (currentQuickScoreMatch && currentQuickScoreMatch.id === match.id) {
      currentQuickScoreMatch = match;
      updateQuickScoreDisplay();
    }
  });

  socket.on('match:deleted', ({ id }) => {
    matches = matches.filter(m => m.id !== id);
    renderMatches();
    renderAdminMatches();
  });

  socket.on('camera:config-updated', (config) => {
    cameraConfig = config;
    updateCameraStreams();
  });

  socket.on('scorecard:updated', async (data) => {
    // Refresh scorecard if viewing this match
    if (currentScorecardMatchId && currentScorecardMatchId === data.matchId) {
      await loadScorecardView(data.matchId);
    }
    if (currentAdminScorecardMatchId && currentAdminScorecardMatchId === data.matchId) {
      await loadAdminScorecard(data.matchId);
    }
  });
}

// Show page
function showPage(page) {
  // Update nav links
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });

  // Hide all pages
  dashboardPage.classList.add('hidden');
  liveStreamPage.classList.add('hidden');
  lbwDetectionPage.classList.add('hidden');
  adminPage.classList.add('hidden');

  // Stop ESP32 polling when leaving live stream page
  if (page !== 'live-stream' && esp32PollingInterval) {
    clearInterval(esp32PollingInterval);
    esp32PollingInterval = null;
  }

  // Show selected page
  switch (page) {
    case 'dashboard':
      dashboardPage.classList.remove('hidden');
      break;
    case 'live-stream':
      liveStreamPage.classList.remove('hidden');
      initCameraStreams();
      loadCaptures();
      break;
    case 'lbw-detection':
      lbwDetectionPage.classList.remove('hidden');
      initLBWIframe();
      break;
    case 'admin':
      if (currentUser.role === 'admin') {
        adminPage.classList.remove('hidden');
      }
      break;
  }
}

// Render matches
function renderMatches() {
  const container = document.getElementById('matches-container');
  
  if (matches.length === 0) {
    container.innerHTML = '<div class="no-matches"><p>No matches available</p></div>';
    return;
  }
  
  container.innerHTML = matches.map(match => `
    <div class="match-card">
      <div class="match-header">
        <h4>Cricket Match</h4>
        <span class="status-badge status-${match.status}">${match.status}</span>
      </div>
      <div class="match-body">
        <div class="teams-score">
          <div class="team ${match.current_batting === match.team1_name ? 'batting' : ''}">
            <div class="team-name">${escapeHtml(match.team1_name)}</div>
            <div class="team-score">
              ${match.team1_score}<span>/${match.team1_wickets}</span>
            </div>
            <div class="team-overs">(${match.team1_overs} ov)</div>
          </div>
          <div class="vs-divider">VS</div>
          <div class="team ${match.current_batting === match.team2_name ? 'batting' : ''}">
            <div class="team-name">${escapeHtml(match.team2_name)}</div>
            <div class="team-score">
              ${match.team2_score}<span>/${match.team2_wickets}</span>
            </div>
            <div class="team-overs">(${match.team2_overs} ov)</div>
          </div>
        </div>
        <div class="batting-indicator">
          ${match.current_batting ? `${escapeHtml(match.current_batting)} batting` : 'Not started'}
        </div>
      </div>
      ${currentUser && currentUser.role === 'admin' && match.status === 'live' ? `
        <div class="match-actions">
          <button class="btn btn-primary btn-sm" onclick="openQuickScoreModal('${match.id}')">
            Quick Score
          </button>
          <button class="btn btn-outline btn-sm" onclick="openScorecardModal('${match.id}')">
            Scorecard
          </button>
        </div>
      ` : `
        <div class="match-actions">
          <button class="btn btn-outline btn-sm" onclick="openScorecardModal('${match.id}')">
            View Scorecard
          </button>
        </div>
      `}
    </div>
  `).join('');
}

// Render admin matches list
function renderAdminMatches() {
  const container = document.getElementById('admin-matches-list');
  
  if (matches.length === 0) {
    container.innerHTML = '<p>No matches created yet</p>';
    return;
  }
  
  container.innerHTML = matches.map(match => `
    <div class="admin-match-item">
      <div class="admin-match-info">
        <h4>${escapeHtml(match.team1_name)} vs ${escapeHtml(match.team2_name)}</h4>
        <span>Status: ${match.status} | Score: ${match.team1_score}/${match.team1_wickets} - ${match.team2_score}/${match.team2_wickets}</span>
      </div>
      <div class="admin-match-actions">
        <button class="btn btn-sm btn-primary" onclick="openEditModal('${match.id}')">Edit</button>
        <button class="btn btn-sm btn-success" onclick="openQuickScoreModal('${match.id}')">Live Score</button>
        <button class="btn btn-sm btn-outline" onclick="openAdminScorecardModal('${match.id}')">Scorecard</button>
        <button class="btn btn-sm btn-danger" onclick="deleteMatch('${match.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

// Edit modal functions
function openEditModal(matchId) {
  const match = matches.find(m => m.id === matchId);
  if (!match) return;
  
  document.getElementById('edit-match-id').value = match.id;
  document.getElementById('edit-team1-label').textContent = match.team1_name;
  document.getElementById('edit-team2-label').textContent = match.team2_name;
  document.getElementById('edit-team1-score').value = match.team1_score;
  document.getElementById('edit-team1-wickets').value = match.team1_wickets;
  document.getElementById('edit-team1-overs').value = match.team1_overs;
  document.getElementById('edit-team2-score').value = match.team2_score;
  document.getElementById('edit-team2-wickets').value = match.team2_wickets;
  document.getElementById('edit-team2-overs').value = match.team2_overs;
  document.getElementById('edit-status').value = match.status;
  
  // Populate batting dropdown
  const battingSelect = document.getElementById('edit-batting');
  battingSelect.innerHTML = `
    <option value="${match.team1_name}" ${match.current_batting === match.team1_name ? 'selected' : ''}>
      ${match.team1_name}
    </option>
    <option value="${match.team2_name}" ${match.current_batting === match.team2_name ? 'selected' : ''}>
      ${match.team2_name}
    </option>
  `;
  
  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

// Quick score modal
function openQuickScoreModal(matchId) {
  currentQuickScoreMatch = matches.find(m => m.id === matchId);
  if (!currentQuickScoreMatch) return;
  
  updateQuickScoreDisplay();
  document.getElementById('quick-score-modal').classList.remove('hidden');
}

function closeQuickScoreModal() {
  currentQuickScoreMatch = null;
  document.getElementById('quick-score-modal').classList.add('hidden');
}

function updateQuickScoreDisplay() {
  if (!currentQuickScoreMatch) return;
  
  const match = currentQuickScoreMatch;
  const batting = match.current_batting === match.team1_name ? 'team1' : 'team2';
  const score = batting === 'team1' ? match.team1_score : match.team2_score;
  const wickets = batting === 'team1' ? match.team1_wickets : match.team2_wickets;
  const overs = batting === 'team1' ? match.team1_overs : match.team2_overs;
  
  document.getElementById('quick-score-info').innerHTML = `
    <h4>${escapeHtml(match.current_batting)} Batting</h4>
    <div class="score-display">${score}/${wickets}</div>
    <div>(${overs} overs)</div>
  `;
}

function quickScore(runs, wicket = false) {
  if (!currentQuickScoreMatch) return;
  
  const match = currentQuickScoreMatch;
  const team = match.current_batting === match.team1_name ? 'team1' : 'team2';
  
  socket.emit('score:quick-update', {
    matchId: match.id,
    team,
    runs,
    wicket
  });
}

// Delete match
async function deleteMatch(id) {
  if (!confirm('Are you sure you want to delete this match?')) return;
  
  try {
    const res = await fetch(`/api/matches/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to delete match');
    }
  } catch (error) {
    console.error('Failed to delete match:', error);
    alert('Failed to delete match. Server may be unavailable.');
  }
}

// Camera functions
async function loadCameraConfig() {
  try {
    const res = await fetch('/api/camera-config');
    if (res.ok) {
      cameraConfig = await res.json();
    }
  } catch (error) {
    console.error('Failed to load camera config:', error);
  }
}

function initCameraStreams() {
  updateCameraStreams();
}

function updateCameraStreams() {
  // LBW Detection iframe (replaces Raspberry Pi stream)
  const lbwIframe = document.getElementById('lbw-preview-iframe');
  const lbwStatus = document.getElementById('lbw-status');
  const lbwOffline = document.getElementById('lbw-offline');
  const lbwUrlInput = document.getElementById('lbw-url');
  
  if (cameraConfig.raspberryPi) {
    if (lbwUrlInput) lbwUrlInput.value = cameraConfig.raspberryPi.url;
    
    if (cameraConfig.raspberryPi.enabled && cameraConfig.raspberryPi.url) {
      lbwIframe.src = cameraConfig.raspberryPi.url;
      lbwOffline.classList.add('hidden');
      lbwIframe.onload = () => {
        lbwStatus.textContent = 'Online';
        lbwStatus.className = 'status-badge status-live';
        lbwOffline.classList.add('hidden');
      };
      lbwIframe.onerror = () => {
        lbwStatus.textContent = 'Offline';
        lbwStatus.className = 'status-badge status-upcoming';
        lbwOffline.classList.remove('hidden');
      };
      // Timeout fallback: assume loaded for cross-origin iframes
      setTimeout(() => {
        if (lbwStatus.textContent === 'Connecting...') {
          lbwStatus.textContent = 'Online';
          lbwStatus.className = 'status-badge status-live';
          lbwOffline.classList.add('hidden');
        }
      }, 5000);
    } else {
      lbwOffline.classList.remove('hidden');
      lbwStatus.textContent = 'Disabled';
    }
  }
  
  // ESP32 stream - use snapshot polling to avoid MJPEG single-client limitation
  const esp32Stream = document.getElementById('esp32-stream');
  const esp32Status = document.getElementById('esp32-status');
  const esp32Offline = document.getElementById('esp32-offline');
  const esp32UrlInput = document.getElementById('esp32-url');
  
  // Stop any existing polling
  if (esp32PollingInterval) {
    clearInterval(esp32PollingInterval);
    esp32PollingInterval = null;
  }
  
  if (cameraConfig.esp32) {
    if (esp32UrlInput) esp32UrlInput.value = cameraConfig.esp32.url;
    
    if (cameraConfig.esp32.enabled && cameraConfig.esp32.url) {
      // Derive snapshot URL from stream URL (replace :81/stream with /capture)
      let snapshotUrl;
      try {
        const streamUrl = new URL(cameraConfig.esp32.url);
        snapshotUrl = `${streamUrl.protocol}//${streamUrl.hostname}/capture`;
      } catch (e) {
        snapshotUrl = 'http://192.168.1.13/capture';
      }
      
      let frameLoaded = false;
      
      function fetchFrame() {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          esp32Stream.src = img.src;
          if (!frameLoaded) {
            frameLoaded = true;
            esp32Status.textContent = 'Streaming';
            esp32Status.className = 'status-badge status-live';
            esp32Offline.classList.add('hidden');
          }
        };
        img.onerror = () => {
          if (!frameLoaded) {
            esp32Status.textContent = 'Offline';
            esp32Status.className = 'status-badge status-upcoming';
            esp32Offline.classList.remove('hidden');
          }
        };
        img.src = snapshotUrl + '?t=' + Date.now();
      }
      
      // Fetch first frame immediately
      fetchFrame();
      // Then poll every 500ms (~2 FPS)
      esp32PollingInterval = setInterval(fetchFrame, 500);
    } else {
      esp32Offline.classList.remove('hidden');
      esp32Status.textContent = 'Disabled';
    }
  }
}

async function updateCameraConfig(camera) {
  const urlInput = camera === 'raspberryPi' 
    ? document.getElementById('lbw-url')
    : document.getElementById('esp32-url');
  
  const update = {
    [camera]: { url: urlInput.value, enabled: true }
  };
  
  try {
    await fetch('/api/camera-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    });
  } catch (error) {
    console.error('Failed to update camera config:', error);
  }
}

// LBW Detection functions
function initLBWIframe() {
  const iframe = document.getElementById('lbw-full-iframe');
  const status = document.getElementById('lbw-full-status');
  const offline = document.getElementById('lbw-full-offline');
  
  if (cameraConfig.raspberryPi && cameraConfig.raspberryPi.enabled && cameraConfig.raspberryPi.url) {
    iframe.src = cameraConfig.raspberryPi.url;
    offline.classList.add('hidden');
    iframe.onload = () => {
      status.textContent = 'Online';
      status.className = 'status-badge status-live';
      offline.classList.add('hidden');
    };
    // Timeout fallback for cross-origin iframes
    setTimeout(() => {
      if (status.textContent === 'Connecting...') {
        status.textContent = 'Online';
        status.className = 'status-badge status-live';
        offline.classList.add('hidden');
      }
    }, 5000);
  } else {
    offline.classList.remove('hidden');
    status.textContent = 'Disabled';
    status.className = 'status-badge';
  }
}

function openFullLBW() {
  showPage('lbw-detection');
}

// Capture functions
async function capturePhoto(source) {
  const cameraType = source === 'raspberry_pi' ? 'raspberrypi' : 'esp32';
  
  try {
    // Try to get snapshot from server proxy
    const res = await fetch(`/api/snapshot/${cameraType}`);
    if (res.ok) {
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onloadend = () => {
        saveCapture(reader.result, source, 'photo');
      };
      reader.readAsDataURL(blob);
    } else {
      // Fallback: capture from displayed stream
      const streamEl = source === 'raspberry_pi' 
        ? document.getElementById('rpi-stream')
        : document.getElementById('esp32-stream');
      
      const canvas = document.createElement('canvas');
      canvas.width = streamEl.naturalWidth || 640;
      canvas.height = streamEl.naturalHeight || 480;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(streamEl, 0, 0, canvas.width, canvas.height);
      
      const imageData = canvas.toDataURL('image/jpeg', 0.9);
      saveCapture(imageData, source, 'photo');
    }
  } catch (error) {
    console.error('Capture failed:', error);
    alert('Failed to capture photo. Make sure camera is online.');
  }
}

function toggleVideoRecording(btn, source) {
  const cameraType = source === 'raspberry_pi' ? 'raspberrypi' : 'esp32';
  
  if (btn.dataset.recording === 'true') {
    // Stop recording
    btn.dataset.recording = 'false';
    btn.textContent = 'Start Recording';
    btn.classList.remove('btn-danger');
    
    if (window.recordingInterval) {
      clearInterval(window.recordingInterval);
      window.recordingInterval = null;
    }
    
    // Create video from captured frames
    if (window.recordedFrames && window.recordedFrames.length > 0) {
      createVideoFromFrames(window.recordedFrames, source);
      window.recordedFrames = [];
    } else {
      alert('No frames captured');
    }
  } else {
    // Start recording - capture frames every 200ms
    btn.dataset.recording = 'true';
    btn.textContent = 'Stop Recording';
    btn.classList.add('btn-danger');
    
    window.recordedFrames = [];
    
    const captureFrame = async () => {
      try {
        const res = await fetch(`/api/snapshot/${cameraType}`);
        if (res.ok) {
          const blob = await res.blob();
          window.recordedFrames.push(blob);
        }
      } catch (e) {
        console.error('Frame capture error:', e);
      }
    };
    
    // Capture first frame immediately
    captureFrame();
    
    // Then capture every 200ms (5 fps)
    window.recordingInterval = setInterval(captureFrame, 200);
    
    alert('Recording started. Click "Stop Recording" when done.');
  }
}

async function createVideoFromFrames(frames, source) {
  if (frames.length === 0) {
    alert('No frames to save');
    return;
  }
  
  // For simplicity, save as a GIF-like sequence or just save all frames
  // Since creating actual video in browser is complex, we'll save the last frame as photo
  // and notify user about the limitation
  
  try {
    // Convert the last frame to base64 and save
    const lastFrame = frames[frames.length - 1];
    const reader = new FileReader();
    reader.onloadend = async () => {
      // Save as video placeholder (actually saving representative frame)
      await saveCapture(reader.result, source, 'photo');
      alert(`Captured ${frames.length} frames! Saved as photo. (Video encoding requires server-side processing)`);
    };
    reader.readAsDataURL(lastFrame);
  } catch (error) {
    console.error('Failed to create video:', error);
    alert('Failed to save recording');
  }
}

async function saveCapture(imageData, source, type) {
  try {
    const res = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData, source, type })
    });
    
    if (res.ok) {
      loadCaptures();
      alert(`${type === 'photo' ? 'Photo' : 'Video'} captured successfully!`);
    }
  } catch (error) {
    console.error('Failed to save capture:', error);
    alert('Failed to save capture');
  }
}

async function loadCaptures() {
  try {
    const res = await fetch('/api/captures');
    if (res.ok) {
      const captures = await res.json();
      capturesList = captures;
      renderCaptures(captures);
    }
  } catch (error) {
    console.error('Failed to load captures:', error);
  }
}

function renderCaptures(captures) {
  const gallery = document.getElementById('captures-gallery');
  if (!gallery) return;
  
  if (captures.length === 0) {
    gallery.innerHTML = '<p>No captures yet</p>';
    return;
  }
  
  const isAdmin = currentUser && currentUser.role === 'admin';
  
  gallery.innerHTML = captures.map((capture, index) => `
    <div class="capture-item" data-id="${capture.id}">
      ${capture.type === 'photo' 
        ? `<img src="/captures/${capture.filename}" alt="Capture" onclick="openPreviewModal(${index})">`
        : `<video src="/captures/${capture.filename}" onclick="openPreviewModal(${index})"></video>`
      }
      <div class="capture-info">
        <div class="capture-details">
          <div>${capture.source === 'raspberry_pi' ? 'LBW Detection' : 'ESP32'}</div>
          <div>${new Date(capture.created_at).toLocaleString()}</div>
        </div>
        ${isAdmin ? `<button class="capture-delete" onclick="event.stopPropagation(); deleteCapture('${capture.id}')">Delete</button>` : ''}
      </div>
    </div>
  `).join('');
}

// Preview modal functions
function openPreviewModal(index) {
  currentPreviewIndex = index;
  showPreview();
  document.getElementById('preview-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closePreviewModal() {
  document.getElementById('preview-modal').classList.add('hidden');
  document.body.style.overflow = '';
  
  // Stop video if playing
  const video = document.getElementById('preview-video');
  video.pause();
  video.src = '';
}

function showPreview() {
  if (capturesList.length === 0) return;
  
  const capture = capturesList[currentPreviewIndex];
  const previewImage = document.getElementById('preview-image');
  const previewVideo = document.getElementById('preview-video');
  
  if (capture.type === 'photo') {
    previewImage.src = `/captures/${capture.filename}`;
    previewImage.classList.remove('hidden');
    previewVideo.classList.add('hidden');
    previewVideo.pause();
  } else {
    previewVideo.src = `/captures/${capture.filename}`;
    previewVideo.classList.remove('hidden');
    previewImage.classList.add('hidden');
  }
  
  document.getElementById('preview-source').textContent = 
    capture.source === 'raspberry_pi' ? 'LBW Detection' : 'ESP32';
  document.getElementById('preview-date').textContent = 
    new Date(capture.created_at).toLocaleString();
  document.getElementById('preview-counter').textContent = 
    `${currentPreviewIndex + 1} / ${capturesList.length}`;
}

function navigatePreview(direction) {
  currentPreviewIndex += direction;
  
  if (currentPreviewIndex < 0) {
    currentPreviewIndex = capturesList.length - 1;
  } else if (currentPreviewIndex >= capturesList.length) {
    currentPreviewIndex = 0;
  }
  
  showPreview();
}

// Keyboard navigation for preview
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('preview-modal');
  if (modal && !modal.classList.contains('hidden')) {
    if (e.key === 'Escape') {
      closePreviewModal();
    } else if (e.key === 'ArrowLeft') {
      navigatePreview(-1);
    } else if (e.key === 'ArrowRight') {
      navigatePreview(1);
    }
  }
});

// Delete capture
async function deleteCapture(id) {
  if (!confirm('Are you sure you want to delete this capture?')) return;
  
  try {
    const res = await fetch(`/api/captures/${id}`, { method: 'DELETE' });
    if (res.ok) {
      loadCaptures();
    } else {
      alert('Failed to delete capture');
    }
  } catch (error) {
    console.error('Failed to delete capture:', error);
    alert('Failed to delete capture');
  }
}

// Utility functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============ SCORECARD FUNCTIONS ============

// View Scorecard Modal (for all users)
async function openScorecardModal(matchId) {
  currentScorecardMatchId = matchId;
  currentScorecardTab = 'team1';
  
  const match = matches.find(m => m.id === matchId);
  if (!match) return;

  // Update tab labels
  const tabs = document.querySelectorAll('#scorecard-modal .scorecard-tab');
  tabs[0].textContent = match.team1_name;
  tabs[0].dataset.team = 'team1';
  tabs[0].classList.add('active');
  tabs[1].textContent = match.team2_name;
  tabs[1].dataset.team = 'team2';
  tabs[1].classList.remove('active');

  document.getElementById('scorecard-modal').classList.remove('hidden');
  await loadScorecardView(matchId);
}

function closeScorecardModal() {
  currentScorecardMatchId = null;
  scorecardData = null;
  document.getElementById('scorecard-modal').classList.add('hidden');
}

function switchScorecardTab(team) {
  currentScorecardTab = team;
  const tabs = document.querySelectorAll('#scorecard-modal .scorecard-tab');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.team === team));
  renderScorecardView();
}

async function loadScorecardView(matchId) {
  try {
    const res = await fetch(`/api/matches/${matchId}/scorecard`);
    if (res.ok) {
      scorecardData = await res.json();
      renderScorecardView();
    }
  } catch (error) {
    console.error('Failed to load scorecard:', error);
  }
}

function renderScorecardView() {
  const container = document.getElementById('scorecard-content');
  if (!scorecardData) {
    container.innerHTML = '<p class="loading">No scorecard data</p>';
    return;
  }

  const teamData = currentScorecardTab === 'team1' ? scorecardData.team1 : scorecardData.team2;
  const opposingTeamData = currentScorecardTab === 'team1' ? scorecardData.team2 : scorecardData.team1;

  const activeBatsmen = teamData.batsmen.filter(b => b.status !== 'yet_to_bat');
  const yetToBat = teamData.batsmen.filter(b => b.status === 'yet_to_bat');
  
  // Bowlers from opposing team bowling to this team
  const bowlers = opposingTeamData.bowlers;

  let html = '';

  // Batting section
  html += '<div class="scorecard-section">';
  html += '<h4 class="scorecard-section-title">Batting</h4>';
  if (activeBatsmen.length > 0) {
    html += '<div class="scorecard-table-wrapper"><table class="scorecard-table">';
    html += '<thead><tr><th class="sc-player">Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>S/R</th></tr></thead>';
    html += '<tbody>';
    activeBatsmen.forEach(b => {
      const sr = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(2) : '0.00';
      const statusClass = b.status === 'not_out' || b.status === 'batting' ? 'sc-not-out' : '';
      html += `<tr class="${statusClass}">
        <td class="sc-player">
          <div class="sc-player-name">${escapeHtml(b.player_name)}${b.status === 'batting' ? ' *' : ''}</div>
          <div class="sc-dismissal">${b.status === 'out' ? escapeHtml(b.dismissal_info || 'out') : (b.status === 'not_out' || b.status === 'batting' ? 'not out' : '')}</div>
        </td>
        <td class="sc-bold">${b.runs}</td>
        <td>${b.balls}</td>
        <td>${b.fours}</td>
        <td>${b.sixes}</td>
        <td>${sr}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="sc-empty">No batting data yet</p>';
  }

  // Extras & Total
  const match = scorecardData.match;
  if (currentScorecardTab === 'team1') {
    html += `<div class="sc-total">
      <span>Total</span>
      <span class="sc-total-score">${match.team1_score}/${match.team1_wickets} <small>(${match.team1_overs} ov)</small></span>
    </div>`;
  } else {
    html += `<div class="sc-total">
      <span>Total</span>
      <span class="sc-total-score">${match.team2_score}/${match.team2_wickets} <small>(${match.team2_overs} ov)</small></span>
    </div>`;
  }

  // Yet to bat
  if (yetToBat.length > 0) {
    html += '<div class="sc-yet-to-bat">';
    html += '<h5>Yet to bat</h5>';
    html += '<p>' + yetToBat.map(b => escapeHtml(b.player_name)).join(' &middot; ') + '</p>';
    html += '</div>';
  }
  html += '</div>';

  // Bowling section
  html += '<div class="scorecard-section">';
  html += '<h4 class="scorecard-section-title">Bowling</h4>';
  if (bowlers.length > 0) {
    html += '<div class="scorecard-table-wrapper"><table class="scorecard-table">';
    html += '<thead><tr><th class="sc-player">Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead>';
    html += '<tbody>';
    bowlers.forEach(b => {
      const econ = b.overs > 0 ? (b.runs_conceded / b.overs).toFixed(2) : '0.00';
      html += `<tr>
        <td class="sc-player"><div class="sc-player-name">${escapeHtml(b.player_name)}</div></td>
        <td>${b.overs}</td>
        <td>${b.maidens}</td>
        <td>${b.runs_conceded}</td>
        <td class="sc-bold">${b.wickets}</td>
        <td>${econ}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="sc-empty">No bowling data yet</p>';
  }
  html += '</div>';

  container.innerHTML = html;
}

// ============ ADMIN SCORECARD MANAGEMENT ============

async function openAdminScorecardModal(matchId) {
  currentAdminScorecardMatchId = matchId;
  currentAdminScorecardTab = 'team1';
  
  const match = matches.find(m => m.id === matchId);
  if (!match) return;

  // Update tab labels
  const tabs = document.querySelectorAll('#admin-scorecard-modal .scorecard-tab');
  tabs[0].textContent = match.team1_name;
  tabs[0].dataset.team = 'team1';
  tabs[0].classList.add('active');
  tabs[1].textContent = match.team2_name;
  tabs[1].dataset.team = 'team2';
  tabs[1].classList.remove('active');

  document.getElementById('admin-scorecard-modal').classList.remove('hidden');
  await loadAdminScorecard(matchId);
}

function closeAdminScorecardModal() {
  currentAdminScorecardMatchId = null;
  scorecardData = null;
  cancelBatsmanForm();
  cancelBowlerForm();
  document.getElementById('admin-scorecard-modal').classList.add('hidden');
}

function switchAdminScorecardTab(team) {
  currentAdminScorecardTab = team;
  const tabs = document.querySelectorAll('#admin-scorecard-modal .scorecard-tab');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.team === team));
  cancelBatsmanForm();
  cancelBowlerForm();
  renderAdminScorecard();
}

async function loadAdminScorecard(matchId) {
  try {
    const res = await fetch(`/api/matches/${matchId}/scorecard`);
    if (res.ok) {
      scorecardData = await res.json();
      renderAdminScorecard();
    }
  } catch (error) {
    console.error('Failed to load scorecard:', error);
  }
}

function renderAdminScorecard() {
  if (!scorecardData) return;

  const teamData = currentAdminScorecardTab === 'team1' ? scorecardData.team1 : scorecardData.team2;
  const opposingTeamData = currentAdminScorecardTab === 'team1' ? scorecardData.team2 : scorecardData.team1;
  const batsmen = teamData.batsmen;
  const bowlers = opposingTeamData.bowlers;

  // Render batsmen list
  const batsmenContainer = document.getElementById('admin-batsmen-list');
  if (batsmen.length > 0) {
    let html = '<div class="scorecard-table-wrapper"><table class="scorecard-table">';
    html += '<thead><tr><th class="sc-player">Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>Status</th><th>Actions</th></tr></thead>';
    html += '<tbody>';
    batsmen.forEach(b => {
      html += `<tr>
        <td class="sc-player">
          <div class="sc-player-name">${escapeHtml(b.player_name)}</div>
          <div class="sc-dismissal">${escapeHtml(b.dismissal_info || '')}</div>
        </td>
        <td>${b.runs}</td>
        <td>${b.balls}</td>
        <td>${b.fours}</td>
        <td>${b.sixes}</td>
        <td><span class="sc-status-badge sc-status-${b.status}">${b.status.replace('_', ' ')}</span></td>
        <td class="sc-actions">
          <button class="btn-icon" onclick="editBatsman('${b.id}')" title="Edit">&#9998;</button>
          <button class="btn-icon btn-icon-danger" onclick="deleteBatsman('${b.id}')" title="Delete">&#10006;</button>
        </td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    batsmenContainer.innerHTML = html;
  } else {
    batsmenContainer.innerHTML = '<p class="sc-empty">No batsmen added yet</p>';
  }

  // Render bowlers list
  const bowlersContainer = document.getElementById('admin-bowlers-list');
  if (bowlers.length > 0) {
    let html = '<div class="scorecard-table-wrapper"><table class="scorecard-table">';
    html += '<thead><tr><th class="sc-player">Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Actions</th></tr></thead>';
    html += '<tbody>';
    bowlers.forEach(b => {
      html += `<tr>
        <td class="sc-player"><div class="sc-player-name">${escapeHtml(b.player_name)}</div></td>
        <td>${b.overs}</td>
        <td>${b.maidens}</td>
        <td>${b.runs_conceded}</td>
        <td class="sc-bold">${b.wickets}</td>
        <td class="sc-actions">
          <button class="btn-icon" onclick="editBowler('${b.id}')" title="Edit">&#9998;</button>
          <button class="btn-icon btn-icon-danger" onclick="deleteBowler('${b.id}')" title="Delete">&#10006;</button>
        </td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    bowlersContainer.innerHTML = html;
  } else {
    bowlersContainer.innerHTML = '<p class="sc-empty">No bowlers added yet</p>';
  }
}

// Batsman form
function openAddBatsmanForm() {
  document.getElementById('batsman-edit-id').value = '';
  document.getElementById('batsman-name').value = '';
  document.getElementById('batsman-runs').value = '0';
  document.getElementById('batsman-balls').value = '0';
  document.getElementById('batsman-fours').value = '0';
  document.getElementById('batsman-sixes').value = '0';
  document.getElementById('batsman-status').value = 'yet_to_bat';
  document.getElementById('batsman-dismissal').value = '';
  document.getElementById('batsman-form-container').classList.remove('hidden');
}

function cancelBatsmanForm() {
  document.getElementById('batsman-form-container').classList.add('hidden');
}

function editBatsman(batsmanId) {
  if (!scorecardData) return;
  
  const teamData = currentAdminScorecardTab === 'team1' ? scorecardData.team1 : scorecardData.team2;
  const batsman = teamData.batsmen.find(b => b.id === batsmanId);
  if (!batsman) return;

  document.getElementById('batsman-edit-id').value = batsman.id;
  document.getElementById('batsman-name').value = batsman.player_name;
  document.getElementById('batsman-runs').value = batsman.runs;
  document.getElementById('batsman-balls').value = batsman.balls;
  document.getElementById('batsman-fours').value = batsman.fours;
  document.getElementById('batsman-sixes').value = batsman.sixes;
  document.getElementById('batsman-status').value = batsman.status;
  document.getElementById('batsman-dismissal').value = batsman.dismissal_info || '';
  document.getElementById('batsman-form-container').classList.remove('hidden');
}

async function saveBatsman(e) {
  e.preventDefault();
  if (!currentAdminScorecardMatchId) return;

  const editId = document.getElementById('batsman-edit-id').value;
  const match = matches.find(m => m.id === currentAdminScorecardMatchId);
  if (!match) return;

  const teamName = currentAdminScorecardTab === 'team1' ? match.team1_name : match.team2_name;
  const data = {
    team_name: teamName,
    player_name: document.getElementById('batsman-name').value,
    runs: parseInt(document.getElementById('batsman-runs').value) || 0,
    balls: parseInt(document.getElementById('batsman-balls').value) || 0,
    fours: parseInt(document.getElementById('batsman-fours').value) || 0,
    sixes: parseInt(document.getElementById('batsman-sixes').value) || 0,
    status: document.getElementById('batsman-status').value,
    dismissal_info: document.getElementById('batsman-dismissal').value
  };

  try {
    const url = editId 
      ? `/api/matches/${currentAdminScorecardMatchId}/scorecard/batsman/${editId}`
      : `/api/matches/${currentAdminScorecardMatchId}/scorecard/batsman`;
    
    const res = await fetch(url, {
      method: editId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      cancelBatsmanForm();
      await loadAdminScorecard(currentAdminScorecardMatchId);
    }
  } catch (error) {
    console.error('Failed to save batsman:', error);
  }
}

async function deleteBatsman(batsmanId) {
  if (!confirm('Delete this batsman?')) return;
  if (!currentAdminScorecardMatchId) return;

  try {
    const res = await fetch(`/api/matches/${currentAdminScorecardMatchId}/scorecard/batsman/${batsmanId}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      await loadAdminScorecard(currentAdminScorecardMatchId);
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to delete batsman');
    }
  } catch (error) {
    console.error('Failed to delete batsman:', error);
    alert('Failed to delete batsman. Server may be unavailable.');
  }
}

// Bowler form
function openAddBowlerForm() {
  document.getElementById('bowler-edit-id').value = '';
  document.getElementById('bowler-name').value = '';
  document.getElementById('bowler-overs').value = '0';
  document.getElementById('bowler-maidens').value = '0';
  document.getElementById('bowler-runs').value = '0';
  document.getElementById('bowler-wickets').value = '0';
  document.getElementById('bowler-form-container').classList.remove('hidden');
}

function cancelBowlerForm() {
  document.getElementById('bowler-form-container').classList.add('hidden');
}

function editBowler(bowlerId) {
  if (!scorecardData) return;
  
  const opposingTeamData = currentAdminScorecardTab === 'team1' ? scorecardData.team2 : scorecardData.team1;
  const bowler = opposingTeamData.bowlers.find(b => b.id === bowlerId);
  if (!bowler) return;

  document.getElementById('bowler-edit-id').value = bowler.id;
  document.getElementById('bowler-name').value = bowler.player_name;
  document.getElementById('bowler-overs').value = bowler.overs;
  document.getElementById('bowler-maidens').value = bowler.maidens;
  document.getElementById('bowler-runs').value = bowler.runs_conceded;
  document.getElementById('bowler-wickets').value = bowler.wickets;
  document.getElementById('bowler-form-container').classList.remove('hidden');
}

async function saveBowler(e) {
  e.preventDefault();
  if (!currentAdminScorecardMatchId) return;

  const editId = document.getElementById('bowler-edit-id').value;
  const match = matches.find(m => m.id === currentAdminScorecardMatchId);
  if (!match) return;

  // Bowlers belong to the opposing team
  const teamName = currentAdminScorecardTab === 'team1' ? match.team2_name : match.team1_name;
  const data = {
    team_name: teamName,
    player_name: document.getElementById('bowler-name').value,
    overs: parseFloat(document.getElementById('bowler-overs').value) || 0,
    maidens: parseInt(document.getElementById('bowler-maidens').value) || 0,
    runs_conceded: parseInt(document.getElementById('bowler-runs').value) || 0,
    wickets: parseInt(document.getElementById('bowler-wickets').value) || 0
  };

  try {
    const url = editId
      ? `/api/matches/${currentAdminScorecardMatchId}/scorecard/bowler/${editId}`
      : `/api/matches/${currentAdminScorecardMatchId}/scorecard/bowler`;

    const res = await fetch(url, {
      method: editId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      cancelBowlerForm();
      await loadAdminScorecard(currentAdminScorecardMatchId);
    }
  } catch (error) {
    console.error('Failed to save bowler:', error);
  }
}

async function deleteBowler(bowlerId) {
  if (!confirm('Delete this bowler?')) return;
  if (!currentAdminScorecardMatchId) return;

  try {
    const res = await fetch(`/api/matches/${currentAdminScorecardMatchId}/scorecard/bowler/${bowlerId}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      await loadAdminScorecard(currentAdminScorecardMatchId);
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to delete bowler');
    }
  } catch (error) {
    console.error('Failed to delete bowler:', error);
    alert('Failed to delete bowler. Server may be unavailable.');
  }
}

// Make functions globally available
window.openEditModal = openEditModal;
window.closeEditModal = closeEditModal;
window.openQuickScoreModal = openQuickScoreModal;
window.closeQuickScoreModal = closeQuickScoreModal;
window.quickScore = quickScore;
window.deleteMatch = deleteMatch;
window.updateCameraConfig = updateCameraConfig;
window.deleteCapture = deleteCapture;
window.openPreviewModal = openPreviewModal;
window.closePreviewModal = closePreviewModal;
window.navigatePreview = navigatePreview;
window.openScorecardModal = openScorecardModal;
window.closeScorecardModal = closeScorecardModal;
window.switchScorecardTab = switchScorecardTab;
window.openAdminScorecardModal = openAdminScorecardModal;
window.closeAdminScorecardModal = closeAdminScorecardModal;
window.switchAdminScorecardTab = switchAdminScorecardTab;
window.openAddBatsmanForm = openAddBatsmanForm;
window.cancelBatsmanForm = cancelBatsmanForm;
window.editBatsman = editBatsman;
window.saveBatsman = saveBatsman;
window.deleteBatsman = deleteBatsman;
window.openAddBowlerForm = openAddBowlerForm;
window.cancelBowlerForm = cancelBowlerForm;
window.editBowler = editBowler;
window.saveBowler = saveBowler;
window.deleteBowler = deleteBowler;
window.openFullLBW = openFullLBW;
window.initLBWIframe = initLBWIframe;
