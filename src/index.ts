// zmodal-editor — shared modal-editing (Vim / Emacs) editor for the MenkeTechnologies
// GUI apps. The Vim engine (engine/vim/keymap_vim.ts) and Emacs engine
// (engine/emacs/*) are vendored from monaco-vim / monaco-emacs and adapted so we own
// them outright (no external runtime deps).
//
// The Vim engine talks only to a surface *adapter* (engine/vim → adapters/monaco_adapter),
// which implements the CodeMirror API the engine expects. Today the adapter drives a
// Monaco editor; a DOM/contenteditable adapter can implement the same API to drive the
// word/ppt page surfaces directly.
//
// This module is the IIFE entry: esbuild bundles it under globalName `ZModal`, so apps
// call `window.ZModal.create(host, { mode: 'vim' })` etc. — the same shape as the Hooks
// editor's editor handle, minus the stryke language/LSP coupling.
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js';
import VimMode from './engine/vim/keymap_vim';
import { EmacsExtension } from './engine/emacs';
import StatusBar from './statusbar';

// Monaco needs a worker factory. Resolve it relative to the document base so it works
// under both a web root and Tauri's custom protocol (CSP worker-src 'self').
(self as any).MonacoEnvironment = {
  getWorker() {
    return new Worker(new URL('lib/modal-editor.worker.js', document.baseURI));
  },
};

export type ModalMode = 'default' | 'vim' | 'emacs';
type AnyEditor = monaco.editor.IStandaloneCodeEditor;

const THEME = 'zmodal-cyberpunk';
monaco.editor.defineTheme(THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '4a6a7a', fontStyle: 'italic' },
    { token: 'string', foreground: '00e5ff' },
    { token: 'keyword', foreground: 'ff2e97' },
    { token: 'number', foreground: 'f5a623' },
  ],
  colors: {
    'editor.background': '#0a0e14',
    'editor.foreground': '#c8d4e0',
    'editorLineNumber.foreground': '#2a3a4a',
    'editorLineNumber.activeForeground': '#00e5ff',
    'editorCursor.foreground': '#00e5ff',
  },
});

/**
 * Attach Vim modal editing to a Monaco editor. If `statusbarNode` is given, mode /
 * key-buffer / command-line render there. Returns the vim adapter (call `.dispose()`
 * to detach). Ported verbatim from monaco-vim's initVimMode.
 */
export function attachVim(editor: AnyEditor, statusbarNode: HTMLElement | null = null) {
  const vimAdapter = new (VimMode as any)(editor);
  if (!statusbarNode) {
    vimAdapter.attach();
    return vimAdapter;
  }
  const statusBar = new StatusBar(statusbarNode, editor);
  let keyBuffer = '';
  vimAdapter.on('vim-mode-change', (mode: any) => statusBar.setMode(mode));
  vimAdapter.on('vim-keypress', (key: string) => {
    keyBuffer = key === ':' ? '' : keyBuffer + key;
    statusBar.setKeyBuffer(keyBuffer);
  });
  vimAdapter.on('vim-command-done', () => { keyBuffer = ''; statusBar.setKeyBuffer(''); });
  vimAdapter.on('dispose', () => { statusBar.toggleVisibility(false); statusBar.closeInput(); statusBar.clear(); });
  statusBar.toggleVisibility(true);
  vimAdapter.setStatusBar(statusBar);
  vimAdapter.attach();
  return vimAdapter;
}

/** Attach Emacs keybindings to a Monaco editor. Returns the started extension. */
export function attachEmacs(editor: AnyEditor) {
  const ext = new EmacsExtension(editor);
  ext.start();
  return ext;
}

export interface CreateOptions {
  doc?: string;
  mode?: ModalMode;
  language?: string;
  statusBar?: HTMLElement | null;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  minimap?: boolean;
  wordWrap?: boolean;
}

export interface ModalEditorHandle {
  editor: AnyEditor;
  getValue(): string;
  setValue(text: string): void;
  focus(): void;
  setMode(mode: ModalMode): void;
  layout(): void;
  destroy(): void;
}

/**
 * Create a Monaco-backed modal editor in `host` — the "drop it anywhere" mount used by
 * word/ppt/etc. Returns a small handle; `setMode('vim'|'emacs'|'default')` swaps the
 * active modal layer live.
 */
export function create(host: HTMLElement, opts: CreateOptions = {}): ModalEditorHandle {
  const model = monaco.editor.createModel(opts.doc || '', opts.language || 'plaintext');
  const editor = monaco.editor.create(host, {
    model,
    theme: THEME,
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: opts.minimap ?? false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    readOnly: !!opts.readOnly,
    wordWrap: opts.wordWrap ? 'on' : 'off',
  });

  const changeSub = model.onDidChangeContent(() => {
    if (typeof opts.onChange === 'function') opts.onChange(model.getValue());
  });

  let modal: any = null;
  const applyMode = (m: ModalMode) => {
    if (modal) { try { modal.dispose(); } catch (_) {} modal = null; if (opts.statusBar) opts.statusBar.textContent = ''; }
    if (m === 'vim') modal = attachVim(editor, opts.statusBar || null);
    else if (m === 'emacs') modal = attachEmacs(editor);
  };
  applyMode(opts.mode || 'default');

  return {
    editor,
    getValue: () => model.getValue(),
    setValue: (text: string) => model.setValue(text == null ? '' : text),
    focus: () => editor.focus(),
    setMode: (m: ModalMode) => applyMode(m),
    layout: () => editor.layout(),
    destroy: () => {
      if (modal) { try { modal.dispose(); } catch (_) {} }
      changeSub.dispose();
      editor.dispose();
      model.dispose();
    },
  };
}

export { VimMode, EmacsExtension, StatusBar };
