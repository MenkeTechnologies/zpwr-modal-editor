// Entry for Monaco's base editor web worker, bundled to
// frontend/lib/modal-editor.worker.js by scripts/build-modal-editor.mjs.
// The modal editor only uses the base editor worker (basic edits, links, diff) —
// no language workers — so importing this self-installs the worker handler.
import 'monaco-editor/esm/vs/editor/editor.worker.js';
