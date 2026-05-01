/**
 * ACP Interview — xAI Realtime Voice Agent Adapter
 * 
 * Connects directly to xAI Grok Voice Agent via WebSocket.
 * Speech-to-Speech natively (no separate STT/TTS needed).
 * Sub-second latency (~700ms).
 * 
 * Authentication: Ephemeral token from n8n endpoint.
 * Model: grok-voice-think-fast-1.0
 * 
 * Usage:
 *   const adapter = new XaiRealtimeAdapter({ onMessage, onStatusChange, onAudioLevel });
 *   await adapter.connect(ephemeralToken, systemPrompt);
 *   adapter.setMicEnabled(true);
 *   adapter.disconnect();
 */

class XaiRealtimeAdapter {
  /**
   * @param {Object} opts
   * @param {Function} opts.onMessage - (role, content, data) => void
   * @param {Function} opts.onStatusChange - (status) => void
   * @param {Function} opts.onAudioLevel - (level: 0-1) => void
   * @param {Function} opts.onTopicChange - (topicId, topicIndex) => void
   * @param {string}   opts.model - Grok model (default: grok-voice-think-fast-1.0)
   * @param {string}   opts.voice - Voice name (default: eve)
   */
  constructor(opts = {}) {
    this.onMessage = opts.onMessage || (() => {});
    this.onStatusChange = opts.onStatusChange || (() => {});
    this.onAudioLevel = opts.onAudioLevel || (() => {});
    this.onTopicChange = opts.onTopicChange || (() => {});
    this.model = opts.model || 'grok-voice-think-fast-1.0';
    this.voice = opts.voice || 'eve';
    
    this.ws = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.audioWorklet = null;
    this._connected = false;
    this._micEnabled = false;
    this._responseBuffer = '';
    this._audioQueue = [];
    this._isPlaying = false;
  }

