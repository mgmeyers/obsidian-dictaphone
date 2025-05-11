import { App, Editor, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { dictationIndicator } from './editorPlugin';
import { AssemblyAITranscriber } from './AssemblyAITranscriber';

interface DictaphoneSettings {
  assemblyApiKey: string;
  postProcess: boolean;
  postProcessPrompt: string;
  finalModel: string;
}

const DEFAULT_SETTINGS: DictaphoneSettings = {
  assemblyApiKey: '',
  postProcess: true,
  postProcessPrompt: "The input text is a transcript of a voice dictation. Correct grammar, punctuation, sentence structure, and spelling mistakes but do not change any of the words used. Your response should include the updated text and nothing else. It should not include any introductory or helper text, nor any formatting. It should never start with 'Here is'.",
  finalModel: 'anthropic/claude-3-7-sonnet-20250219',
};

export default class Dictaphone extends Plugin {
  settings: DictaphoneSettings;
  transcriber: AssemblyAITranscriber | null;

  get isTranscribing() {
    return !!this.transcriber?.isTranscribing;
  }

  startTranscription(editor: Editor) {
    this.transcriber?.startTranscription(editor);
  }

  stopTranscription(immediate: boolean = false) {
    this.transcriber?.stopTranscription(immediate);
  }

  async onload() {
    await this.loadSettings();

    this.createTranscriber();
    this.registerEditorExtension(dictationIndicator(this));

    this.addCommand({
      id: 'transcribe-audio',
      name: 'Start/Stop Transcription',
      editorCallback: (editor) => {
        if (this.isTranscribing) {
          this.stopTranscription();
        } else {
          this.startTranscription(editor);
        }
      },
    });

    this.addSettingTab(new DictaphoneSettingTab(this.app, this));
  }

  onunload() {
    this.transcriber?.destroy();
    this.transcriber = null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Create the appropriate transcriber based on settings
   */
  public createTranscriber(silent: boolean = false) {
    // Clean up existing transcriber if any
    if (this.transcriber) {
      this.transcriber.destroy();
      this.transcriber = null;
    }

    // Create new transcriber based on selected service
    const apiKey = this.settings.assemblyApiKey;

    if (!apiKey) {
      if (!silent) {
        new Notice(
          'Please set an API key for the selected transcription service'
        );
      }
      return;
    }

    try {
      this.transcriber = new AssemblyAITranscriber(apiKey, this);
    } catch (error) {
      console.error('[Dictaphone] Error creating transcriber:', error);
      if (!silent) {
        new Notice('Error creating transcriber: ' + (error as Error).message);
      }
    }
  }
}

class DictaphoneSettingTab extends PluginSettingTab {
  plugin: Dictaphone;

  constructor(app: App, plugin: Dictaphone) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('Check microphone permissions')
      .addButton((button) =>
        button.setButtonText('Check').onClick(async () => {
          const permission = await this.plugin.transcriber?.requestPermission();
          new Notice(permission ? 'Permission granted' : 'Permission denied');
        })
      );

    new Setting(containerEl)
      .setName('AssemblyAI API Key')
      .setDesc('Enter your AssemblyAI API key')
      .addText((text) =>
        text
          .setPlaceholder('Enter your AssemblyAI API key')
          .setValue(this.plugin.settings.assemblyApiKey)
          .onChange(async (value) => {
            this.plugin.settings.assemblyApiKey = value;
            await this.plugin.saveSettings();
            this.plugin.createTranscriber();
          })
      );

    new Setting(containerEl)
      .setName('Post-process transcription')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.postProcess)
          .onChange(async (value) => {
            this.plugin.settings.postProcess = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Post-process prompt')
      .setDesc('Prompt used for post-processing dictation transcript')
      .addTextArea((text) => {
        text
          .setPlaceholder('Enter a post-processing prompt')
          .setValue(this.plugin.settings.postProcessPrompt)
          .onChange(async (value) => {
            this.plugin.settings.postProcessPrompt = value;
            await this.plugin.saveSettings();
          })

        text.inputEl.style.width = "100%";
        text.inputEl.rows = 8;
      });

    let desc = createFragment(el => {
      el.createEl('a', { text: 'Click here for available models', href: 'https://www.assemblyai.com/docs/lemur/customize-parameters' })
    })

    new Setting(containerEl)
      .setName('Post-processing model')
      .setDesc(desc)
      .addText((text) =>
        text
          .setPlaceholder('Enter the model name')
          .setValue(this.plugin.settings.finalModel)
          .onChange(async (value) => {
            this.plugin.settings.finalModel = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
