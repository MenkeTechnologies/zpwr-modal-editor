// @ts-nocheck
/**
 * dom_adapter — a CodeMirror-API adapter over a plain **contenteditable** element, so the
 * vendored Vim engine (engine/vim/keymap_vim.ts) can drive a raw page surface (a WYSIWYG
 * word-processor page, a slide text box, a spreadsheet cell) with **no Monaco at all**.
 *
 * It is a drop-in replacement for adapters/monaco_adapter: it exports the same default
 * (a class carrying the same `CodeMirror.*` statics the engine reads, plus the instance
 * `cm.*` methods the engine calls). The DOM build aliases the engine's
 * `../../adapters/monaco_adapter` import to this file, so the 7k-line engine is reused
 * byte-for-byte while the bundle stays Monaco-free (two full Monacos crash WKWebView, and
 * zoffice already loads one for its hooks editor).
 *
 * Document model — the host's block-level descendants are "lines"; inline nodes (span / a
 * / img) are transparent text; a <br> is a hard line break. Columns are character offsets
 * into a line's concatenated text. We rebuild this index lazily (on demand after any edit
 * or external input) by walking the DOM, and map (line, ch) <-> DOM (node, offset) through
 * it. Intra-line edits go through execCommand so they preserve surrounding inline
 * formatting and ride the browser's native undo; multi-line/structural edits rebuild the
 * affected block containers as plain paragraphs (formatting on the edited lines is lost —
 * a documented limitation of driving rich text with a line-based engine).
 */
import {
  isWordChar,
  Pos,
  signal,
  dummy,
  matchingBrackets,
  e_stop,
  e_preventDefault,
  lookupKey as coreLookupKey,
  makeKeyMap,
  Marker,
  StringStream,
} from "./cm_core";

// Block-level tags: each starts a new line; a run of inline content between them is one
// line. <br> is handled separately as an in-block hard break.
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIV", "DL", "DD",
  "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
  "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
  "PRE", "SECTION", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "UL",
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Convert a real DOM KeyboardEvent to the key string the Vim engine's keymap expects.
 *  Mirrors monaco_adapter's monacoToCmKey contract: a bare printable char comes through
 *  quoted ('a'), specials use vim names (Left/CR/Esc/…), modified keys are prefixed
 *  (Ctrl-f, Shift-Left). */
function toDomKey(e) {
  const k = e.key;
  if (k == null) return "";
  // Modifier-only presses map to their own name so the engine ignores them.
  if (k === "Shift" || k === "Alt" || k === "Meta" || k === "CapsLock" || k === "AltGraph")
    return k;
  if (k === "Control") return "Ctrl";

  const alt = e.altKey, ctrl = e.ctrlKey, meta = e.metaKey, shift = e.shiftKey;
  const SPECIAL = {
    ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
    Escape: "Esc", Enter: "Enter", Backspace: "Backspace", Delete: "Delete",
    Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp",
    PageDown: "PageDown", Tab: "Tab", " ": "Space",
  };
  const isPrintable = k.length === 1;

  // Unmodified (or shift-only) printable char → quoted literal, e.g. 'A' or '!'. The
  // engine's cmKeyToVimKey unwraps 'x' back to the character. Space is printable too and
  // becomes ' ' which vim maps to <Space>.
  if (isPrintable && !alt && !ctrl && !meta) {
    return "'" + k + "'";
  }

  // Otherwise build a modifier-prefixed name. Lowercase single letters so Ctrl-F and
  // Ctrl-f both bind to "Ctrl-f" (matching the Monaco path); keep symbols/space verbatim.
  let name = SPECIAL[k] || k;
  if (isPrintable && /^[a-zA-Z]$/.test(k)) name = k.toLowerCase();

  let key = name;
  if (alt) key = "Alt-" + key;
  if (ctrl) key = "Ctrl-" + key;
  if (meta) key = "Meta-" + key;
  if (shift) key = "Shift-" + key;
  return key;
}

// Per-line inline-HTML cache, keyed by the line's plain text, captured when a range is read
// (yank / delete). A later linewise paste that reinserts that text rebuilds the line from its
// original HTML — so `yy` + `p` (and `dd` + `p`) preserve font / colour / size instead of
// dropping to plain text. Bounded FIFO so it can't grow without limit.
const richLines = new Map(); // text -> { html, className }
const RICH_MAX = 256;
function rememberRichLine(text, container) {
  if (!text || !container) return;
  richLines.set(text, { html: container.innerHTML, className: container.className || "zo-p" });
  if (richLines.size > RICH_MAX) richLines.delete(richLines.keys().next().value);
}
/** Cache HTML for every line fully covered by [a,b] whose container maps to exactly one line. */
function cacheRichLines(lines, a, b) {
  if (b.line - a.line > 200) return; // guard: don't walk huge yanks
  const counts = new Map();
  for (const l of lines) counts.set(l.container, (counts.get(l.container) || 0) + 1);
  const lastLen = lines[b.line] ? lines[b.line].text.length : 0;
  for (let i = a.line; i <= b.line; i++) {
    const L = lines[i];
    if (!L || !L.container) continue;
    const fullFirst = i > a.line || a.ch === 0;
    const fullLast = i < b.line || b.ch === lastLen;
    if (fullFirst && fullLast && counts.get(L.container) === 1) rememberRichLine(L.text, L.container);
  }
}

