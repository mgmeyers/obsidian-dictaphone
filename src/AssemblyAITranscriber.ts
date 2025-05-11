import { Editor, request } from 'obsidian';
import { SAMPLE_RATE } from 'src/Microphone';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  transcriptionStart,
  postprocessStart,
  transcriptionEnd,
} from './editorPlugin';
import { Microphone } from './Microphone';
import Dictaphone from './main';
import { notificationSound } from './notificationSound';

function playDisconnectNotification() {
  const audio = new Audio(notificationSound);
  audio.play();
}

/**
 * Utility function to remove leading and trailing spaces from a string
 * @param text - The input string to trim
 * @returns The trimmed string
 */
function trimSpaces(text: string): string {
  return text.replace(/^ +| +$/g, '');
}

/**
 * Splits a text into sentences based on sentence terminal punctuation
 * Uses Unicode property 'Sentence_Terminal' to identify sentence endings
 * @param text - The input text to split into sentences
 * @returns Array of sentences
 */
function stringToSentences(text: string): string[] {
  // Find all sentence terminal punctuation marks using Unicode properties
  const matches = text.matchAll(/\p{Sentence_Terminal}/gu);
  const sentences = [];
  let lastIndex = 0;

  // Process each sentence terminal match
  for (const match of matches) {
    let nextIndex = match.index + match[0].length;
    sentences.push(trimSpaces(text.slice(lastIndex, nextIndex)));
    lastIndex = nextIndex;
  }

  // Handle any remaining text after the last sentence terminal
  let lastSentence = trimSpaces(text.slice(lastIndex));
  if (lastSentence) {
    sentences.push(lastSentence);
  }
  return sentences;
}

/**
 * Array of text transformation functions to be applied to transcribed text
 * Currently includes:
 * - Converting "new line" or "newline" commands to actual newlines
 */
const transforms = [
  (text: string) => {
    return stringToSentences(text)
      .map((sentence) => {
        // Replace "new line" or "newline" commands with actual newlines
        if (/^(new line|newline)\p{Sentence_Terminal}/iu.test(sentence)) {
          return '\n\n';
        }
        return sentence;
      })
      .join(' ');
  },
];

/**
 * AssemblyAI Transcriber class that handles real-time speech-to-text transcription
 * using AssemblyAI's WebSocket API. Integrates with Obsidian's editor for live
 * text insertion and updates.
 */
export class AssemblyAITranscriber {
  private plugin: Dictaphone;
  private microphone: Microphone; // Microphone handler
  private apiKey: string; // AssemblyAI API key
  private websocket: WebSocket | null = null; // WebSocket connection to AssemblyAI
  private transcribedLines: { from: number; to: number } = { from: -1, to: -1 }; // Track transcribed line range
  private activeEditor: Editor | null = null;
  public isTranscribing: boolean = false; // Current transcription state

  /**
   * Creates a new AssemblyAI transcriber instance
   * @param apiKey - AssemblyAI API key for authentication
   * @param plugin
   */
  constructor(apiKey: string, plugin: Dictaphone) {
    this.apiKey = apiKey;
    this.microphone = new Microphone();
    this.plugin = plugin;
  }

  /**
   * Properly closes the transcriber
   * This should be called when the plugin is unloaded
   */
  public destroy() {
    // Stop transcription if it's running
    this.stopTranscription();
  }

