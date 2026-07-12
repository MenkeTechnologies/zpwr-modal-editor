// completion.ts — insert-mode completion popup for the DOM (contenteditable) editor.
//
// A minimal completion engine bolted onto the vendored Vim engine: while typing in INSERT mode it
// queries a per-field source for candidates matching the word before the caret and shows a popup.
//   Tab / Enter        → accept the selected candidate
//   Ctrl-N / ↓         → next     ·   Ctrl-P / ↑ → previous
//   Esc                → dismiss
//
// The source is supplied either via `attach({ completion })` (whole handle) or per-element as
// `host.zmodalCompletion` — so a host app can give different fields different candidate lists without
// the generic attach knowing about them. When no source is set the popup never shows and every key
// (including Tab) flows straight to the Vim engine unchanged.

export type CompletionItem = string | { label: string; insert?: string; detail?: string };

export interface CompletionConfig {
  /** Return candidates for the word `prefix` before the caret (`fullText` is the whole buffer). */
  source: (prefix: string, fullText: string) => CompletionItem[] | null | undefined;
  /** Characters that terminate the token being completed. Default: space, tab, newline, comma, semicolon. */
  separators?: string;
  /** Minimum prefix length before the popup shows. Default 1. */
  minChars?: number;
  /** Max candidates shown. Default 8. */
  maxItems?: number;
}

interface NormItem {
  label: string;
  insert: string;
  detail?: string;
}

const STYLE_ID = "zmodal-completion-style";

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent =
    ".zmodal-completion{position:fixed;z-index:32000;min-width:160px;max-width:380px;max-height:220px;" +
    "overflow-y:auto;background:#0d0d1a;border:1px solid #05d9e8;border-radius:6px;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.5),0 0 12px rgba(5,217,232,.25);" +
    "font-family:'Share Tech Mono',monospace;font-size:12px;padding:3px;display:none}" +
    ".zmodal-completion.zc-open{display:block}" +
    ".zmodal-completion-item{padding:4px 8px;border-radius:4px;color:#e0f0ff;white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;cursor:pointer}" +
    ".zmodal-completion-item .zc-detail{color:#7a8ba8;margin-left:8px;font-size:11px}" +
    ".zmodal-completion-item.zc-sel{background:rgba(5,217,232,.18);color:#05d9e8}" +
    ':root[data-theme="light"] .zmodal-completion{background:#fff;border-color:#0891b2;box-shadow:0 8px 30px rgba(0,0,0,.15)}' +
    ':root[data-theme="light"] .zmodal-completion-item{color:#1e293b}' +
    ':root[data-theme="light"] .zmodal-completion-item.zc-sel{background:rgba(8,145,178,.14);color:#0891b2}';
  document.head.appendChild(s);
}

export class Completion {
  private host: HTMLElement;
  private getAdapter: () => any;
  private cfgOpt: CompletionConfig | null;
  private popup: HTMLDivElement;
  private items: NormItem[] = [];
  private sel = 0;
  private open = false;
  private prefixLen = 0;

  constructor(host: HTMLElement, getAdapter: () => any, cfg: CompletionConfig | null) {
    this.host = host;
    this.getAdapter = getAdapter;
    this.cfgOpt = cfg || null;
    ensureStyle();
    this.popup = document.createElement("div");
    this.popup.className = "zmodal-completion";
    document.body.appendChild(this.popup);
    this._onInput = this._onInput.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onBlur = this._onBlur.bind(this);
    host.addEventListener("input", this._onInput);
    host.addEventListener("blur", this._onBlur);
    // Capture on document so this runs BEFORE the Vim engine's host-level capture keydown — lets us
    // consume Tab/Enter/arrows for the popup before Vim sees them. Only consumes while the popup is open.
    document.addEventListener("keydown", this._onKey, true);
  }

  dispose(): void {
    this.host.removeEventListener("input", this._onInput);
    this.host.removeEventListener("blur", this._onBlur);
    document.removeEventListener("keydown", this._onKey, true);
    this.popup.remove();
  }

  private cfg(): CompletionConfig | null {
    return this.cfgOpt || ((this.host as any).zmodalCompletion as CompletionConfig) || null;
  }

  private _onBlur(): void {
    // Delay so a mousedown on a popup row (which accepts) isn't cancelled by the blur-close.
    setTimeout(() => this.close(), 120);
  }

  private inInsert(): boolean {
    const a = this.getAdapter();
    // Insert mode when the engine reports it; with no engine engaged (native typing), treat as active.
    return !a || !a.ctxInsert || a.ctxInsert.get() !== false;
  }