/** Build a fresh line container (<p>) holding `text`. When `text` matches a line captured at
 *  yank time, rebuild it from that line's original HTML so paste keeps its formatting; otherwise
 *  a plain line (or a <br> when empty so it stays visible/editable, matching buildParagraph). */
function buildLineEl(text) {
  const rich = text ? richLines.get(text) : null;
  const p = document.createElement("p");
  p.className = (rich && rich.className) || "zo-p";
  if (rich) p.innerHTML = rich.html;
  else if (text) p.textContent = text;
  else p.appendChild(document.createElement("br"));
  return p;
}

function sortPos(a, b) {
  if (a.line < b.line || (a.line === b.line && a.ch <= b.ch)) return [a, b];
  return [b, a];
}

class DomAdapter {
  static Pos = Pos;
  static signal = signal;
  static on = dummy("on");
  static off = dummy("off");
  static addClass = dummy("addClass");
  static rmClass = dummy("rmClass");
  static defineOption = dummy("defineOption");
  static keyMap = makeKeyMap();
  static matchingBrackets = matchingBrackets;
  static isWordChar = isWordChar;
  static keyName = toDomKey;
  static StringStream = StringStream;
  static e_stop = e_stop;
  static e_preventDefault = e_preventDefault;
  // Sentinel the engine compares option defaults against (see defineOption usage).
  static Init = { toString: () => "CodeMirror.Init" };

  static commands = {
    redo: (cm) => cm.redo(),
    undo: (cm) => cm.undo(),
    newlineAndIndent: (cm) => cm.newlineAndIndent(),
  };

  static lookupKey = function lookupKey(key, map, handle) {
    return coreLookupKey(key, map, handle, DomAdapter.keyMap);
  };

  static defineExtension = function (name, fn) {
    DomAdapter.prototype[name] = fn;
  };

  // Tag text-objects (it/at) — the engine calls these if present; a no-op keeps them from
  // throwing (matching the Monaco path, which also ships without real tag matching).
  static findMatchingTag = function () { return undefined; };
  static findEnclosingTag = function () { return undefined; };

  constructor(host) {
    this.host = host;
    this.editor = host; // statusbar/focus compatibility (host.focus() exists)
    this.state = { keyMap: "vim" };
    this.marks = {};
    this.$uid = 0;
    this.listeners = {};
    this.curOp = {};
    this.attached = false;
    this.statusBar = null;
    this.options = {};
    this.replaceMode = false;
    this.replaceStack = [];

    this._index = null;      // cached line index; null = dirty
    this._lastText = "";     // last full text, for change diffing / insert coalescing
    this._undoStack = [];
    this._redoStack = [];
    this._insertSnap = false; // whether we've snapshotted this insert session
    this._cursorEl = null;    // block-cursor overlay

    // A tiny context key standing in for Monaco's createContextKey — true = insert mode.
    let insert = true;
    this.ctxInsert = {
      get: () => insert,
      set: (v) => { insert = v; this._renderCursor(); },
    };

    this._onInput = this._onInput.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onSelChange = this._onSelChange.bind(this);
    this._onScroll = this._onScroll.bind(this);

    // Hide the block cursor when the host loses focus (and so also when the host is removed from the
    // DOM — e.g. a modal editor closes — which fires blur). Otherwise the fixed-position cursor
    // overlay lingers, floating over the rest of the app. Re-render (show) on focus.
    (this as any)._onBlur = () => { if (this._cursorEl) (this._cursorEl as HTMLElement).style.display = "none"; };
    (this as any)._onFocus = () => { try { this._renderCursor(); } catch (_) { /* */ } };
    host.addEventListener("keydown", this._onKeyDown, true);
    host.addEventListener("input", this._onInput);
    host.addEventListener("blur", (this as any)._onBlur);
    host.addEventListener("focus", (this as any)._onFocus);
    document.addEventListener("selectionchange", this._onSelChange);
    window.addEventListener("scroll", this._onScroll, true);
  }

  // ---- lifecycle -----------------------------------------------------------
  attach() {
    DomAdapter.keyMap.vim.attach(this);
    this.attached = true;
    this._lastText = this._fullText();
  }

  dispose() {
    this.dispatch("dispose");
    if (DomAdapter.keyMap.vim) DomAdapter.keyMap.vim.detach(this);
    this.host.removeEventListener("keydown", this._onKeyDown, true);
    this.host.removeEventListener("input", this._onInput);
    this.host.removeEventListener("blur", (this as any)._onBlur);
    this.host.removeEventListener("focus", (this as any)._onFocus);
    document.removeEventListener("selectionchange", this._onSelChange);
    window.removeEventListener("scroll", this._onScroll, true);
    this.host.classList.remove("zmodal-normal", "zmodal-visual");
    if (this._cursorEl && this._cursorEl.parentNode) {
      this._cursorEl.parentNode.removeChild(this._cursorEl);
    }
    this.attached = false;
  }

