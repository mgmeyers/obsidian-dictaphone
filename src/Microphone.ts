export const SAMPLE_RATE = 16000;

// Inline audio worklet processor code as a string
const AUDIO_PROCESSOR_CODE = `
const MAX_16BIT_INT = 32767

class AudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    try {
      const input = inputs[0]
      if (!input) throw new Error('No input')

      const channelData = input[0]
      if (!channelData) throw new Error('No channelData')

      const float32Array = Float32Array.from(channelData)
      const int16Array = Int16Array.from(
        float32Array.map((n) => n * MAX_16BIT_INT)
      )
      const buffer = int16Array.buffer
      this.port.postMessage({ audio_data: buffer })

      return true
    } catch (error) {
      console.error(error)
      return false
    }
  }
}

registerProcessor('audio-processor', AudioProcessor)
`;

/**
 * Utility function to merge two Int16Arrays
 */
function mergeBuffers(lhs: Int16Array, rhs: Int16Array) {
  const mergedBuffer = new Int16Array(lhs.length + rhs.length);
  mergedBuffer.set(lhs, 0);
  mergedBuffer.set(rhs, lhs.length);
  return mergedBuffer;
}

/**
 * Class for handling microphone access and audio recording
 */
export class Microphone {
  private audioBufferQueue = new Int16Array(0);
  private audioContext: AudioContext | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  /**
   * Request permission to access the microphone
   */
  async requestPermission() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stopRecording();
  }

  /**
   * Acquires a wake lock to prevent the screen from sleeping
   * @returns Promise that resolves when the wake lock is acquired
   */
  private async acquireWakeLock(): Promise<void> {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
      }
    } catch (error) {
      console.error('[Dictaphone] Error acquiring wake lock:', error);
    }
  }

  /**
   * Releases the wake lock to allow the screen to sleep
   */
  private releaseWakeLock(): void {
    if (this.wakeLock) {
      this.wakeLock
        .release()
        .then(() => {
          this.wakeLock = null;
        })
        .catch((error) => {
          console.error('[Dictaphone] Error releasing wake lock:', error);
        });
    }
  }

  /**
   * Start recording audio from the microphone
   * @param onAudioCallback Callback function to receive audio data
   * @param onDisconnectCallback Callback function when microphone is disconnected
   */
  async startRecording(
    onAudioCallback: (buffer: Uint8Array) => void,
    onDisconnectCallback?: () => void
  ) {
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    // Acquire wake lock to keep screen on
    await this.acquireWakeLock();

    navigator.mediaDevices.addEventListener(
      'devicechange',
      this.handleDeviceChange
    );
    this.onDisconnectCallback = onDisconnectCallback ?? null;

    this.audioContext = new AudioContext({
      sampleRate: SAMPLE_RATE,
      latencyHint: 'balanced',
    });

    this.source = this.audioContext.createMediaStreamSource(this.stream);

    const blob = new Blob([AUDIO_PROCESSOR_CODE], {
      type: 'application/javascript',
    });
    const url = URL.createObjectURL(blob);

    await this.audioContext.audioWorklet.addModule(url);
    this.audioWorkletNode = new AudioWorkletNode(
      this.audioContext,
      'audio-processor'
    );

    this.source.connect(this.audioWorkletNode);
    this.audioWorkletNode.connect(this.audioContext.destination);
    this.audioWorkletNode.port.onmessage = (event) => {
      if (!this.audioContext) return;

      const currentBuffer = new Int16Array(event.data.audio_data);
      this.audioBufferQueue = mergeBuffers(
        this.audioBufferQueue,
        currentBuffer
      );

      const bufferDuration =
        (this.audioBufferQueue.length / this.audioContext.sampleRate) * 1000;

      // wait until we have 100ms of audio data
      if (bufferDuration >= 100) {
        const totalSamples = Math.floor(this.audioContext.sampleRate * 0.1);

        const finalBuffer = new Uint8Array(
          this.audioBufferQueue.subarray(0, totalSamples).buffer
        );

        this.audioBufferQueue = this.audioBufferQueue.subarray(totalSamples);
        if (onAudioCallback) onAudioCallback(finalBuffer);
      }
    };

    // Add error handlers for the media stream
    this.stream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', () => {
        console.log('[Dictaphone] Audio track ended unexpectedly');
        this.stopRecording();
      })
    });

    this.audioContext.addEventListener('statechange', () => {
      if (this.audioContext?.state === 'suspended' || this.audioContext?.state === 'closed') {
        console.log('[Dictaphone] Audio context state changed:', this.audioContext.state);
        this.stopRecording();
      }
    })
  }

  handleDeviceChange = () => {
    this.stopRecording();
    this.onDisconnectCallback?.();
  };

  /**
   * Stop recording and clean up resources
   */
  stopRecording() {
    this.releaseWakeLock();

    navigator.mediaDevices.removeEventListener(
      'devicechange',
      this.handleDeviceChange
    );

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    if (this.audioContext?.state !== 'closed') {
      this.audioContext?.close();
    }
    this.audioContext = null;
    this.audioBufferQueue = new Int16Array(0);
    this.onDisconnectCallback = null;
    this.audioWorkletNode?.disconnect();
    this.audioWorkletNode = null;
    this.source?.disconnect();
    this.source = null;
  }
}