  /**
   * Connect to xAI Realtime Voice Agent.
   * @param {string} ephemeralToken - Short-lived token from n8n
   * @param {string} systemPrompt - System instructions for the agent
   */
  async connect(ephemeralToken, systemPrompt = '') {
    this.onStatusChange('connecting');
    
    try {
      // ─── WebSocket Connection ───
      const wsUrl = `wss://api.x.ai/v1/realtime?model=${this.model}`;
      this.ws = new WebSocket(wsUrl, [`xai-client-secret.${ephemeralToken}`]);
      
      this.ws.onopen = () => {
        console.log('[xAI] WebSocket connected');
        this._connected = true;
        this.onStatusChange('connected');
        
        // Configure session
        this._sendEvent({
          type: 'session.update',
          session: {
            voice: this.voice,
            instructions: systemPrompt,
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
          }
        });
      };
      
      this.ws.onmessage = (event) => {
        this._handleEvent(JSON.parse(event.data));
      };
      
      this.ws.onerror = (error) => {
        console.error('[xAI] WebSocket error:', error);
        this.onStatusChange('error');
      };
      
      this.ws.onclose = (event) => {
        console.log('[xAI] WebSocket closed:', event.code, event.reason);
        this._connected = false;
        this.onStatusChange('disconnected');
        this._stopMic();
      };
      
      // ─── Audio Context for playback ───
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 24000
      });
      
    } catch (error) {
      console.error('[xAI] Connection error:', error);
      this.onStatusChange('error');
      throw error;
    }
  }

  /**
   * Enable/disable microphone.
   */
  async setMicEnabled(enabled) {
    this._micEnabled = enabled;
    
    if (enabled) {
      await this._startMic();
    } else {
      this._stopMic();
    }
    
    console.log(`[xAI] Mic ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Disconnect from xAI.
   */
  async disconnect() {
    this._stopMic();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    
    this._connected = false;
    this.onStatusChange('disconnected');
    console.log('[xAI] Disconnected');
  }

  get isConnected() {
    return this._connected;
  }

  /**
   * Update the voice agent's instructions dynamically.
   * Used by the Opus orchestrator to steer the conversation.
   * @param {string} newInstructions - New system instructions for the agent
   */
  updateInstructions(newInstructions) {
    if (!this._connected || !this.ws) {
      console.warn('[xAI] Cannot update instructions — not connected');
      return;
    }
    this._sendEvent({
      type: 'session.update',
      session: { instructions: newInstructions }
    });
    console.log('[xAI] Instructions updated by orchestrator');
  }

  // ─── Event Handling ───

  _handleEvent(event) {
    switch (event.type) {
      case 'session.created':
        console.log('[xAI] Session created:', event.session?.id);
        break;
        
      case 'response.audio_transcript.delta':
        // Agent is speaking — accumulate text
        this._responseBuffer += event.delta || '';
        break;
        
      case 'response.audio_transcript.done':
        // Agent finished a response
        if (this._responseBuffer.trim()) {
          this.onMessage('assistant', this._responseBuffer.trim(), event);
          this._responseBuffer = '';
        }
        break;
        
      case 'response.output_audio.delta':
        // Raw audio chunk — queue for playback
        if (event.delta) {
          this._queueAudio(event.delta);
        }
        break;
        
      case 'conversation.item.input_audio_transcription.completed':
        // User speech transcribed
        if (event.transcript?.trim()) {
          this.onMessage('user', event.transcript.trim(), event);
        }
        break;
        
      case 'input_audio_buffer.speech_started':
        console.log('[xAI] User speaking...');
        break;
        
      case 'input_audio_buffer.speech_stopped':
        console.log('[xAI] User stopped speaking');
        break;
        
      case 'error':
        console.error('[xAI] Server error:', event.error);
        break;
        
      default:
        // Log unknown events in dev
        if (event.type && !event.type.startsWith('response.audio.')) {
          console.debug('[xAI] Event:', event.type);
        }
    }
  }

  _sendEvent(event) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  // ─── Microphone Capture ───

  async _startMic() {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
      
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      // Use ScriptProcessor for PCM16 capture (AudioWorklet would be better but more complex)
      const processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        if (!this._micEnabled || !this._connected) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Calculate audio level for visualization
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        this.onAudioLevel(Math.min(1, rms * 5));
        
        // Convert Float32 to PCM16 and send
        const pcm16 = this._float32ToPcm16(inputData);
        const base64 = this._arrayBufferToBase64(pcm16.buffer);
        
        this._sendEvent({
          type: 'input_audio_buffer.append',
          audio: base64,
        });
      };
      
      source.connect(processor);
      processor.connect(this.audioContext.destination);
      
      this._processor = processor;
      this._source = source;
      
      console.log('[xAI] Microphone started');
      
    } catch (error) {
      console.error('[xAI] Microphone error:', error);
    }
  }

  _stopMic() {
    if (this._processor) {
      this._processor.disconnect();
      this._processor = null;
    }
    if (this._source) {
      this._source.disconnect();
      this._source = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.onAudioLevel(0);
  }

  // ─── Audio Playback ───

  _queueAudio(base64Data) {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    
    // Convert PCM16 to Float32 for Web Audio API
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    
    this._audioQueue.push(float32);
    if (!this._isPlaying) this._playNextChunk();
  }

  _playNextChunk() {
    if (!this._audioQueue.length || !this.audioContext) {
      this._isPlaying = false;
      return;
    }
    
    this._isPlaying = true;
    const data = this._audioQueue.shift();
    
    const buffer = this.audioContext.createBuffer(1, data.length, 24000);
    buffer.getChannelData(0).set(data);
    
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    source.onended = () => this._playNextChunk();
    source.start();
  }

  // ─── Utilities ───

  _float32ToPcm16(float32Array) {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }

  _arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

// Export
if (typeof window !== 'undefined') {
  window.XaiRealtimeAdapter = XaiRealtimeAdapter;
}
