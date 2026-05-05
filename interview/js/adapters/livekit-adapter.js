/**
 * ACP Interview — LiveKit Adapter
 * 
 * Wraps the LiveKit JS Client SDK for voice agent connections.
 * Handles: Room connection, mic toggle, audio playback, data messages.
 * 
 * Data messages from TranscriptForwarder arrive as JSON:
 * { type: "transcript", role: "user"|"assistant", content: "...", sequence: N }
 * 
 * Usage:
 *   const adapter = new LiveKitAdapter({ onMessage, onStatusChange, onAudioLevel });
 *   await adapter.connect(token, roomName);
 *   adapter.setMicEnabled(true);
 *   adapter.disconnect();
 */

// LiveKit SDK loaded via CDN in interview.html
// <script src="https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js"></script>

class LiveKitAdapter {
  /**
   * @param {Object} opts
   * @param {Function} opts.onMessage - (role, content, data) => void
   * @param {Function} opts.onStatusChange - (status: 'connecting'|'connected'|'disconnected'|'error') => void
   * @param {Function} opts.onAudioLevel - (level: 0-1) => void  
   * @param {Function} opts.onTopicChange - (topicId, topicIndex) => void
   * @param {string}   opts.serverUrl - LiveKit server URL
   */
  constructor(opts = {}) {
    this.onMessage = opts.onMessage || (() => {});
    this.onStatusChange = opts.onStatusChange || (() => {});
    this.onAudioLevel = opts.onAudioLevel || (() => {});
    this.onTopicChange = opts.onTopicChange || (() => {});
    this.serverUrl = opts.serverUrl || 'wss://lk.n8n-mxs.com';
    
    this.room = null;
    this.audioContext = null;
    this.analyserNode = null;
    this._levelInterval = null;
    this._connected = false;
  }

  /**
   * Connect to a LiveKit room.
   * @param {string} token - JWT token from n8n endpoint
   * @param {string} roomName - Room name (for logging)
   */
  async connect(token, roomName = '') {
    this.onStatusChange('connecting');
    
    try {
      const { Room, RoomEvent } = window.LivekitClient || window;
      
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      
      // ─── Event Handlers ───
      
      // Connected
      this.room.on(RoomEvent.Connected, () => {
        console.log('[LiveKit] Connected to room:', roomName);
        this._connected = true;
        this.onStatusChange('connected');
      });
      
      // Disconnected
      this.room.on(RoomEvent.Disconnected, (reason) => {
        console.log('[LiveKit] Disconnected:', reason);
        this._connected = false;
        this.onStatusChange('disconnected');
        this._stopAudioAnalysis();
      });
      
      // Remote audio track subscribed (agent's voice)
      this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === 'audio') {
          console.log('[LiveKit] Agent audio track received');
          const audioEl = track.attach();
          audioEl.id = 'agent-audio';
          document.body.appendChild(audioEl);
          audioEl.play().catch(e => console.warn('Audio autoplay blocked:', e));
        }
      });
      
      // Remote track unsubscribed
      this.room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach(el => el.remove());
      });
      
      // Data messages from TranscriptForwarder
      this.room.on(RoomEvent.DataReceived, (data, participant) => {
        try {
          const msg = JSON.parse(new TextDecoder().decode(data));
          
          if (msg.type === 'transcript') {
            this.onMessage(msg.role, msg.content, msg);
          } else if (msg.type === 'topic_change') {
            this.onTopicChange(msg.topic_id, msg.topic_index);
          }
        } catch (e) {
          console.warn('[LiveKit] Data message parse error:', e);
        }
      });
      
      // Connection quality
      this.room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant.isLocal) {
          console.log('[LiveKit] Connection quality:', quality);
        }
      });
      
      // ─── Connect ───
      await this.room.connect(this.serverUrl, token);
      
      // Start audio (required for autoplay policy)
      await this.room.startAudio();
      
      console.log('[LiveKit] Room connected successfully');
      
    } catch (error) {
      console.error('[LiveKit] Connection error:', error);
      this.onStatusChange('error');
      throw error;
    }
  }

  /**
   * Enable/disable local microphone.
   * @param {boolean} enabled
   */
  async setMicEnabled(enabled) {
    if (!this.room || !this._connected) return;
    
    try {
      await this.room.localParticipant.setMicrophoneEnabled(enabled);
      console.log(`[LiveKit] Mic ${enabled ? 'enabled' : 'disabled'}`);
      
      if (enabled) {
        this._startAudioAnalysis();
      } else {
        this._stopAudioAnalysis();
      }
    } catch (error) {
      console.error('[LiveKit] Mic toggle error:', error);
    }
  }

  /**
   * Disconnect from room.
   */
  async disconnect() {
    this._stopAudioAnalysis();
    
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
    
    // Remove agent audio element
    const audioEl = document.getElementById('agent-audio');
    if (audioEl) audioEl.remove();
    
    this._connected = false;
    this.onStatusChange('disconnected');
    console.log('[LiveKit] Disconnected');
  }

  /**
   * Check if currently connected.
   */
  get isConnected() {
    return this._connected;
  }

  // ─── Audio Level Analysis (for visualization) ───
  
  _startAudioAnalysis() {
    if (this._levelInterval) return;
    
    try {
      const localTrack = this.room?.localParticipant?.getTrackPublication('microphone');
      if (!localTrack?.track?.mediaStreamTrack) return;
      
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const stream = new MediaStream([localTrack.track.mediaStreamTrack]);
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      source.connect(this.analyserNode);
      
      const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
      
      this._levelInterval = setInterval(() => {
        this.analyserNode.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        this.onAudioLevel(avg / 255); // Normalize to 0-1
      }, 50);
      
    } catch (e) {
      console.warn('[LiveKit] Audio analysis setup failed:', e);
    }
  }

  _stopAudioAnalysis() {
    if (this._levelInterval) {
      clearInterval(this._levelInterval);
      this._levelInterval = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.onAudioLevel(0);
  }
}

// Export for use in interview.html
if (typeof window !== 'undefined') {
  window.LiveKitAdapter = LiveKitAdapter;
}
