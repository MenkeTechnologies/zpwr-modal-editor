// zmodal-editor — DOM entry (NO monaco). Bundles the vendored Vim engine over the
// contenteditable adapter (adapters/dom_adapter, aliased in over monaco_adapter by the DOM
// build) plus the shared status bar. esbuild exposes the exports as `window.ZModal`, same
// facade shape as the Monaco build minus everything Monaco.
//
// This is the bundle word/ppt/spreadsheet surfaces load: it drives the app's existing
// contenteditable pages directly, so vim keys work in the real WYSIWYG document without a
// second Monaco (which would crash WKWebView alongside the hooks editor's Monaco).
import VimMode from "./engine/vim/keymap_vim"; // → DomAdapter under the DOM build alias
import StatusBar from "./statusbar";
import { Completion, CompletionConfig } from "./completion";

/**
 * Attach Vim modal editing to a contenteditable element. If `statusbarNode` is given, the
 * mode / key-buffer / ex command-line render there. Returns the adapter — call
 * `.dispose()` to detach.
 */
export function attachVim(host: HTMLElement, statusbarNode: HTMLElement | null = null) {
  const vimAdapter = new (VimMode as any)(host);
  if (!statusbarNode) {
    vimAdapter.attach();
    return vimAdapter;
  }
  const statusBar = new StatusBar(statusbarNode, vimAdapter as any);
  let keyBuffer = "";
  vimAdapter.on("vim-mode-change", (mode: any) => statusBar.setMode(mode));
  vimAdapter.on("vim-keypress", (key: string) => {
    keyBuffer = key === ":" ? "" : keyBuffer + key;
    statusBar.setKeyBuffer(keyBuffer);
  });
  vimAdapter.on("vim-command-done", () => { keyBuffer = ""; statusBar.setKeyBuffer(""); });
  vimAdapter.on("dispose", () => {
    statusBar.toggleVisibility(false);
    statusBar.closeInput();
    statusBar.clear();
  });
  statusBar.toggleVisibility(true);
  vimAdapter.setStatusBar(statusBar);
  vimAdapter.attach();
  return vimAdapter;
}

export interface DomAttachOptions {
  mode?: "default" | "vim";
  statusBar?: HTMLElement | null;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  /**
   * Insert-mode completion for this field. Alternatively set `host.zmodalCompletion` on the element
   * (read at query time) — useful when the element is attached by a generic manager that doesn't know
   * the field's candidate list. See {@link CompletionConfig}.
   */
  completion?: CompletionConfig;
}

export interface DomModalHandle {
  adapter: any;
  host: HTMLElement;
  getValue(): string;
  focus(): void;
  setMode(mode: "default" | "vim"): void;
  isVim(): boolean;
  destroy(): void;
}

/**
 * Attach modal editing to an existing contenteditable `host` (the drop-in mount for
 * word/ppt/cell surfaces). `setMode('vim')` engages the engine live; `setMode('default')`
 * detaches it and hands typing back to the browser. Returns a small handle.
 */
export function attach(host: HTMLElement, opts: DomAttachOptions = {}): DomModalHandle {
  if (opts.readOnly) host.setAttribute("contenteditable", "false");
  else if (host.getAttribute("contenteditable") == null) host.setAttribute("contenteditable", "true");

  let adapter: any = null;
  const engage = () => {
    if (adapter) return;
    adapter = attachVim(host, opts.statusBar || null);
    if (typeof opts.onChange === "function") adapter.options.onChange = opts.onChange;
  };
  const disengage = () => {
    if (!adapter) return;
    try { adapter.dispose(); } catch (_) {}
    adapter = null;
    if (opts.statusBar) opts.statusBar.textContent = "";
  };
  if ((opts.mode || "vim") === "vim") engage();

  // Insert-mode completion popup. Reads opts.completion or host.zmodalCompletion; a no-op when neither
  // is set, so a plain field behaves exactly as before (Tab flows to Vim).
  const completion = new Completion(host, () => adapter, opts.completion || null);

  return {
    get adapter() { return adapter; },
    host,
    getValue: () => (adapter ? adapter._fullText() : host.innerText),
    focus: () => host.focus(),
    setMode: (m) => (m === "vim" ? engage() : disengage()),
    isVim: () => !!adapter,
    destroy: () => { try { completion.dispose(); } catch (_) {} disengage(); },
  };
}

export { VimMode, StatusBar };
