# zpwr-modal-editor

Shared **modal-editing (Vim / Emacs)** editor for the MenkeTechnologies GUI apps.

The Vim engine (`src/engine/vim/keymap_vim.ts`) and Emacs engine (`src/engine/emacs/*`)
are **vendored from `monaco-vim` 0.4.4 / `monaco-emacs` 0.3.0** and adapted so we own
them outright — no external runtime deps (the two `lodash` helpers monaco-emacs used are
replaced by `src/engine/emacs/localutil.ts`). Upstream licenses are kept next to the
vendored code (`engine/vim/LICENSE.codemirror.txt`, `engine/emacs/LICENSE`).

## Architecture — why it can drop in "anywhere"

The Vim engine talks **only** to a surface *adapter* that implements the CodeMirror API
it expects:

```
engine/vim/keymap_vim.ts  ──imports──▶  adapters/monaco_adapter.ts   (drives a Monaco editor)
```

Swap the adapter and the same engine drives a different surface. Today one adapter ships
(`monaco_adapter`, over a Monaco editor). A **DOM / contenteditable adapter** implementing
the same API would let the engine drive a raw page surface (e.g. a WYSIWYG page or a text
box) with no Monaco — that is the next milestone. Emacs (`engine/emacs`) is currently
coupled to the Monaco editor API and rides the Monaco adapter only.

## ⚠️ One Monaco per page

The default build **bundles its own Monaco**. If the host app ALSO loads another Monaco
bundle on the same page (e.g. `zpwr-hooks-editor`), a WebKit/WKWebView WebView can crash
its content process on the second full Monaco → **blank window** (Chromium tolerates two;
WebKit does not). Two integration options:

1. **Share one Monaco.** Have the app expose its existing Monaco editor and call
   `attachVim(editor)` / `attachEmacs(editor)` — these need no bundled editor of their own.
   (A `monaco-editor`-external build variant is the clean way to ship this; TODO.)
2. **Be the only Monaco.** Use `create(...)` (bundles Monaco) only in apps that don't
   already load one.

## API (`window.ZModal`)

Built by `scripts/build-modal-editor.mjs` (esbuild, IIFE, `globalName: ZModal`) into the
consumer's `frontend/lib/modal-editor.bundle.{js,css}` + `modal-editor.worker.js`.

```js
// Convenience mount — creates a Monaco editor + applies the mode (bundles Monaco):
const h = window.ZModal.create(hostEl, {
  doc: "text",
  mode: "vim",          // 'default' | 'vim' | 'emacs'
  statusBar: statusEl,  // optional — vim mode / key-buffer / ex line render here
  language: "plaintext",
  onChange: (text) => {},
});
h.getValue(); h.setValue("…"); h.setMode("emacs"); h.focus(); h.layout(); h.destroy();

// Monaco-agnostic — attach a mode to an editor the host already created (no 2nd Monaco):
window.ZModal.attachVim(existingMonacoEditor, statusEl);
window.ZModal.attachEmacs(existingMonacoEditor);
```

## Build (consumed as a submodule)

The source lives here; the build runs in the **consuming app's** root so it resolves that
app's `monaco-editor` + `esbuild` devDeps and writes into the app's `frontend/lib`:

```
node <path-to-submodule>/scripts/build-modal-editor.mjs
# output dir defaults to <cwd>/frontend/lib; override with MODAL_EDITOR_OUT
```

Each consumer keeps `esbuild` + `monaco-editor` in devDependencies. (The Vim/Emacs engines
are vendored here — no `monaco-vim` / `monaco-emacs` deps needed.)
