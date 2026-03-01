#!/usr/bin/env python3
"""
LBW Detection System for Raspberry Pi Zero 2W
- OpenCV only - NO MediaPipe required
- Connects to ESP32-CAM stream
- Motion-based ball detection
- Color-based leg/pad detection
- IP configurable via web UI
"""

import cv2
import numpy as np
from flask import Flask, Response, render_template_string, request, jsonify
import threading
import time
import socket
from collections import deque
from datetime import datetime
import urllib.request
import urllib.error
import json
import os

# ============== CONFIG FILE ==============
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lbw_config.json")

def load_config():
    """Load config from file or return defaults"""
    defaults = {
        "esp_ip": "10.96.235.92",
        "stump_x": 160,
        "stump_top": 80,
        "stump_bottom": 200,
        "stump_width": 40
    }
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r') as f:
                saved = json.load(f)
                defaults.update(saved)
    except Exception as e:
        print(f"Config load error: {e}")
    return defaults

def save_config(config):
    """Save config to file"""
    try:
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
        print(f"Config saved")
    except Exception as e:
        print(f"Config save error: {e}")

config = load_config()

# ============== CONFIGURATION ==============
ESP_IP = config["esp_ip"]

FLASK_PORT = 5000
FRAME_W = 320
FRAME_H = 240
JPEG_Q = 60
TARGET_FPS = 12
REPLAY_MAX = 30

# Detection settings
SMOOTHING_FRAMES = 4
BALL_MIN_AREA = 80
BALL_MAX_AREA = 2500
MOTION_THRESHOLD = 25

# ============== AUTO PORT FINDER ==============
def find_free_port(start_port):
    port = start_port
    while port < start_port + 100:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(('', port))
            s.close()
            return port
        except OSError:
            port += 1
    return start_port

FLASK_PORT = find_free_port(5000)

# ============== GLOBALS ==============
app = Flask(__name__)

current_frame = None
processed_frame = None
prev_frame = None
frame_lock = threading.Lock()

replay_buffer = deque(maxlen=REPLAY_MAX)
decision_history = deque(maxlen=20)

stump_config = {
    'x': config["stump_x"],
    'top': config["stump_top"],
    'bottom': config["stump_bottom"],
    'width': config["stump_width"]
}

current_decision = "WAITING"
stream_status = "Connecting..."
detection_status = "Ready"

ball_history = deque(maxlen=SMOOTHING_FRAMES)
motion_history = deque(maxlen=SMOOTHING_FRAMES)

stream_running = False
reconnect_flag = False

# Replay state
replay_active = False
replay_index = 0
replay_speed = 3  # frames to skip per step

# Impact state - stores last detected ball position
last_ball_pos = None
last_pad_area = None

# ============== HELPER FUNCTIONS ==============
def get_esp_url():
    return "http://{}:81/stream".format(ESP_IP)