  /**
   * Requests microphone access permission from the user
   * @returns Promise resolving to true if permission granted, false otherwise
   */
  public async requestPermission(): Promise<boolean> {
    try {
      await this.microphone.requestPermission();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Initiates real-time transcription using AssemblyAI's WebSocket API
   * Sets up WebSocket connection, handles messages, and manages audio streaming
   */
  public async startTranscription(editor: Editor): Promise<void> {
    if (this.isTranscribing) {
      return;
    }

    try {
      // Get temporary authentication token for WebSocket connection
      const token = await this.getStreamToken();

      // Configure word boosting for better recognition of specific phrases
      const wordBoost = encodeURIComponent(
        JSON.stringify(['new line'])
      );

      // Initialize WebSocket connection with configuration parameters
      this.websocket = new WebSocket(
        `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=${SAMPLE_RATE}&token=${token}&word_boost=${wordBoost}`
      );

      // Handle incoming WebSocket messages
      this.websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.text) {
            // Handle different types of transcripts
            if (data.message_type === 'PartialTranscript') {
              this.handlePartialTranscript(data.text);
            } else if (data.message_type === 'FinalTranscript') {
              this.handleFinalTranscript(data.text);
            }
          }
        } catch (error) {
          console.error('[Dictaphone] Error parsing message:', error);
        }
      };

      // Handle WebSocket errors
      this.websocket.onerror = (event) => {
        console.error('[Dictaphone] WebSocket error:', event);
        this.stopTranscription();
      };

      // Handle WebSocket connection closure
      this.websocket.onclose = (event) => {
        if (event.reason) {
          console.error('[Dictaphone] WebSocket close:', event);
        }
        this.stopTranscription();
      };

      // Start recording and streaming audio
      this.isTranscribing = true;
      this.activeEditor = editor;
      this.dispatchStateEffect(transcriptionStart.of());
      await this.microphone.startRecording(
        // Audio data callback
        (buffer: Uint8Array) => {
          if (
            this.isTranscribing &&
            this.websocket?.readyState === WebSocket.OPEN
          ) {
            this.websocket.send(buffer);
          }
        },
        // Handle microphone disconnection
        () => {
          playDisconnectNotification();
          this.stopTranscription();
        }
      );
    } catch (error) {
      console.error('[Dictaphone] Error starting transcription:', error);
      this.stopTranscription();
    }
  }

  private checkEditor() {
    if (!this.activeEditor || !((this.activeEditor as any).cm as EditorView).dom.isConnected) {
      this.stopTranscription(true);
      return false
    }

    return true;
  }

  /**
   * Stops the transcription process and cleans up resources
   */
  public stopTranscription(immediate: boolean = false): void {
    if (!this.isTranscribing) {
      return;
    }

    if (!immediate) {
      this.runPostProcess();
    }
    else {
      this.activeEditor = null;
    }
    this.isTranscribing = false;
    this.microphone.stopRecording();

    if (this.websocket && ![WebSocket.CLOSED, WebSocket.CLOSING].includes(this.websocket.readyState as any)) {
      // Send termination message and close WebSocket
      this.websocket.send('{"terminate_session":true}');
      this.websocket.close();
      this.websocket = null;
    }
  }

  /**
   * Handles partial (interim) transcripts by updating the editor in real-time
   * @param text - The partial transcript text
   */
  private handlePartialTranscript(text: string): void {
    if (!this.checkEditor()) {
      return;
    }
    let activeEditor = this.activeEditor!;

    // Get current cursor position
    let from = activeEditor.getCursor('from');
    let to = activeEditor.getCursor('to');

    // Replace text at cursor and update selection
    activeEditor.replaceRange(text, from, to);
    activeEditor.setSelection(from, { ...from, ch: from.ch + text.length });

    // Update transcribed line range
    if (this.transcribedLines.from === -1) {
      this.transcribedLines.from = from.line;
      this.transcribedLines.to = from.line;
    } else {
      this.transcribedLines.from = Math.min(
        this.transcribedLines.from,
        from.line
      );
      this.transcribedLines.to = Math.max(this.transcribedLines.to, from.line);
    }
  }

  /**
   * Handles final transcripts by applying transformations and updating the editor
   * @param text - The final transcript text
   */
  private handleFinalTranscript(text: string): void {
    if (!this.checkEditor()) {
      return;
    }
    let activeEditor = this.activeEditor!;

    // Apply text transformations
    for (const transform of transforms) {
      text = transform(text);
    }

    // Get current cursor position
    let from = activeEditor.getCursor('from');
    let to = activeEditor.getCursor('to');
    let insert = text;

    // Ensure proper spacing between transcribed segments
    if (!insert.endsWith('\n')) {
      insert += ' ';
    }

    let end = { ...from, ch: from.ch + insert.length };

    // Update editor content and cursor position
    activeEditor.replaceRange(insert, from, to);
    activeEditor.setCursor(end);

    from = activeEditor.getCursor('from');

    // Update transcribed line range
    if (this.transcribedLines.from === -1) {
      this.transcribedLines.from = from.line;
      this.transcribedLines.to = from.line;
    } else {
      this.transcribedLines.from = Math.min(
        this.transcribedLines.from,
        from.line
      );
      this.transcribedLines.to = Math.max(this.transcribedLines.to, from.line);
    }
  }

  /**
   * Retrieves a temporary authentication token for the AssemblyAI WebSocket API
   * @returns Promise resolving to the authentication token
   */
  private async getStreamToken(): Promise<string> {
    try {
      const headers = {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      };

      // Request temporary token with 8-minute expiration
      const response = await request({
        url: 'https://api.assemblyai.com/v2/realtime/token',
        method: 'post',
        headers: headers,
        body: JSON.stringify({ expires_in: 360000 }),
      });

      return JSON.parse(response).token;
    } catch (error) {
      console.error('[Dictaphone] Error getting stream token:', error);
      throw error;
    }
  }

  /**
   * Runs post-processing on the transcribed text after transcription stops
   * Applies formatting and cleanup to the transcribed text
   */
  private async runPostProcess(): Promise<void> {
    if (!this.checkEditor() || this.transcribedLines.from === -1) {
      // Reset transcribed lines tracking
      this.transcribedLines = { from: -1, to: -1 };
      // Signal end of transcription
      this.dispatchStateEffect(transcriptionEnd.of());
      return;
    }

    let activeEditor = this.activeEditor!;

    try {
      // Signal start of post-processing
      this.dispatchStateEffect(postprocessStart.of());

      // Get the text content of transcribed lines
      const lines: string[] = [];
      for (
        let i = this.transcribedLines.from;
        i <= this.transcribedLines.to;
        i++
      ) {
        lines.push(activeEditor.getLine(i));
      }

      // Process the transcribed text
      const text = await this.postProcessTranscript(lines.join('\n'));

      // Replace the transcribed text with processed version
      const from = {
        line: this.transcribedLines.from,
        ch: 0,
      };
      const to = {
        line: this.transcribedLines.to,
        ch: activeEditor.getLine(this.transcribedLines.to).length,
      };

      activeEditor.replaceRange(text, from, to);
    } catch (error) {
      console.error('[Dictaphone] Error in post-processing:', error);
    }

    // Reset transcribed lines tracking
    this.transcribedLines = { from: -1, to: -1 };
    // Signal end of transcription
    this.dispatchStateEffect(transcriptionEnd.of());
    this.activeEditor = null;
  }

  /**
   * Post-processes the transcribed text using AssemblyAI's LEMUR API
   * Sends the text to the LEMUR API for grammar correction and formatting
   * @param text - The raw transcribed text to process
   * @returns Promise resolving to the processed text
   */
  private async postProcessTranscript(text: string): Promise<string> {
    if (!this.plugin.settings.postProcess || !this.plugin.settings.postProcessPrompt) {
      return text;
    }

    try {
      const headers = {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      };

      // Send text to LEMUR API for processing
      const response = await request({
        url: 'https://api.assemblyai.com/lemur/v3/generate/task',
        method: 'post',
        headers: headers,
        body: JSON.stringify({
          final_model: this.plugin.settings.finalModel,
          prompt: this.plugin.settings.postProcessPrompt,
          temperature: 0,
          input_text: text,
        }),
      });

      const json = JSON.parse(response);
      if (!json.response) {
        throw new Error('No response received from LEMUR API');
      }
      return json.response;
    } catch (error) {
      console.error('[Dictaphone] Error post-processing transcript:', error);
      return text; // Return original text if post-processing fails
    }
  }

  /**
   * Dispatches a state effect to the CodeMirror editor
   * @param effect - The state effect to dispatch
   */
  private dispatchStateEffect<T>(effect: StateEffect<T>) {
    let cm: EditorView = (this.activeEditor as any)?.cm;
    if (!cm) {
      return;
    }
    cm.dispatch({ effects: effect });
  }
}