  private currentPrefix(): string | null {
    const a = this.getAdapter();
    const seps = this.cfg()?.separators || " \t\n,;";
    let before = "";
    if (a && typeof a.getCursor === "function" && typeof a._fullText === "function") {
      const cur = a.getCursor();
      const lines = String(a._fullText()).split("\n");
      before = (lines[cur.line] || "").slice(0, cur.ch);
    } else {
      const sel = window.getSelection();
      if (!sel || !sel.focusNode || !this.host.contains(sel.focusNode)) return null;
      before = (sel.focusNode.textContent || "").slice(0, sel.focusOffset);
    }
    let i = before.length;
    while (i > 0 && seps.indexOf(before[i - 1]) === -1) i--;
    return before.slice(i);
  }

  private _onInput(): void {
    if (!this.inInsert()) { this.close(); return; }
    const c = this.cfg();
    if (!c || typeof c.source !== "function") { this.close(); return; }
    const prefix = this.currentPrefix();
    if (prefix == null) { this.close(); return; }
    const min = c.minChars == null ? 1 : c.minChars;
    if (prefix.length < min) { this.close(); return; }
    let cands: CompletionItem[] | null | undefined = [];
    try {
      const a = this.getAdapter();
      cands = c.source(prefix, a && typeof a._fullText === "function" ? a._fullText() : this.host.innerText);
    } catch (_) {
      cands = [];
    }
    if (!cands || !cands.length) { this.close(); return; }
    const max = c.maxItems || 8;
    this.items = cands.slice(0, max).map((it) =>
      typeof it === "string"
        ? { label: it, insert: it }
        : { label: it.label, insert: it.insert != null ? it.insert : it.label, detail: it.detail },
    );
    this.prefixLen = prefix.length;
    this.sel = 0;
    this.render();
    this.show();
  }

  private render(): void {
    this.popup.innerHTML = "";
    this.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "zmodal-completion-item" + (i === this.sel ? " zc-sel" : "");
      row.textContent = it.label;
      if (it.detail) {
        const d = document.createElement("span");
        d.className = "zc-detail";
        d.textContent = it.detail;
        row.appendChild(d);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.sel = i;
        this.accept();
      });
      this.popup.appendChild(row);
    });
  }

  private show(): void {
    let rect: DOMRect | null = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(false);
      const rects = r.getClientRects();
      rect = rects.length ? (rects[0] as DOMRect) : (r.getBoundingClientRect() as DOMRect);
    }
    if (!rect || (!rect.width && !rect.height && !rect.left && !rect.top)) {
      rect = this.host.getBoundingClientRect() as DOMRect;
    }
    const vw = window.innerWidth;
    let left = Math.round(rect.left);
    if (left + 380 > vw) left = Math.max(4, vw - 384);
    this.popup.style.left = left + "px";
    this.popup.style.top = Math.round(rect.bottom + 4) + "px";
    this.popup.classList.add("zc-open");
    this.open = true;
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    this.popup.classList.remove("zc-open");
  }

  private move(d: number): void {
    if (!this.items.length) return;
    this.sel = (this.sel + d + this.items.length) % this.items.length;
    this.render();
  }

  private accept(): void {
    if (!this.open || !this.items.length) return;
    const it = this.items[this.sel];
    const a = this.getAdapter();
    if (a && typeof a.replaceRange === "function" && typeof a.getCursor === "function") {
      const cur = a.getCursor();
      a.replaceRange(it.insert, { line: cur.line, ch: Math.max(0, cur.ch - this.prefixLen) }, cur);
    } else {
      const sel = window.getSelection();
      if (sel && sel.focusNode && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.setStart(sel.focusNode, Math.max(0, sel.focusOffset - this.prefixLen));
        range.deleteContents();
        range.insertNode(document.createTextNode(it.insert));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    this.close();
  }

  private _onKey(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.target !== this.host && !this.host.contains(e.target as Node)) return;
    const k = e.key;
    const ctrlN = e.ctrlKey && (k === "n" || k === "N");
    const ctrlP = e.ctrlKey && (k === "p" || k === "P");
    if (k === "Tab" || k === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.accept();
    } else if (k === "ArrowDown" || ctrlN) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.move(1);
    } else if (k === "ArrowUp" || ctrlP) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.move(-1);
    } else if (k === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
    }
    // Any other key flows to the Vim engine; the resulting `input` refreshes the popup.
  }
}