# ============== BALL DETECTION (Color + Motion) ==============
def detect_ball(frame, prev_gray):
    """Detect ball using color and motion"""
    if frame is None:
        return None, None
    
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    
    # Motion detection
    motion_mask = None
    if prev_gray is not None:
        frame_diff = cv2.absdiff(prev_gray, gray)
        _, motion_mask = cv2.threshold(frame_diff, MOTION_THRESHOLD, 255, cv2.THRESH_BINARY)
        motion_mask = cv2.dilate(motion_mask, None, iterations=2)
    
    # Red ball detection
    lower_red1 = np.array([0, 80, 80])
    upper_red1 = np.array([15, 255, 255])
    lower_red2 = np.array([160, 80, 80])
    upper_red2 = np.array([180, 255, 255])
    
    mask1 = cv2.inRange(hsv, lower_red1, upper_red1)
    mask2 = cv2.inRange(hsv, lower_red2, upper_red2)
    red_mask = cv2.bitwise_or(mask1, mask2)
    
    # White/pink ball detection
    lower_white = np.array([0, 0, 180])
    upper_white = np.array([180, 50, 255])
    white_mask = cv2.inRange(hsv, lower_white, upper_white)
    
    # Combine color masks
    ball_mask = cv2.bitwise_or(red_mask, white_mask)
    
    # Combine with motion if available
    if motion_mask is not None:
        ball_mask = cv2.bitwise_and(ball_mask, motion_mask)
    
    # Clean up mask
    kernel = np.ones((3, 3), np.uint8)
    ball_mask = cv2.erode(ball_mask, kernel, iterations=1)
    ball_mask = cv2.dilate(ball_mask, kernel, iterations=2)
    
    # Find contours
    contours, _ = cv2.findContours(ball_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    best_ball = None
    best_score = 0
    
    for contour in contours:
        area = cv2.contourArea(contour)
        if BALL_MIN_AREA < area < BALL_MAX_AREA:
            perimeter = cv2.arcLength(contour, True)
            if perimeter > 0:
                circularity = 4 * np.pi * area / (perimeter * perimeter)
                if circularity > 0.4:
                    (x, y), radius = cv2.minEnclosingCircle(contour)
                    score = circularity * area
                    if score > best_score:
                        best_score = score
                        best_ball = (int(x), int(y), int(radius))
    
    return best_ball, gray

# ============== PAD/LEG DETECTION ==============
def detect_pad_area(frame):
    """Detect pad/leg area using skin and white pad colors"""
    if frame is None:
        return None
    
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    
    # Skin color detection (for legs)
    lower_skin = np.array([0, 20, 70])
    upper_skin = np.array([20, 150, 255])
    skin_mask = cv2.inRange(hsv, lower_skin, upper_skin)
    
    # White pad detection
    lower_white = np.array([0, 0, 160])
    upper_white = np.array([180, 40, 255])
    white_mask = cv2.inRange(hsv, lower_white, upper_white)
    
    # Combine
    pad_mask = cv2.bitwise_or(skin_mask, white_mask)
    
    # Focus on lower half of frame (where legs are)
    pad_mask[:FRAME_H//3, :] = 0
    
    # Clean up
    kernel = np.ones((5, 5), np.uint8)
    pad_mask = cv2.dilate(pad_mask, kernel, iterations=2)
    pad_mask = cv2.erode(pad_mask, kernel, iterations=1)
    
    # Find largest contour (likely the batsman)
    contours, _ = cv2.findContours(pad_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if contours:
        largest = max(contours, key=cv2.contourArea)
        if cv2.contourArea(largest) > 500:
            x, y, w, h = cv2.boundingRect(largest)
            return {'x': x, 'y': y, 'w': w, 'h': h, 'center_x': x + w//2, 'center_y': y + h//2}
    
    return None

# ============== SMOOTHING ==============
def smooth_ball(ball_pos):
    if ball_pos is None:
        if len(ball_history) > 2:
            ball_history.clear()
        return None
    
    ball_history.append(ball_pos)
    
    if len(ball_history) < 2:
        return ball_pos
    
    x_avg = int(sum(b[0] for b in ball_history) / len(ball_history))
    y_avg = int(sum(b[1] for b in ball_history) / len(ball_history))
    r_avg = int(sum(b[2] for b in ball_history) / len(ball_history))
    
    return (x_avg, y_avg, r_avg)

# ============== LBW DECISION ==============
def check_lbw(ball_pos, pad_area, stump):
    """Simple LBW check"""
    if ball_pos is None:
        return "WAITING"
    
    ball_x, ball_y, ball_r = ball_pos
    
    stump_left = stump['x'] - stump['width'] // 2
    stump_right = stump['x'] + stump['width'] // 2
    stump_top = stump['top']
    stump_bottom = stump['bottom']
    
    # Check if ball is in stump zone
    ball_in_line = stump_left - 30 <= ball_x <= stump_right + 30
    ball_height_ok = stump_top - 20 <= ball_y <= stump_bottom + 20
    
    # Check if ball hit pad area
    hit_pad = False
    pad_in_line = False
    
    if pad_area:
        # Check if ball is near pad
        pad_left = pad_area['x']
        pad_right = pad_area['x'] + pad_area['w']
        pad_top = pad_area['y']
        pad_bottom = pad_area['y'] + pad_area['h']
        
        if (pad_left - 20 <= ball_x <= pad_right + 20 and 
            pad_top - 20 <= ball_y <= pad_bottom + 20):
            hit_pad = True
            
            # Check if pad is in line with stumps
            if stump_left - 40 <= pad_area['center_x'] <= stump_right + 40:
                pad_in_line = True
    
    # Decision logic
    if hit_pad:
        if not pad_in_line:
            return "NOT OUT - OUTSIDE"
        elif not ball_height_ok:
            return "NOT OUT - GOING OVER"
        elif ball_in_line and ball_height_ok:
            return "LBW - OUT!"
    
    return "WAITING"

# ============== FRAME PROCESSING ==============
def process_frame(frame):
    global current_decision, detection_status, prev_frame, last_ball_pos, last_pad_area
    
    if frame is None:
        return None
    
    frame = cv2.resize(frame, (FRAME_W, FRAME_H))
    output = frame.copy()
    
    # Detect ball with motion
    ball_pos, gray = detect_ball(frame, prev_frame)
    prev_frame = gray
    
    ball_pos = smooth_ball(ball_pos)
    
    # Detect pad/leg area
    pad_area = detect_pad_area(frame)
    
    # Store for impact button
    if ball_pos:
        last_ball_pos = ball_pos
    if pad_area:
        last_pad_area = pad_area
    
    # Draw pad area
    if pad_area:
        detection_status = "Tracking"
        cv2.rectangle(output, 
                     (pad_area['x'], pad_area['y']),
                     (pad_area['x'] + pad_area['w'], pad_area['y'] + pad_area['h']),
                     (0, 255, 0), 2)
    else:
        detection_status = "Searching"
    
    # Draw ball
    if ball_pos:
        cv2.circle(output, (ball_pos[0], ball_pos[1]), ball_pos[2] + 5, (0, 0, 255), 2)
        cv2.circle(output, (ball_pos[0], ball_pos[1]), 3, (0, 0, 255), -1)
        cv2.putText(output, "BALL", (ball_pos[0] - 15, ball_pos[1] - 15), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
    
    # Draw stump zone
    stump_left = stump_config['x'] - stump_config['width'] // 2
    stump_right = stump_config['x'] + stump_config['width'] // 2
    cv2.rectangle(output, 
                  (stump_left, stump_config['top']),
                  (stump_right, stump_config['bottom']),
                  (255, 0, 0), 2)
    cv2.putText(output, "STUMPS", (stump_left, stump_config['top'] - 5),
               cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 0, 0), 1)
    
    # LBW decision
    decision = check_lbw(ball_pos, pad_area, stump_config)
    
    if decision != "WAITING":
        current_decision = decision
        timestamp = datetime.now().strftime("%H:%M:%S")
        # Avoid duplicate entries
        if not decision_history or decision_history[0]['decision'] != decision:
            decision_history.appendleft({
                'decision': decision,
                'time': timestamp,
                'auto': True
            })
    
    # Draw decision
    if "OUT" in current_decision and "NOT" not in current_decision:
        color = (0, 0, 255)  # Red for OUT
    elif "NOT OUT" in current_decision:
        color = (0, 255, 0)  # Green for NOT OUT
    else:
        color = (0, 255, 255)  # Yellow for WAITING
    
    cv2.putText(output, current_decision, (10, 25), 
               cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    
    return output

# ============== STREAM CAPTURE ==============
def capture_stream():
    global current_frame, stream_status, stream_running, reconnect_flag
    
    stream_running = True
    
    while stream_running:
        if reconnect_flag:
            reconnect_flag = False
            print(f"Reconnecting to: {ESP_IP}")
        
        try:
            esp_url = get_esp_url()
            print(f"Connecting to {esp_url}...")
            stream = urllib.request.urlopen(esp_url, timeout=10)
            stream_status = "Stream OK"
            print("Connected!")
            
            bytes_data = b''
            while stream_running and not reconnect_flag:
                bytes_data += stream.read(4096)
                a = bytes_data.find(b'\xff\xd8')
                b = bytes_data.find(b'\xff\xd9')
                
                if a != -1 and b != -1:
                    jpg = bytes_data[a:b+2]
                    bytes_data = bytes_data[b+2:]
                    
                    frame = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)
                    if frame is not None:
                        with frame_lock:
                            current_frame = frame.copy()
                            replay_buffer.append(frame.copy())
                            
        except Exception as e:
            stream_status = "Offline"
            print(f"Stream error: {e} - retry 3s")
            time.sleep(3)

def process_stream():
    global processed_frame
    
    while True:
        with frame_lock:
            frame = current_frame.copy() if current_frame is not None else None
        
        if frame is not None:
            output = process_frame(frame)
            if output is not None:
                with frame_lock:
                    processed_frame = output.copy()
        
        time.sleep(1.0 / TARGET_FPS)

# ============== FLASK ROUTES ==============
@app.route('/')
def index():
    return render_template_string('''
<!DOCTYPE html>
<html>
<head>
    <title>LBW Detection</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: #1a1a2e; color: white; min-height: 100vh; }
        .container { max-width: 1200px; margin: 0 auto; padding: 10px; }
        h1 { color: #00ff88; margin-bottom: 10px; font-size: 1.5em; }
        .header { 
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px; background: #16213e; border-radius: 10px; margin-bottom: 10px;
            flex-wrap: wrap; gap: 10px;
        }
        .status { display: flex; gap: 15px; font-size: 12px; flex-wrap: wrap; }
        .status-item { display: flex; align-items: center; gap: 5px; }
        .dot { width: 10px; height: 10px; border-radius: 50%; }
        .dot.green { background: #00ff88; }
        .dot.red { background: #ff4444; }
        .dot.yellow { background: #ffaa00; }
        .main { display: flex; gap: 10px; flex-wrap: wrap; }
        .video-section { flex: 2; min-width: 280px; }
        .video-container { background: #000; border-radius: 10px; overflow: hidden; }
        .video-container img { width: 100%; display: block; }
        .controls { 
            display: flex; gap: 8px; padding: 10px; background: #16213e; 
            border-radius: 0 0 10px 10px; flex-wrap: wrap;
        }
        .btn {
            padding: 8px 14px; border: none; border-radius: 5px;
            cursor: pointer; font-weight: bold; font-size: 12px;
        }
        .btn:active { transform: scale(0.95); }
        .btn-red { background: #ff4444; color: white; }
        .btn-green { background: #00aa55; color: white; }
        .btn-blue { background: #4488ff; color: white; }
        .btn-yellow { background: #ffaa00; color: black; }
        .btn-purple { background: #8844ff; color: white; }
        .sidebar { flex: 1; min-width: 240px; }
        .panel { background: #16213e; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
        .panel h3 { color: #888; font-size: 11px; margin-bottom: 8px; text-transform: uppercase; }
        .decision {
            font-size: 16px; font-weight: bold; text-align: center;
            padding: 12px; border-radius: 5px; background: #0d1b2a;
        }
        .decision.out { color: #ff4444; }
        .decision.not-out { color: #00ff88; }
        .decision.waiting { color: #ffaa00; }
        .slider-group { margin-bottom: 8px; }
        .slider-group label { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
        .slider-group input[type="range"] { width: 100%; }
        .input-group { display: flex; gap: 5px; margin-bottom: 8px; }
        .input-group input[type="text"] {
            flex: 1; padding: 8px; border: 1px solid #333; border-radius: 5px;
            background: #0d1b2a; color: white; font-size: 13px;
        }
        .history-item {
            padding: 6px 8px; background: #0d1b2a; border-radius: 5px;
            margin-bottom: 4px; font-size: 11px; display: flex; justify-content: space-between;
        }
        .history-item.out { border-left: 3px solid #ff4444; }
        .history-item.not-out { border-left: 3px solid #00ff88; }
        .footer { text-align: center; padding: 10px; color: #666; font-size: 10px; }
        .ip-status { font-size: 10px; color: #888; margin-top: 5px; }
        .ip-status.success { color: #00ff88; }
        .ip-status.error { color: #ff4444; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>LBW Detection</h1>
            <div class="status">
                <div class="status-item">
                    <div class="dot" id="streamDot"></div>
                    <span id="streamStatus">...</span>
                </div>
                <div class="status-item">
                    <div class="dot" id="detectDot"></div>
                    <span id="detectStatus">--</span>
                </div>
                <div class="status-item">
                    <span>ESP: <span id="currentIP">{{ esp_ip }}</span></span>
                </div>
            </div>
        </div>
        
        <div class="main">
            <div class="video-section">
                <div class="video-container">
                    <img src="/video_feed" alt="LBW Feed" id="videoFeed">
                </div>
                <div class="controls">
                    <button class="btn btn-red" onclick="manualDecision('out')">Impact</button>
                    <button class="btn btn-green" onclick="calibrate()">Calibrate</button>
                    <button class="btn btn-blue" onclick="replay()">Replay</button>
                    <button class="btn btn-yellow" onclick="reset()">Reset</button>
                </div>
            </div>
            
            <div class="sidebar">
                <div class="panel">
                    <h3>ESP32 Camera IP</h3>
                    <div class="input-group">
                        <input type="text" id="espIP" value="{{ esp_ip }}" placeholder="192.168.1.13">
                        <button class="btn btn-purple" onclick="updateIP()">Connect</button>
                    </div>
                    <div class="ip-status" id="ipStatus">Enter IP and click Connect</div>
                </div>
                
                <div class="panel">
                    <h3>Decision</h3>
                    <div class="decision waiting" id="decision">WAITING</div>
                    <div style="display:flex; gap:5px; margin-top:8px;">
                        <button class="btn btn-red" onclick="manualDecision('out')" style="flex:1; font-size:11px;">OUT</button>
                        <button class="btn btn-green" onclick="manualDecision('notout')" style="flex:1; font-size:11px;">NOT OUT</button>
                    </div>
                </div>
                
                <div class="panel">
                    <h3>Stump Zone</h3>
                    <div class="slider-group">
                        <label><span>X Position</span><span id="xVal">{{ stump_x }}</span></label>
                        <input type="range" id="stumpX" min="0" max="320" value="{{ stump_x }}" oninput="updateSlider()">
                    </div>
                    <div class="slider-group">
                        <label><span>Top</span><span id="topVal">{{ stump_top }}</span></label>
                        <input type="range" id="stumpTop" min="0" max="240" value="{{ stump_top }}" oninput="updateSlider()">
                    </div>
                    <div class="slider-group">
                        <label><span>Bottom</span><span id="bottomVal">{{ stump_bottom }}</span></label>
                        <input type="range" id="stumpBottom" min="0" max="240" value="{{ stump_bottom }}" oninput="updateSlider()">
                    </div>
                    <div class="slider-group">
                        <label><span>Width</span><span id="widthVal">{{ stump_width }}</span></label>
                        <input type="range" id="stumpWidth" min="10" max="120" value="{{ stump_width }}" oninput="updateSlider()">
                    </div>
                    <button class="btn btn-blue" onclick="applyStump()" style="width:100%">Apply</button>
                </div>
                
                <div class="panel">
                    <h3>History</h3>
                    <div id="history">No decisions yet</div>
                    <button class="btn btn-red" onclick="clearHistory()" style="width:100%; margin-top:8px; font-size:11px;">Clear History</button>
                </div>
            </div>
        </div>
        
        <div class="footer">
            RPi Zero 2W + ESP32-CAM | OpenCV LBW Detection | Port {{ port }}
        </div>
    </div>
    
    <script>
        function updateStatus() {
            fetch('/status').then(r => r.json()).then(data => {
                document.getElementById('streamStatus').textContent = data.stream;
                document.getElementById('streamDot').className = 'dot ' + (data.stream === 'Stream OK' ? 'green' : 'red');
                
                document.getElementById('detectStatus').textContent = data.detection;
                document.getElementById('detectDot').className = 'dot ' + (data.detection === 'Tracking' ? 'green' : 'yellow');
                
                document.getElementById('currentIP').textContent = data.esp_ip;
                
                const dec = document.getElementById('decision');
                dec.textContent = data.decision;
                dec.className = 'decision ' + (data.decision.includes('OUT!') ? 'out' : data.decision.includes('NOT OUT') ? 'not-out' : 'waiting');
                
                const hist = document.getElementById('history');
                if (data.history.length > 0) {
                    hist.innerHTML = data.history.slice(0, 8).map(h => 
                        '<div class="history-item ' + (h.decision.includes('OUT!') ? 'out' : 'not-out') + '">' +
                        '<span>' + h.decision + '</span><span>' + (h.auto ? '[A]' : '[M]') + ' ' + h.time + '</span></div>'
                    ).join('');
                }
            }).catch(e => {});
        }
        
        function updateIP() {
            const ip = document.getElementById('espIP').value.trim();
            const status = document.getElementById('ipStatus');
            if (!ip) { status.textContent = 'Enter an IP'; status.className = 'ip-status error'; return; }
            status.textContent = 'Connecting...'; status.className = 'ip-status';
            fetch('/update_ip', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ip: ip})
            }).then(r => r.json()).then(data => {
                if (data.success) {
                    status.textContent = 'Connected! Refreshing...'; status.className = 'ip-status success';
                    document.getElementById('videoFeed').src = '/video_feed?' + Date.now();
                } else {
                    status.textContent = 'Error: ' + data.error; status.className = 'ip-status error';
                }
            });
        }
        
        function updateSlider() {
            document.getElementById('xVal').textContent = document.getElementById('stumpX').value;
            document.getElementById('topVal').textContent = document.getElementById('stumpTop').value;
            document.getElementById('bottomVal').textContent = document.getElementById('stumpBottom').value;
            document.getElementById('widthVal').textContent = document.getElementById('stumpWidth').value;
        }
        
        function applyStump() {
            fetch('/stump', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    x: parseInt(document.getElementById('stumpX').value),
                    top: parseInt(document.getElementById('stumpTop').value),
                    bottom: parseInt(document.getElementById('stumpBottom').value),
                    width: parseInt(document.getElementById('stumpWidth').value)
                })
            });
        }
        
        function manualDecision(type) {
            fetch('/decision', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({type: type})
            });
        }
        
        function reset() { fetch('/reset', {method: 'POST'}); }
        function calibrate() { 
            fetch('/calibrate', {method: 'POST'}).then(r => r.json()).then(data => {
                if (data.success && data.stump) {
                    document.getElementById('stumpX').value = data.stump.x;
                    document.getElementById('stumpTop').value = data.stump.top;
                    document.getElementById('stumpBottom').value = data.stump.bottom;
                    document.getElementById('stumpWidth').value = data.stump.width;
                    updateSlider();
                }
            });
        }
        function replay() { 
            fetch('/replay', {method: 'POST'}).then(r => r.json()).then(data => {
                if (data.success) {
                    var vid = document.getElementById('videoFeed');
                    vid.src = '/replay_feed?' + Date.now();
                    setTimeout(function() { vid.src = '/video_feed?' + Date.now(); }, data.frames * 150 + 2000);
                }
            });
        }
        function clearHistory() { fetch('/clear_history', {method: 'POST'}).then(() => { document.getElementById('history').innerHTML = 'No decisions yet'; }); }
        
        document.getElementById('espIP').addEventListener('keypress', e => { if (e.key === 'Enter') updateIP(); });
        
        setInterval(updateStatus, 500);
        updateStatus();
    </script>
</body>
</html>
    ''', esp_ip=ESP_IP, port=FLASK_PORT,
        stump_x=stump_config['x'], stump_top=stump_config['top'],
        stump_bottom=stump_config['bottom'], stump_width=stump_config['width'])

@app.route('/video_feed')
def video_feed():
    def generate():
        while True:
            with frame_lock:
                frame = processed_frame.copy() if processed_frame is not None else None
            if frame is not None:
                _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
                yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            time.sleep(1.0 / TARGET_FPS)
    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/status')
def status():
    return jsonify({
        'stream': stream_status,
        'detection': detection_status,
        'decision': current_decision,
        'esp_ip': ESP_IP,
        'history': list(decision_history)[:10]
    })

@app.route('/update_ip', methods=['POST'])
def update_ip():
    global ESP_IP, reconnect_flag, config
    try:
        data = request.json
        new_ip = data.get('ip', '').strip()
        if not new_ip:
            return jsonify({'success': False, 'error': 'No IP'})
        parts = new_ip.split('.')
        if len(parts) != 4:
            return jsonify({'success': False, 'error': 'Invalid IP'})
        ESP_IP = new_ip
        reconnect_flag = True
        config['esp_ip'] = new_ip
        save_config(config)
        return jsonify({'success': True, 'ip': ESP_IP})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/stump', methods=['POST'])
def update_stump():
    global stump_config, config
    data = request.json
    stump_config.update(data)
    config.update({'stump_x': data['x'], 'stump_top': data['top'], 
                   'stump_bottom': data['bottom'], 'stump_width': data['width']})
    save_config(config)
    return jsonify({'success': True})

@app.route('/decision', methods=['POST'])
def manual_decision():
    """Manual decision - OUT button forces OUT, NOT OUT forces NOT OUT, 
       Impact evaluates current ball/pad positions"""
    global current_decision
    data = request.json
    dtype = data.get('type', '')
    
    if dtype == 'out':
        # Impact button - evaluate actual conditions
        if last_ball_pos and last_pad_area:
            decision = check_lbw(last_ball_pos, last_pad_area, stump_config)
            if decision == "WAITING":
                decision = "LBW - OUT!"  # If ball was near pad, default to out
            current_decision = decision
        elif last_ball_pos:
            # Ball detected but no pad - check if in line with stumps
            bx, by, br = last_ball_pos
            sl = stump_config['x'] - stump_config['width'] // 2
            sr = stump_config['x'] + stump_config['width'] // 2
            if sl - 30 <= bx <= sr + 30 and stump_config['top'] - 20 <= by <= stump_config['bottom'] + 20:
                current_decision = "LBW - OUT!"
            else:
                current_decision = "NOT OUT - OUTSIDE"
        else:
            current_decision = "LBW - OUT!"  # Manual override
    elif dtype == 'notout':
        current_decision = "NOT OUT"
    elif dtype == 'force_out':
        current_decision = "LBW - OUT!"
    
    decision_history.appendleft({
        'decision': current_decision,
        'time': datetime.now().strftime("%H:%M:%S"),
        'auto': False
    })
    return jsonify({'success': True, 'decision': current_decision})

@app.route('/reset', methods=['POST'])
def reset():
    global current_decision, prev_frame
    current_decision = "WAITING"
    prev_frame = None
    ball_history.clear()
    return jsonify({'success': True})

@app.route('/calibrate', methods=['POST'])
def calibrate():
    """Auto-calibrate stump position based on largest vertical object in center"""
    global stump_config, detection_status, config
    detection_status = "Calibrating..."
    
    with frame_lock:
        frame = current_frame.copy() if current_frame is not None else None
    
    if frame is not None:
        frame = cv2.resize(frame, (FRAME_W, FRAME_H))
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150)
        
        # Focus on center area where stumps likely are
        center_x = FRAME_W // 2
        margin = FRAME_W // 4
        edges[:, :center_x - margin] = 0
        edges[:, center_x + margin:] = 0
        
        # Find vertical lines (stumps are vertical)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if contours:
            # Find tallest contour in center (likely stumps)
            best = None
            best_h = 0
            for c in contours:
                x, y, w, h = cv2.boundingRect(c)
                if h > best_h and h > 30 and w < FRAME_W // 3:
                    best_h = h
                    best = (x, y, w, h)
            
            if best:
                x, y, w, h = best
                stump_config['x'] = x + w // 2
                stump_config['top'] = y
                stump_config['bottom'] = y + h
                stump_config['width'] = max(w + 10, 30)
                
                config.update({
                    'stump_x': stump_config['x'],
                    'stump_top': stump_config['top'],
                    'stump_bottom': stump_config['bottom'],
                    'stump_width': stump_config['width']
                })
                save_config(config)
                detection_status = "Calibrated"
                return jsonify({'success': True, 'stump': stump_config})
    
    detection_status = "Cal Failed"
    return jsonify({'success': False, 'error': 'No stumps detected'})

@app.route('/replay', methods=['POST'])
def replay():
    """Start replay mode - serves buffered frames as a slow-motion video"""
    global replay_active, replay_index
    
    if len(replay_buffer) == 0:
        return jsonify({'success': False, 'error': 'No frames buffered'})
    
    replay_active = True
    replay_index = 0
    return jsonify({'success': True, 'frames': len(replay_buffer)})

@app.route('/replay_feed')
def replay_feed():
    """Serve replay as MJPEG stream"""
    def generate():
        idx = 0
        frames = list(replay_buffer)
        while idx < len(frames):
            frame = cv2.resize(frames[idx], (FRAME_W, FRAME_H))
            # Add replay overlay
            cv2.putText(frame, f"REPLAY {idx+1}/{len(frames)}", (10, 25),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
            yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            time.sleep(0.15)  # Slow motion
            idx += 1
        # After replay ends, signal done
        for _ in range(3):
            if len(frames) > 0:
                frame = cv2.resize(frames[-1], (FRAME_W, FRAME_H))
                cv2.putText(frame, "REPLAY DONE", (10, 25),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
                _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
                yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
            time.sleep(0.5)
    
    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/clear_history', methods=['POST'])
def clear_history():
    decision_history.clear()
    return jsonify({'success': True})

# ============== MAIN ==============
if __name__ == '__main__':
    print("=" * 40)
    print("LBW Detection - OpenCV Only")
    print("=" * 40)
    print(f"ESP32 IP: {ESP_IP}")
    print(f"Flask Port: {FLASK_PORT}")
    print(f"Open: http://<rpi-ip>:{FLASK_PORT}/")
    print("=" * 40)
    
    capture_thread = threading.Thread(target=capture_stream, daemon=True)
    capture_thread.start()
    
    process_thread = threading.Thread(target=process_stream, daemon=True)
    process_thread.start()
    
    app.run(host='0.0.0.0', port=FLASK_PORT, threaded=True, debug=False)
