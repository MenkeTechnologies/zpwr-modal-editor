// snippets.ts — user-defined text snippets that expand while typing in the modal editor.
//
// A snippet is `{ trigger, body }`: type the trigger and the completion popup offers it; accept
// (Tab/Enter) to insert the body. Bodies may contain dynamic tokens — `$DATE`, `$TIME`, `$DATETIME`,
// `$DATE_ISO`, `$YEAR` — resolved at insertion time (so a `date` snippet with body `$DATE` inserts
// today's date). Snippets persist in `localStorage` (per app WebView) and are created/edited/removed
// via the built-in manager (`openManager()`), so the feature is self-contained in the editor.

export interface Snippet {
  trigger: string;
  body: string;
}

const STORE_KEY = "zmodal-snippets";

export function loadSnippets(): Snippet[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr)) {
      return arr.filter(
        (s) => s && typeof s.trigger === "string" && typeof s.body === "string" && s.trigger.length > 0,
      );
    }
  } catch (_) {
    /* localStorage unavailable / malformed */
  }
  return [];
}

export function saveSnippets(list: Snippet[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch (_) {
    /* ignore */
  }
}

/** Add or replace (by trigger) a snippet. */
export function addSnippet(trigger: string, body: string): void {
  const t = String(trigger || "").trim();
  if (!t) return;
  const list = loadSnippets().filter((s) => s.trigger !== t);
  list.push({ trigger: t, body: String(body == null ? "" : body) });
  list.sort((a, b) => a.trigger.localeCompare(b.trigger));
  saveSnippets(list);
}

export function removeSnippet(trigger: string): void {
  saveSnippets(loadSnippets().filter((s) => s.trigger !== trigger));
}

/** Resolve dynamic tokens in a snippet body at insertion time. */
export function expandBody(body: string): string {
  const now = new Date();
  return String(body == null ? "" : body)
    .replace(/\$DATETIME\b/g, now.toLocaleString())
    .replace(/\$DATE_ISO\b/g, now.toISOString().slice(0, 10))
    .replace(/\$DATE\b/g, now.toLocaleDateString())
    .replace(/\$TIME\b/g, now.toLocaleTimeString())
    .replace(/\$YEAR\b/g, String(now.getFullYear()));
}

/**
 * Completion candidates for `prefix`: snippets whose trigger starts with (then merely contains) it.
 * `insert` is the expanded body; `label` is the trigger, with a short body preview as `detail`.
 */
export function matchSnippets(prefix: string): Array<{ label: string; insert: string; detail: string }> {
  const low = String(prefix || "").toLowerCase();
  if (!low) return [];
  const pre: Snippet[] = [];
  const sub: Snippet[] = [];
  for (const s of loadSnippets()) {
    const tl = s.trigger.toLowerCase();
    if (tl.startsWith(low)) pre.push(s);
    else if (tl.includes(low)) sub.push(s);
  }
  return pre.concat(sub).slice(0, 8).map((s) => {
    const preview = s.body.replace(/\s+/g, " ").trim();
    return {
      label: s.trigger,
      insert: expandBody(s.body),
      detail: "⚡ " + (preview.length > 32 ? preview.slice(0, 31) + "…" : preview),
    };
  });
}

// ── built-in manager UI ─────────────────────────────────────────────────────
const MGR_STYLE_ID = "zmodal-snippets-style";

function ensureMgrStyle(): void {
  if (document.getElementById(MGR_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = MGR_STYLE_ID;
  s.textContent =
    ".zmodal-snip-overlay{position:fixed;inset:0;z-index:33000;background:rgba(0,0,0,.55);" +
    "display:flex;align-items:flex-start;justify-content:center;padding-top:10vh;" +
    "font-family:'Share Tech Mono',monospace}" +
    ".zmodal-snip-box{position:relative;width:min(92vw,560px);max-height:74vh;display:flex;" +
    "flex-direction:column;gap:10px;padding:16px;background:#0d0d1a;border:1px solid #05d9e8;" +
    "border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 20px rgba(5,217,232,.25);color:#e0f0ff}" +
    ".zmodal-snip-title{font-family:'Orbitron','Share Tech Mono',sans-serif;font-size:14px;" +
    "letter-spacing:2px;text-transform:uppercase;color:#05d9e8}" +
    ".zmodal-snip-close{position:absolute;top:10px;right:12px;background:transparent;border:1px solid #1a1a3e;" +
    "color:#e0f0ff;border-radius:4px;cursor:pointer;font-size:13px;padding:2px 8px}" +
    ".zmodal-snip-list{overflow-y:auto;max-height:34vh;display:flex;flex-direction:column;gap:4px}" +
    ".zmodal-snip-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid #1a1a3e;border-radius:4px}" +
    ".zmodal-snip-trg{color:#05d9e8;cursor:pointer;font-weight:700;min-width:80px}" +
    ".zmodal-snip-body{color:#7a8ba8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}" +
    ".zmodal-snip-del{margin-left:auto;background:transparent;border:1px solid #1a1a3e;color:#ff2a6d;" +
    "border-radius:4px;cursor:pointer;font-size:11px;padding:1px 7px}" +
    ".zmodal-snip-empty{color:#7a8ba8;font-size:12px;padding:6px}" +
    ".zmodal-snip-form{display:flex;flex-direction:column;gap:6px}" +
    ".zmodal-snip-input,.zmodal-snip-textarea{background:#05050a;border:1px solid #1a1a3e;border-radius:4px;" +
    "color:#e0f0ff;font-family:inherit;font-size:12px;padding:6px 8px}" +
    ".zmodal-snip-textarea{min-height:64px;resize:vertical}" +
    ".zmodal-snip-btn{align-self:flex-start;background:#05d9e8;color:#04121a;border:none;border-radius:4px;" +
    "cursor:pointer;font-family:inherit;font-weight:700;font-size:12px;padding:6px 14px}" +
    ".zmodal-snip-hint{color:#7a8ba8;font-size:11px;line-height:1.5}" +
    ':root[data-theme="light"] .zmodal-snip-box{background:#fff;border-color:#0891b2;color:#1e293b}' +
    ':root[data-theme="light"] .zmodal-snip-title{color:#0891b2}' +
    ':root[data-theme="light"] .zmodal-snip-input,:root[data-theme="light"] .zmodal-snip-textarea{background:#f7f8fa;border-color:#cbd5e1;color:#1e293b}' +
    ':root[data-theme="light"] .zmodal-snip-trg{color:#0891b2}';
  document.head.appendChild(s);
}

/** Open the built-in snippet manager: list, add/update (click a trigger to load it), remove. */
export function openManager(): void {
  ensureMgrStyle();
  const overlay = document.createElement("div");
  overlay.className = "zmodal-snip-overlay";
  const box = document.createElement("div");
  box.className = "zmodal-snip-box";
  overlay.appendChild(box);

  const title = document.createElement("div");
  title.className = "zmodal-snip-title";
  title.textContent = "Snippets";
  box.appendChild(title);

  const close = document.createElement("button");
  close.className = "zmodal-snip-close";
  close.textContent = "✕";
  box.appendChild(close);

  const list = document.createElement("div");
  list.className = "zmodal-snip-list";
  box.appendChild(list);

  const form = document.createElement("div");
  form.className = "zmodal-snip-form";
  const trg = document.createElement("input");
  trg.className = "zmodal-snip-input";
  trg.placeholder = "trigger (e.g. addr, sig, date)";
  const bod = document.createElement("textarea");
  bod.className = "zmodal-snip-textarea";
  bod.placeholder = "body — tokens: $DATE $TIME $DATETIME $DATE_ISO $YEAR";
  const add = document.createElement("button");
  add.className = "zmodal-snip-btn";
  add.textContent = "Add / Update";
  form.appendChild(trg);
  form.appendChild(bod);
  form.appendChild(add);
  box.appendChild(form);

  const hint = document.createElement("div");
  hint.className = "zmodal-snip-hint";
  hint.textContent =
    "Type a trigger while editing → the popup offers it → Tab expands. Click a trigger above to edit it.";
  box.appendChild(hint);

  function refresh(): void {
    list.innerHTML = "";
    const items = loadSnippets();
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "zmodal-snip-empty";
      e.textContent = "No snippets yet — add one below.";
      list.appendChild(e);
      return;
    }
    for (const s of items) {
      const row = document.createElement("div");
      row.className = "zmodal-snip-row";
      const nm = document.createElement("span");
      nm.className = "zmodal-snip-trg";
      nm.textContent = s.trigger;
      nm.title = "Click to edit";
      nm.addEventListener("click", () => {
        trg.value = s.trigger;
        bod.value = s.body;
        bod.focus();
      });
      const bd = document.createElement("span");
      bd.className = "zmodal-snip-body";
      bd.textContent = s.body.replace(/\s+/g, " ").trim();
      const del = document.createElement("button");
      del.className = "zmodal-snip-del";
      del.textContent = "✕";
      del.title = "Delete";
      del.addEventListener("click", () => {
        removeSnippet(s.trigger);
        refresh();
      });
      row.appendChild(nm);
      row.appendChild(bd);
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  const dismiss = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && document.body.contains(overlay)) {
      e.stopPropagation();
      dismiss();
    }
  }

  add.addEventListener("click", () => {
    if (!trg.value.trim()) {
      trg.focus();
      return;
    }
    addSnippet(trg.value, bod.value);
    trg.value = "";
    bod.value = "";
    trg.focus();
    refresh();
  });
  close.addEventListener("click", dismiss);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener("keydown", onKey, true);

  refresh();
  document.body.appendChild(overlay);
  trg.focus();
}
