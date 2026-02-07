// State
let currentUser = null;
let matches = [];
let cameraConfig = {};
let currentQuickScoreMatch = null;
let mediaRecorder = null;
let recordedChunks = [];
let capturesList = [];
let currentPreviewIndex = 0;

// Socket.IO connection
const socket = io();

// DOM Elements
const navbar = document.getElementById('navbar');
const authPage = document.getElementById('auth-page');
const dashboardPage = document.getElementById('dashboard-page');
const liveStreamPage = document.getElementById('live-stream-page');
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
  adminPage.classList.add('hidden');

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
        </div>
      ` : ''}
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
    await fetch(`/api/matches/${id}`, { method: 'DELETE' });
  } catch (error) {
    console.error('Failed to delete match:', error);
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
  // Raspberry Pi stream
  const rpiStream = document.getElementById('rpi-stream');
  const rpiStatus = document.getElementById('rpi-status');
  const rpiOffline = document.getElementById('rpi-offline');
  const rpiUrlInput = document.getElementById('rpi-url');
  
  if (cameraConfig.raspberryPi) {
    if (rpiUrlInput) rpiUrlInput.value = cameraConfig.raspberryPi.url;
    
    if (cameraConfig.raspberryPi.enabled && cameraConfig.raspberryPi.url) {
      rpiStream.src = cameraConfig.raspberryPi.url;
      rpiStream.onload = () => {
        rpiStatus.textContent = 'Online';
        rpiStatus.className = 'status-badge status-live';
        rpiOffline.classList.add('hidden');
      };
      rpiStream.onerror = () => {
        rpiStatus.textContent = 'Offline';
        rpiStatus.className = 'status-badge status-upcoming';
        rpiOffline.classList.remove('hidden');
      };
    } else {
      rpiOffline.classList.remove('hidden');
      rpiStatus.textContent = 'Disabled';
    }
  }
  
  // ESP32 stream - MJPEG stream is at port 81
  const esp32Stream = document.getElementById('esp32-stream');
  const esp32Status = document.getElementById('esp32-status');
  const esp32Offline = document.getElementById('esp32-offline');
  const esp32UrlInput = document.getElementById('esp32-url');
  
  if (cameraConfig.esp32) {
    if (esp32UrlInput) esp32UrlInput.value = cameraConfig.esp32.url;
    
    if (cameraConfig.esp32.enabled && cameraConfig.esp32.url) {
      esp32Stream.src = cameraConfig.esp32.url;
      esp32Stream.onload = () => {
        esp32Status.textContent = 'Online';
        esp32Status.className = 'status-badge status-live';
        esp32Offline.classList.add('hidden');
      };
      esp32Stream.onerror = () => {
        esp32Status.textContent = 'Offline';
        esp32Status.className = 'status-badge status-upcoming';
        rpiOffline.classList.remove('hidden');
      };
      // For MJPEG streams, the onload may not fire, so check after timeout
      setTimeout(() => {
        if (esp32Stream.complete || esp32Stream.naturalWidth > 0) {
          esp32Status.textContent = 'Streaming';
          esp32Status.className = 'status-badge status-live';
          esp32Offline.classList.add('hidden');
        }
      }, 3000);
    } else {
      esp32Offline.classList.remove('hidden');
      esp32Status.textContent = 'Disabled';
    }
  }
}

async function updateCameraConfig(camera) {
  const urlInput = camera === 'raspberryPi' 
    ? document.getElementById('rpi-url')
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
          <div>${capture.source === 'raspberry_pi' ? 'Raspberry Pi' : 'ESP32'}</div>
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
    capture.source === 'raspberry_pi' ? 'Raspberry Pi' : 'ESP32';
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