  // ---- events --------------------------------------------------------------
  _onKeyDown(e) {
    if (!this.attached) return;
    if (this.replaceMode) this._handleReplaceMode(e);
    const key = toDomKey(e);
    if (!key) return;

    const keymap = this.state.keyMap;
    const km = DomAdapter.keyMap[keymap];
    let cmd;
    if (km && typeof km.call === "function") {
      try { cmd = km.call(key, this); } catch (err) { console.error(err); }
    }
    if (cmd) {
      e.preventDefault();
      e.stopPropagation();
      // NB: don't snapshot here — the edit primitives (replaceRange/replaceSelections)
      // snapshot themselves, and snapshotting on every command would corrupt the undo
      // stack for undo/redo commands (they'd push the post-edit state before popping).
      try { cmd(); } catch (err) { console.error(err); }
      this._renderCursor();
      return;
    }
    // Normal/visual mode: swallow stray printable keys so command keys never leak into
    // the page as text. Let browser shortcuts (Cmd/Ctrl/Alt) through.
    if (!this.ctxInsert.get() && !e.metaKey && !e.ctrlKey && !e.altKey && key.charAt(0) === "'") {
      e.preventDefault();
    }
  }

  _onInput() {
    // Native typing in insert mode (and browser undo) lands here. Snapshot once per insert
    // session so a whole insert reverts as one unit, then invalidate the index.
    if (this.ctxInsert.get() && !this._insertSnap) {
      this._beginChange();
      this._insertSnap = true;
    }
    this._index = null;
    const text = this._fullText();
    const change = { text: [text], origin: "+input" };
    this.dispatch("change", this, change);
    this._lastText = text;
    if (typeof this.options.onChange === "function") this.options.onChange(text);
  }

  _onSelChange() {
    if (!this.attached) return;
    const sel = window.getSelection();
    if (!sel || !sel.focusNode || !this.host.contains(sel.focusNode)) return;
    this.dispatch("cursorActivity", this);
    this._renderCursor();
  }

  _onScroll() {
    if (this.attached) this._renderCursor();
  }

