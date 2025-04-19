import { StateEffect, EditorState, StateField, Prec } from '@codemirror/state';
import { EditorView, showTooltip, Tooltip } from '@codemirror/view';
import Dictaphone from './main';

/**
 * State effects used to control the transcription UI state:
 * - transcriptionStart: Shows recording indicator
 * - postprocessStart: Shows processing indicator
 * - transcriptionEnd: Removes all indicators
 */
export const transcriptionStart = StateEffect.define<void>();
export const postprocessStart = StateEffect.define<void>();
export const transcriptionEnd = StateEffect.define<void>();

/**
 * Enum representing the different states of dictation:
 * - Inactive: No transcription in progress
 * - Recording: Currently recording and transcribing
 * - Processing: Post-processing the transcribed text
 */
enum DictationState {
  Inactive,
  Recording,
  Processing,
}

/**
 * Base theme for the dictation indicator tooltip
 * Customizes the appearance of the indicator in the editor
 */
const cursorTooltipBaseTheme = EditorView.baseTheme({
  '.cm-tooltip.dictation-indicator': {
    border: 'none',
  },
});

/**
 * Generates tooltips for the current cursor position based on dictation state
 * Creates visual indicators that show the current transcription status
 * @param state - The current editor state
 * @param plugin - The Dictaphone plugin instance
 * @returns Array of tooltips to display
 */
function getCursorTooltips(
  state: EditorState,
  plugin: Dictaphone
): readonly Tooltip[] {
  // Don't show any indicators if dictation is inactive
  const dictationState = state.field(dictationStateField);
  if (dictationState === DictationState.Inactive) return [];

  // Determine the appropriate CSS class based on current state
  const indicatorClass =
    dictationState === DictationState.Processing ? 'processing' : 'recording';

  // Create a tooltip for each cursor position
  return state.selection.ranges.map((range) => {
    return {
      pos: range.head,
      above: true,
      strictSide: false,
      arrow: false,
      create: () => {
        const div = createDiv(`dictation-indicator ${indicatorClass}`, (el) =>
          el.createDiv('dictation-indicator-child')
        );

        // Add click handler for recording state
        if (dictationState === DictationState.Recording) {
          div.addEventListener('click', () => {
            plugin.stopTranscription();
          });
        }

        return { dom: div };
      },
    };
  });
}

/**
 * State field that tracks the current dictation state
 * Updates based on state effects and maintains the current transcription status
 */
const dictationStateField = StateField.define<DictationState>({
  // Initialize to inactive state
  create: () => DictationState.Inactive,

  // Update state based on received effects
  update(value, tr) {
    for (let effect of tr.effects) {
      if (effect.is(transcriptionStart)) return DictationState.Recording;
      if (effect.is(postprocessStart)) return DictationState.Processing;
      if (effect.is(transcriptionEnd)) return DictationState.Inactive;
    }
    return value;
  },
});

/**
 * Creates the dictation indicator extension for the editor
 * Combines state fields and theme to provide visual feedback during transcription
 * @param plugin - The Dictaphone plugin instance
 * @returns Array of extensions to be added to the editor
 */
export function dictationIndicator(plugin: Dictaphone) {
  // Create a state field for tooltips that has access to the plugin
  const cursorTooltipField = StateField.define<readonly Tooltip[]>({
    // Initialize tooltips based on current state
    create: (state) => getCursorTooltips(state, plugin),

    // Update tooltips when relevant changes occur
    update(tooltips, tr) {
      // Skip update if no relevant changes occurred
      if (
        !tr.docChanged &&
        !tr.selection &&
        !tr.effects.some(
          (effect) =>
            effect.is(transcriptionStart) ||
            effect.is(postprocessStart) ||
            effect.is(transcriptionEnd)
        )
      ) {
        return tooltips;
      }
      return getCursorTooltips(tr.state, plugin);
    },

    // Provide tooltip computation for the editor
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });

  // Add escape key handler to stop transcription
  const escapeKeyHandler = EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (
        event.key === 'Escape' &&
        view.state.field(dictationStateField) === DictationState.Recording
      ) {
        plugin.stopTranscription();
        return true; // Prevent default escape behavior
      }
      return false;
    },
  });

  return [
    dictationStateField,
    cursorTooltipField,
    cursorTooltipBaseTheme,
    Prec.highest(escapeKeyHandler),
  ];
}
