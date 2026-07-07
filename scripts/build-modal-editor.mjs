// Bundles the shared modal-editing (Vim / Emacs) editor into vendored IIFE artifacts:
//   - modal-editor.bundle.js  (+ modal-editor.bundle.css)  — the editor + Vim/Emacs
//   - modal-editor.worker.js                               — Monaco's base worker
//
// SHARED-PACKAGE build: the editor SOURCE lives in this package (src/), but the build
// runs in the CONSUMING app so it resolves that app's monaco-editor + esbuild devDeps
// and writes into that app's frontend/lib. Invoke from the consumer's project root:
//
//   node zmodal-editor/scripts/build-modal-editor.mjs
//
// Output dir defaults to <cwd>/frontend/lib; override with MODAL_EDITOR_OUT.
// Each consumer must keep esbuild + monaco-editor in devDependencies. (The Vim/Emacs
// engines are vendored into this package — no monaco-vim / monaco-emacs deps needed.)
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url)); // this package's scripts/
const src = join(here, '..', 'src');
const consumer = process.cwd();
const lib = process.env.MODAL_EDITOR_OUT || join(consumer, 'frontend', 'lib');

// DOM-only build: emit just the Monaco-free contenteditable bundle (word/ppt/cell surfaces
// that already load another Monaco — e.g. zoffice's hooks editor — can't add a second one).
const domOnly = process.env.MODAL_EDITOR_DOM_ONLY === '1';

const monacoDir = join(consumer, 'node_modules', 'monaco-editor');
if (!domOnly && !existsSync(monacoDir)) {
  throw new Error(
    `monaco-editor not found at ${monacoDir} — run pnpm install in the consumer (it must keep monaco-editor + esbuild devDeps)`,
  );
}

const resolveFix = {
  name: 'monaco-resolve-fix',
  setup(b) {
    // Bare `monaco-editor` (the vendored monaco-emacs require()s it) resolves via the
    // package's `require`/`browser` conditions to an AMD build that calls bare
    // `define(...)` and throws "define is not defined" in the WebView. Pin it to the
    // ESM edcore API — the same lean instance our entry imports, no AMD bloat.
    b.onResolve({ filter: /^monaco-editor$/ }, () => ({
      path: join(monacoDir, 'esm/vs/editor/edcore.main.js'),
    }));
    // monaco-editor's `exports` map ("./*": "./*") only resolves paths that already
    // carry a file extension. The vendored adapter imports deep monaco subpaths
    // without `.js`, so append it and resolve to the package dir directly.
    b.onResolve({ filter: /^monaco-editor\/esm\// }, (args) => {
      let p = args.path;
      if (!/\.(js|mjs|css|ttf)$/.test(p)) p += '.js';
      return { path: join(monacoDir, p.slice('monaco-editor/'.length)) };
    });
  },
};

const common = {
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.ttf': 'dataurl' },
};

// The Vim engine hard-imports `../../adapters/monaco_adapter`. For the DOM build we alias
// that import to the contenteditable adapter so the vendored 7k-line engine is reused
// unchanged AND the bundle never pulls in monaco.
const domAlias = {
  name: 'vim-dom-adapter-alias',
  setup(b) {
    b.onResolve({ filter: /adapters\/monaco_adapter$/ }, () => ({
      path: join(src, 'adapters', 'dom_adapter.ts'),
    }));
  },
};

if (!domOnly) {
  // Main (Monaco) editor bundle — modal-editor.bundle.js + .css. Bundles its own Monaco.
  await build({
    ...common,
    plugins: [resolveFix],
    entryPoints: [join(src, 'index.ts')],
    outfile: join(lib, 'modal-editor.bundle.js'),
    globalName: 'ZModal',
  });
  // Monaco base web worker.
  await build({
    ...common,
    plugins: [resolveFix],
    entryPoints: [join(src, 'worker-entry.ts')],
    outfile: join(lib, 'modal-editor.worker.js'),
  });
  console.log(`Wrote ${lib}/modal-editor.bundle.{js,css} + modal-editor.worker.js`);
}

// DOM (contenteditable) bundle — modal-editor-dom.bundle.js. NO monaco: the vim engine
// drives the app's WYSIWYG pages directly. globalName also `ZModal` (a consumer loads one
// or the other, never both).
await build({
  ...common,
  plugins: [domAlias],
  entryPoints: [join(src, 'index-dom.ts')],
  outfile: join(lib, 'modal-editor-dom.bundle.js'),
  globalName: 'ZModal',
});
console.log(`Wrote ${lib}/modal-editor-dom.bundle.js`);