  // ---- line index ----------------------------------------------------------
  index() {
    if (this._index) return this._index;
    const lines = [];
    const nodeMap = new Map(); // text node -> { line, start }
    let cur = null;

    const ensure = (container) => {
      if (!cur) cur = { text: "", segs: [], container };
      else if (!cur.container) cur.container = container;
    };
    const end = () => {
      if (cur) { lines.push(cur); cur = null; }
    };

    const walk = (node, block) => {
      // Whitespace-only text nodes BETWEEN block-level children are insignificant
      // formatting whitespace (as the browser renders them) — ignore them so a page whose
      // paragraphs are separated by newlines/indentation doesn't grow phantom blank lines.
      let hasBlockChild = false;
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = node.childNodes[i];
        if (c.nodeType === ELEMENT_NODE && (BLOCK_TAGS.has(c.tagName) || c.tagName === "BR")) {
          hasBlockChild = true;
          break;
        }
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === TEXT_NODE) {
          const data = child.data;
          if (!data) continue;
          if (hasBlockChild && /^\s*$/.test(data)) continue;
          ensure(block);
          const start = cur.text.length;
          cur.segs.push({ node: child, start, len: data.length });
          cur.text += data;
          nodeMap.set(child, { line: lines.length, start });
        } else if (child.nodeType === ELEMENT_NODE) {
          const tag = child.tagName;
          if (tag === "BR") {
            ensure(block);
            // BR at the end of its block is a trailing placeholder, not a real extra line.
            const isPlaceholder = i === node.childNodes.length - 1 && cur.text.length === 0;
            end();
            if (isPlaceholder) { /* the just-ended empty line represents this block */ }
            continue;
          }
          if (BLOCK_TAGS.has(tag)) {
            end();
            const before = lines.length;
            walk(child, child);
            end();
            if (lines.length === before) {
              // wholly empty block → one empty line anchored to it
              lines.push({ text: "", segs: [], container: child });
            }
          } else {
            // inline (span/a/img/…): transparent, keep the current line
            walk(child, block);
          }
        }
      }
    };

    walk(this.host, this.host);
    end();
    if (lines.length === 0) lines.push({ text: "", segs: [], container: this.host });
    // nodeMap lines were recorded as lines.length at push time — but we push AFTER walking
    // children, so recompute the map against final indices.
    const fixMap = new Map();
    for (let li = 0; li < lines.length; li++) {
      for (const seg of lines[li].segs) fixMap.set(seg.node, { line: li, start: seg.start });
    }
    this._index = { lines, nodeMap: fixMap };
    return this._index;
  }

  _fullText() {
    return this.index().lines.map((l) => l.text).join("\n");
  }

  // (line, ch) -> { node, offset } in the DOM
  _posToDOM(pos) {
    const { lines } = this.index();
    let li = Math.max(0, Math.min(pos.line, lines.length - 1));
    const line = lines[li];
    let ch = Math.max(0, Math.min(pos.ch, line.text.length));
    if (!line.segs.length) {
      // empty line: caret at the start of the container (before its <br>, if any)
      return { node: line.container || this.host, offset: 0 };
    }
    for (const seg of line.segs) {
      if (ch <= seg.start + seg.len) {
        return { node: seg.node, offset: Math.max(0, ch - seg.start) };
      }
    }
    const last = line.segs[line.segs.length - 1];
    return { node: last.node, offset: last.len };
  }

  // DOM (node, offset) -> (line, ch)
  _domToPos(node, offset) {
    const { lines, nodeMap } = this.index();
    if (!node) return new Pos(0, 0);
    if (node.nodeType === TEXT_NODE) {
      const hit = nodeMap.get(node);
      if (hit) return new Pos(hit.line, hit.start + offset);
    }
    // Element: locate a line whose container matches, or descend to a child text node.
    if (node.nodeType === ELEMENT_NODE) {
      // try the child at `offset` (a collapsed caret between children)
      const kids = node.childNodes;
      const probe = offset < kids.length ? kids[offset] : kids[kids.length - 1];
      if (probe) {
        // leftmost text node under probe
        let t = probe;
        while (t && t.nodeType === ELEMENT_NODE && t.firstChild) t = t.firstChild;
        if (t && t.nodeType === TEXT_NODE && nodeMap.has(t)) {
          const hit = nodeMap.get(t);
          const atEnd = offset >= kids.length;
          return new Pos(hit.line, atEnd ? hit.start + t.data.length : hit.start);
        }
      }
      // fall back to a line whose container is this element
      for (let li = 0; li < lines.length; li++) {
        if (lines[li].container === node) return new Pos(li, offset > 0 ? lines[li].text.length : 0);
      }
    }
    return new Pos(0, 0);
  }

  _selection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.focusNode || !this.host.contains(sel.focusNode)) {
      return null;
    }
    return sel;
  }

  // ---- reads the engine calls ---------------------------------------------
  getCursor(type = null) {
    const sel = this._selection();
    if (!sel) return new Pos(0, 0);
    const head = this._domToPos(sel.focusNode, sel.focusOffset);
    if (!type || type === "head") return this.clipPos(head);
    const anchor = this._domToPos(sel.anchorNode, sel.anchorOffset);
    return this.clipPos(anchor);
  }

  getLine(line) {
    const { lines } = this.index();
    if (line < 0 || line >= lines.length) return "";
    return lines[line].text;
  }

  lineCount() { return this.index().lines.length; }
  firstLine() { return 0; }
  lastLine() { return this.lineCount() - 1; }
  defaultTextHeight() { return 1; }

  clipPos(p) {
    const { lines } = this.index();
    const last = lines.length - 1;
    // A position past the last line means "end of document" (vim addresses one line past
    // the end for linewise ops like `dd` on the final line) — clamp to the end of the last
    // line, NOT to column 0 of it, or the delete swallows the wrong line.
    if (p.line > last) return new Pos(last, lines[last].text.length);
    if (p.line < 0) return new Pos(0, 0);
    const ch = Math.max(0, Math.min(p.ch, lines[p.line].text.length));
    return new Pos(p.line, ch);
  }

  getRange(start, end) {
    const [a, b] = sortPos(start, end);
    const { lines } = this.index();
    // Remember the inline HTML of the covered lines so a later linewise paste of this text can
    // rebuild it with its original formatting (see buildLineEl / richLines).
    cacheRichLines(lines, a, b);
    if (a.line === b.line) return (lines[a.line]?.text || "").slice(a.ch, b.ch);
    const out = [(lines[a.line]?.text || "").slice(a.ch)];
    for (let i = a.line + 1; i < b.line; i++) out.push(lines[i]?.text || "");
    out.push((lines[b.line]?.text || "").slice(0, b.ch));
    return out.join("\n");
  }

  getSelection() {
    const sel = this._selection();
    if (!sel) return "";
    const head = this._domToPos(sel.focusNode, sel.focusOffset);
    const anchor = this._domToPos(sel.anchorNode, sel.anchorOffset);
    return this.getRange(anchor, head);
  }

  getSelections() {
    return [this.getSelection()];
  }

  somethingSelected() {
    const sel = this._selection();
    return !!sel && !sel.isCollapsed;
  }

  listSelections() {
    const sel = this._selection();
    if (!sel) {
      const c = this.getCursor();
      return [{ anchor: c, head: c }];
    }
    return [{
      anchor: this._domToPos(sel.anchorNode, sel.anchorOffset),
      head: this._domToPos(sel.focusNode, sel.focusOffset),
    }];
  }

  // ---- cursor / selection writes ------------------------------------------
  _setDomRange(from, to) {
    const a = this._posToDOM(from);
    const b = this._posToDOM(to);
    const range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (_) {
      return null;
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return range;
  }

  setCursor(line, ch) {
    let pos = line;
    if (typeof line !== "object") pos = { line, ch };
    pos = this.clipPos(pos);
    this._setDomRange(pos, pos);
    this.scrollIntoView(pos);
    this._renderCursor();
  }

  setSelection(from, to) {
    this._setDomRange(from, to);
    this._renderCursor();
  }

  setSelections(selections, primIndex) {
    if (!selections || !selections.length) return;
    const sel = selections[primIndex || 0] || selections[0];
    this._setDomRange(sel.anchor, sel.head);
    this._renderCursor();
  }

  focus() { this.host.focus(); }

  // ---- edits ---------------------------------------------------------------
  replaceRange(text, start, end) {
    if (text == null) text = "";
    let [from, to] = end ? sortPos(start, end) : [start, start];
    from = this.clipPos(from);
    to = this.clipPos(to);
    const multiline = from.line !== to.line || text.indexOf("\n") !== -1;

    this._beginChange();
    if (!multiline) {
      // Clean intra-line edit through execCommand: preserves surrounding inline formatting
      // and rides the browser's native undo stack.
      const range = this._setDomRange(from, to);
      if (range) {
        if (text === "") {
          if (!range.collapsed) document.execCommand("delete", false);
        } else {
          document.execCommand("insertText", false, text);
        }
      }
    } else {
      this._replaceLines(from, to, text);
    }
    this._index = null;
    this._afterEdit();
  }

  replaceSelections(texts) {
    const sels = this.listSelections();
    // single selection in practice; replace it with texts[0]
    const [a, b] = sortPos(sels[0].anchor, sels[0].head);
    this.replaceRange(texts[0] != null ? texts[0] : "", a, b);
  }

  // Structural (multi-line) edit: rebuild the affected block containers as plain <p> lines.
  // Untouched leading/trailing containers (single-line) are kept so their formatting and
  // node identity survive — this makes dd / o / linewise paste preserve neighbours.
  _replaceLines(from, to, text) {
    const { lines } = this.index();
    const before = (lines[from.line]?.text || "").slice(0, from.ch);
    const after = (lines[to.line]?.text || "").slice(to.ch);
    let newTexts = (before + text + after).split("\n");

    // widen [from.line..to.line] to whole containers so BR-split siblings aren't dropped
    let s = from.line, e = to.line;
    while (s > 0 && lines[s - 1].container && lines[s - 1].container === lines[s].container) {
      newTexts.unshift(lines[s - 1].text); s--;
    }
    while (e < lines.length - 1 && lines[e + 1].container && lines[e + 1].container === lines[e].container) {
      newTexts.push(lines[e + 1].text); e++;
    }

    // ordered distinct containers spanning s..e
    const conts = [];
    for (let i = s; i <= e; i++) {
      const c = lines[i].container;
      if (!conts.length || conts[conts.length - 1] !== c) conts.push(c);
    }
    const singleLine = (c) => lines.filter((l) => l.container === c).length === 1;

    // Skip a matching leading run of single-line containers (keep them intact).
    let ci = 0, ti = 0;
    while (ci < conts.length && ti < newTexts.length &&
           singleLine(conts[ci]) && (this._containerText(conts[ci], lines) === newTexts[ti])) {
      ci++; ti++;
    }
    // Skip a matching trailing run.
    let cj = conts.length, tj = newTexts.length;
    while (cj - 1 > ci && tj - 1 >= ti &&
           singleLine(conts[cj - 1]) && (this._containerText(conts[cj - 1], lines) === newTexts[tj - 1])) {
      cj--; tj--;
    }

    // Never treat the editable host itself as a removable line container (can happen if a
    // stray top-level text node produced a host-anchored line) — that would detach the
    // whole surface. Fall back to a plain rebuild inside the host.
    if (conts.indexOf(this.host) !== -1) {
      const built0 = newTexts.map(buildLineEl);
      this.host.textContent = "";
      for (const el of built0) this.host.appendChild(el);
      if (built0.length) {
        const r0 = document.createRange();
        r0.setStart(built0[Math.min(from.line, built0.length - 1)], 0);
        r0.collapse(true);
        const s0 = window.getSelection();
        s0.removeAllRanges();
        s0.addRange(r0);
      }
      return;
    }

    const toRemove = conts.slice(ci, cj);
    const middleTexts = newTexts.slice(ti, tj);
    // Where the rebuilt middle lines go: before the first container of the removed region
    // if any; else (pure insertion after a kept prefix) before the first kept-suffix
    // container, else right after the last kept-prefix container, else host end.
    let insertBefore;
    if (toRemove.length) insertBefore = toRemove[0];
    else if (ci < conts.length) insertBefore = conts[ci]; // first kept-suffix container
    else insertBefore = conts[ci - 1] ? conts[ci - 1].nextSibling : null;
    const parent =
      (insertBefore && insertBefore.parentNode) ||
      (conts[ci - 1] && conts[ci - 1].parentNode) ||
      this.host;

    const built = middleTexts.map(buildLineEl);
    for (const el of built) parent.insertBefore(el, insertBefore);
    for (const el of toRemove) if (el.parentNode) el.parentNode.removeChild(el);

    // caret at the start of the first inserted line (engine calls setCursor next anyway)
    if (built.length) {
      const r = document.createRange();
      r.setStart(built[0], 0);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  _containerText(container, lines) {
    // text of the (single) line that maps to this container
    for (const l of lines) if (l.container === container) return l.text;
    return "";
  }

  newlineAndIndent() {
    const c = this.getCursor();
    this.replaceRange("\n", c, c);
    this.setCursor(c.line + 1, 0);
  }

  // ---- undo (snapshot based, formatting-preserving) ------------------------
  _beginChange() {
    const html = this.host.innerHTML;
    if (this._undoStack.length && this._undoStack[this._undoStack.length - 1] === html) return;
    this._undoStack.push(html);
    if (this._undoStack.length > 200) this._undoStack.shift();
    this._redoStack.length = 0;
  }

  undo() {
    if (!this._undoStack.length) { document.execCommand("undo", false); this._index = null; this._afterEdit(); return; }
    this._redoStack.push(this.host.innerHTML);
    this.host.innerHTML = this._undoStack.pop();
    this._index = null;
    this._afterEdit();
    this.setCursor(0, 0);
  }

  redo() {
    if (!this._redoStack.length) { document.execCommand("redo", false); this._index = null; this._afterEdit(); return; }
    this._undoStack.push(this.host.innerHTML);
    this.host.innerHTML = this._redoStack.pop();
    this._index = null;
    this._afterEdit();
  }

  pushUndoStop() { /* snapshots are taken per-op in _beginChange */ }

  _afterEdit() {
    this._index = null;
    const text = this._fullText();
    this.dispatch("change", this, { text: [text], origin: "+input" });
    this._lastText = text;
    if (typeof this.options.onChange === "function") this.options.onChange(text);
    this._renderCursor();
  }

  // ---- options / config ----------------------------------------------------
  setOption(key, value) { this.state[key] = value; }
  getOption(key) {
    if (key === "readOnly") return this.host.getAttribute("contenteditable") === "false";
    if (key === "firstLineNumber") return 1;
    if (key === "indentWithTabs") return false;
    return this.state[key];
  }
  getConfiguration() {
    return { readOnly: this.getOption("readOnly"), viewInfo: { cursorWidth: 1 }, fontInfo: { typicalFullwidthCharacterWidth: 8, lineHeight: 18 } };
  }

  // ---- misc surface the engine touches ------------------------------------
  operation(fn) { return fn(); }
  dispatch(sig, ...args) {
    const ls = this.listeners[sig];
    if (ls) ls.slice().forEach((h) => { try { h(...args); } catch (e) { console.error(e); } });
  }
  on(event, handler) { (this.listeners[event] = this.listeners[event] || []).push(handler); }
  off(event, handler) {
    const ls = this.listeners[event];
    if (ls) this.listeners[event] = ls.filter((h) => h !== handler);
  }

  setBookmark(cursor, options) {
    const bm = new Marker(this, this.$uid++, cursor.line, cursor.ch);
    if (!options || !options.insertLeft) bm.$insertRight = true;
    return bm;
  }

  indexFromPos(pos) {
    const { lines } = this.index();
    let n = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) n += lines[i].text.length + 1;
    return n + pos.ch;
  }
  posFromIndex(off) {
    const { lines } = this.index();
    let n = off;
    for (let i = 0; i < lines.length; i++) {
      if (n <= lines[i].text.length) return new Pos(i, Math.max(0, n));
      n -= lines[i].text.length + 1;
    }
    const last = lines.length - 1;
    return new Pos(last, lines[last].text.length);
  }

  charCoords(pos, mode) {
    const dom = this._posToDOM(pos);
    try {
      const r = document.createRange();
      r.setStart(dom.node, dom.offset);
      r.collapse(true);
      const rect = r.getBoundingClientRect();
      const local = mode !== "page";
      const base = local ? this.host.getBoundingClientRect() : { top: 0, left: 0 };
      return { top: rect.top - base.top, bottom: rect.bottom - base.top, left: rect.left - base.left };
    } catch (_) {
      return { top: pos.line, bottom: pos.line + 1, left: pos.ch };
    }
  }
  coordsChar(coords, mode) {
    // approximate: clamp to current cursor line — good enough for the engine's use
    return this.getCursor();
  }

  getScrollInfo() {
    const el = this._scrollParent();
    const lineH = 18;
    return {
      left: el.scrollLeft,
      top: Math.floor(el.scrollTop / lineH),
      height: this.lineCount(),
      clientHeight: Math.max(1, Math.floor(el.clientHeight / lineH)),
    };
  }
  scrollTo(x, y) { /* page scroll is handled by scrollIntoView on cursor moves */ }
  scrollIntoView(pos) {
    if (!pos) return;
    const dom = this._posToDOM(pos);
    const node = dom.node.nodeType === TEXT_NODE ? dom.node.parentNode : dom.node;
    if (node && node.scrollIntoView) {
      try { node.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) {}
    }
  }
  _scrollParent() {
    let el = this.host;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  moveH(units, type) {
    if (type !== "char") return;
    const c = this.getCursor();
    this.setCursor(c.line, c.ch + units);
  }

  findPosV(startPos, amount, unit) {
    let n = amount;
    if (unit === "page") {
      const info = this.getScrollInfo();
      n = amount * Math.max(1, info.clientHeight);
    }
    const line = Math.max(0, Math.min(this.lineCount() - 1, startPos.line + n));
    return new Pos(line, startPos.ch);
  }

  findMatchingBracket(pos) {
    const line = this.getLine(pos.line);
    const ch = line.charAt(pos.ch);
    const m = matchingBrackets[ch];
    if (!m) return { to: null };
    const forward = m.charAt(1) === ">";
    const open = ch, close = m.charAt(0);
    const text = this._fullText();
    const idx = this.indexFromPos(pos);
    let depth = 0;
    if (forward) {
      for (let i = idx; i < text.length; i++) {
        if (text[i] === open) depth++;
        else if (text[i] === close && --depth === 0) return { to: this.posFromIndex(i) };
      }
    } else {
      for (let i = idx; i >= 0; i--) {
        if (text[i] === open) depth++;
        else if (text[i] === close && --depth === 0) return { to: this.posFromIndex(i) };
      }
    }
    return { to: null };
  }

  scanForBracket(pos, dir, _dd, config) {
    const re = config.bracketRegex;
    const text = this._fullText();
    let i = this.indexFromPos(pos);
    const stack = [];
    let guard = 0;
    while (i >= 0 && i < text.length && guard++ < 100000) {
      const ch = text[i];
      if (re.test(ch)) {
        const mb = matchingBrackets[ch];
        if (mb && (mb.charAt(1) === ">") === (dir > 0)) stack.push(ch);
        else if (stack.length === 0) return { pos: this.posFromIndex(i) };
        else stack.pop();
      }
      i += dir;
    }
    return undefined;
  }

  findFirstNonWhiteSpaceCharacter(line) {
    const text = this.getLine(line);
    const m = text.match(/\S/);
    return m ? m.index : text.length;
  }

  indentLine(line, indentRight = true) {
    const text = this.getLine(line);
    if (indentRight) {
      this.replaceRange("  ", new Pos(line, 0), new Pos(line, 0));
    } else {
      const strip = text.match(/^(\t| {1,2})/);
      if (strip) this.replaceRange("", new Pos(line, 0), new Pos(line, strip[0].length));
    }
  }

  // ---- search --------------------------------------------------------------
  getSearchCursor(query, pos) {
    const context = this;
    let regex;
    if (query instanceof RegExp) {
      let flags = "g";
      if (query.ignoreCase) flags += "i";
      regex = new RegExp(query.source, flags);
    } else {
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    }
    let from = null, to = null;
    const startIdx = context.indexFromPos(pos.ch == null ? new Pos(pos.line, 0) : pos);

    function matchFrom(index, back) {
      const text = context._fullText();
      if (!back) {
        regex.lastIndex = index;
        const m = regex.exec(text);
        if (!m) return null;
        return [m.index, m.index + m[0].length];
      }
      // backward: last match ending before `index`
      let last = null, m;
      regex.lastIndex = 0;
      while ((m = regex.exec(text))) {
        if (m.index + m[0].length <= index) last = [m.index, m.index + m[0].length];
        else break;
        if (m.index === regex.lastIndex) regex.lastIndex++;
      }
      return last;
    }

    return {
      find(back) {
        const anchor = to ? context.indexFromPos(back ? from : to) : startIdx;
        const res = matchFrom(anchor, back);
        if (!res) { from = to = null; return false; }
        from = context.posFromIndex(res[0]);
        to = context.posFromIndex(res[1]);
        return from;
      },
      findNext() { return this.find(false); },
      findPrevious() { return this.find(true); },
      from() { return from; },
      to() { return to; },
      replace(text) {
        if (from && to) {
          context.replaceRange(text, from, to);
          to = context.posFromIndex(context.indexFromPos(from) + text.length);
        }
      },
    };
  }

  // Highlight / overlay are visual-only niceties; no-op keeps search working.
  highlightRanges() { return []; }
  addOverlay() {}
  removeOverlay() {}
  showMatchesOnScrollbar() { return { find() {}, clear() {} }; }

  // ---- vim mode transitions ------------------------------------------------
  enterVimMode() {
    this.ctxInsert.set(false);
    this.host.classList.add("zmodal-normal");
    this._insertSnap = false;
    this._renderCursor();
  }
  leaveVimMode() {
    this.ctxInsert.set(true);
    this.host.classList.remove("zmodal-normal", "zmodal-visual");
    this._insertSnap = false;
    if (this._cursorEl) this._cursorEl.style.display = "none";
  }
  virtualSelectionMode() { return false; }

  toggleOverwrite(on) {
    this.replaceMode = !!on;
    if (on) { this.enterVimMode(); } else { this.leaveVimMode(); this.replaceStack = []; }
  }
  _handleReplaceMode(e) {
    // Minimal R-mode: type over the char ahead. (Backspace restore is best-effort.)
    if (e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const c = this.getCursor();
      const line = this.getLine(c.line);
      const end = c.ch < line.length ? new Pos(c.line, c.ch + 1) : c;
      this._beginChange();
      this.replaceRange(e.key, c, end);
      this.setCursor(c.line, c.ch + 1);
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---- status bar / dialogs ------------------------------------------------
  setStatusBar(sb) { this.statusBar = sb; }
  openDialog(html, callback, options) { return this.statusBar ? this.statusBar.setSec(html, callback, options) : undefined; }
  openNotification(html) { if (this.statusBar) this.statusBar.showNotification(html); }

  // ---- small stubs the engine references ----------------------------------
  save() {}
  getInputField() { return this.host; }
  getWrapperElement() { return this.host; }
  getTokenTypeAt() { return ""; }
  getLineHandle(line) { return { line, text: this.getLine(line) }; }
  getLineNumber(handle) { return handle ? handle.line : 0; }
  markText() { return { clear() {}, find() { return null; } }; }
  triggerEditorAction() {}
  moveCurrentLineTo() {}
  execCommand(cmd) {
    if (cmd === "goLineLeft") { const c = this.getCursor(); this.setCursor(c.line, 0); }
    else if (cmd === "goLineRight") { const c = this.getCursor(); this.setCursor(c.line, this.getLine(c.line).length); }
  }
  getUserVisibleLines() { return { top: 0, bottom: this.lastLine() }; }

  // ---- block cursor overlay -----------------------------------------------
  // A blinking block cursor, painted over the character at the caret in normal/visual
  // mode (hidden in insert mode, where the native caret shows). Self-contained: the blink
  // keyframes + look are injected once so any consuming app gets it without extra CSS.
  _ensureCursorStyle() {
    if (document.getElementById("zmodal-cursor-style")) return;
    const s = document.createElement("style");
    s.id = "zmodal-cursor-style";
    // Theme-driven colour: follow the host app's colorscheme via CSS custom properties
    // (--accent / --accent-glow, re-valued per theme), with --cyan and a hard default as
    // fallbacks so the shared adapter still shows a cursor in an unthemed app. An app can
    // force a colour with --zmodal-cursor-color / -fill / -glow.
    // NB: NO `mix-blend-mode` — screen-blend over the white document canvas resolves to
    // white (invisible); a translucent fill + solid outline + glow reads on white AND dark.
    const COLOR = "var(--zmodal-cursor-color,var(--accent,var(--cyan,#00e5ff)))";
    const FILL = "var(--zmodal-cursor-fill,var(--accent-glow,var(--cyan-glow,rgba(0,229,255,.4))))";
    const GLOW = "var(--zmodal-cursor-glow,var(--accent-glow,var(--cyan-glow,rgba(0,229,255,.85))))";
    s.textContent =
      "@keyframes zmodal-blink{0%,55%{opacity:1}56%,100%{opacity:0}}" +
      // z-index sits above editor/pane content (the tmux tiling overlay is 8500) but BELOW app
      // overlays — the ⌘K palette (9998), zgui modals (25000) and toasts (30000) — so a dialog
      // opened over the editor is never pierced by the blinking block caret.
      ".zmodal-block-cursor{position:fixed;pointer-events:none;z-index:9000;" +
      "background:" + FILL + ";outline:1.5px solid " + COLOR + ";" +
      "box-shadow:0 0 6px " + GLOW + ";border-radius:1px;" +
      "animation:zmodal-blink 1.06s steps(1) infinite}";
    document.head.appendChild(s);
  }
  _renderCursor() {
    try {
      if (this.ctxInsert.get()) { if (this._cursorEl) this._cursorEl.style.display = "none"; return; }
      const c = this.getCursor();
      const line = this.getLine(c.line);
      const from = new Pos(c.line, c.ch);
      const to = new Pos(c.line, Math.min(line.length, c.ch + 1));
      const a = this._posToDOM(from), b = this._posToDOM(to);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      if (c.ch < line.length) range.setEnd(b.node, b.offset);
      else range.setEnd(a.node, a.offset);
      let rect = range.getBoundingClientRect();
      // Empty line: a collapsed range in an empty block (<p> with just a <br>) has no geometry, so
      // the block cursor would land at (0,0) / invisible. Fall back to the line element's TOP/LEFT but
      // use ONE line-height for the cursor — NOT the element's full height (an empty box is as tall as
      // the whole textarea, which made the block cursor span the entire field).
      if (!rect.height) {
        const el: any = a.node && (a.node as any).nodeType === 1 ? a.node : (a.node as any).parentElement;
        if (el && el.getBoundingClientRect) {
          const er = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 16;
          const padL = parseFloat(cs.paddingLeft) || 0, padT = parseFloat(cs.paddingTop) || 0;
          rect = { left: er.left + padL, top: er.top + padT, width: 0, height: lh } as DOMRect;
        }
      }
      if (!this._cursorEl) {
        this._ensureCursorStyle();
        this._cursorEl = document.createElement("div");
        this._cursorEl.className = "zmodal-block-cursor";
        document.body.appendChild(this._cursorEl);
      }
      const hostCs = getComputedStyle(this.host);
      const lineH = parseFloat(hostCs.lineHeight) || parseFloat(hostCs.fontSize) * 1.3 || 16;
      const w = rect.width || (parseFloat(hostCs.fontSize) * 0.6) || 8;
      // Cap the cursor at ~one line: a degenerate/empty-line rect can report the full field height,
      // which made the block cursor as tall as the whole textarea.
      const h = Math.min(rect.height || lineH, lineH * 1.6);
      this._cursorEl.style.display = "block";
      this._cursorEl.style.left = rect.left + "px";
      this._cursorEl.style.top = rect.top + "px";
      this._cursorEl.style.width = w + "px";
      this._cursorEl.style.height = h + "px";
      // Restart the blink so the cursor is solid immediately after each move (like a
      // terminal vim), then resumes blinking.
      this._cursorEl.style.animation = "none";
      void this._cursorEl.offsetWidth;
      this._cursorEl.style.animation = "";
    } catch (_) {
      if (this._cursorEl) this._cursorEl.style.display = "none";
    }
  }
}

export default DomAdapter;
