// @ts-nocheck
/**
 * cm_core — the surface-AGNOSTIC half of the CodeMirror shim the vendored Vim engine
 * (engine/vim/keymap_vim.ts) talks to. None of this imports monaco: it is pure text /
 * key / event helpers. Both surface adapters consume it:
 *
 *   adapters/monaco_adapter.ts → a Monaco editor        (bundles monaco)
 *   adapters/dom_adapter.ts    → a contenteditable page  (NO monaco — used by word/ppt)
 *
 * Keeping these here means the DOM bundle can be built without ever importing monaco,
 * which is what lets zoffice run the Vim engine over its WYSIWYG pages without loading a
 * second Monaco (the hooks editor already loads one; two full Monacos crash WKWebView).
 */

const nonASCIISingleCaseWordChar =
  /[ßև֐-״؀-ۿ぀-ゟ゠-ヿ㐀-䶵一-鿌가-힯]/;

export function isWordChar(ch) {
  return (
    /\w/.test(ch) ||
    (ch > "\x80" &&
      (ch.toUpperCase() != ch.toLowerCase() ||
        nonASCIISingleCaseWordChar.test(ch)))
  );
}

export function Pos(line, column) {
  if (!(this instanceof Pos)) {
    return new Pos(line, column);
  }

  this.line = line;
  this.ch = column;
}

/** Fire a named event on an adapter instance (adapters implement dispatch()). */
export function signal(cm, sig, args) {
  cm.dispatch(sig, args);
}

/** No-op factory — used for the CodeMirror statics the Vim engine references but that a
 *  surface adapter has no use for (on/off/addClass/rmClass/defineOption). */
export function dummy(key) {
  return function () {};
}

export const matchingBrackets = {
  "(": ")>",
  ")": "(<",
  "[": "]>",
  "]": "[<",
  "{": "}>",
  "}": "{<",
  "<": ">>",
  ">": "<<",
};

export function e_preventDefault(e) {
  if (e.preventDefault) {
    e.preventDefault();
    if (e.browserEvent) {
      e.browserEvent.preventDefault();
    }
  } else {
    e.returnValue = false;
  }
  return false;
}

export function e_stop(e) {
  if (e.stopPropagation) {
    e.stopPropagation();
  } else {
    e.cancelBubble = true;
  }
  e_preventDefault(e);
  return false;
}

/**
 * CodeMirror's key-lookup. `keyMap` is the adapter-owned registry (each adapter keeps its
 * own so the Vim engine's `keyMap.vim = …` mutation stays scoped to that bundle).
 */
export function lookupKey(key, map, handle, keyMap) {
  if (typeof map === "string") {
    map = keyMap[map];
  }
  const found = typeof map == "function" ? map(key) : map[key];

  if (found === false) return "nothing";
  if (found === "...") return "multi";
  if (found != null && handle(found)) return "handled";

  if (map.fallthrough) {
    if (!Array.isArray(map.fallthrough))
      return lookupKey(key, map.fallthrough, handle, keyMap);
    for (var i = 0; i < map.fallthrough.length; i++) {
      var result = lookupKey(key, map.fallthrough[i], handle, keyMap);
      if (result) return result;
    }
  }
}

/** Fresh key-map registry — { default } only; the Vim engine adds vim / vim-insert / … */
export function makeKeyMap() {
  return {
    default: function (key) {
      return function (cm) {
        return true;
      };
    },
  };
}

/** A vim mark / bookmark. Stores a 1-based line/column and resolves back to a cm Pos. */
export class Marker {
  constructor(cm, id, line, ch) {
    this.cm = cm;
    this.id = id;
    this.lineNumber = line + 1;
    this.column = ch + 1;
    cm.marks[this.id] = this;
  }

  clear() {
    delete this.cm.marks[this.id];
  }

  find() {
    return new Pos(this.lineNumber - 1, this.column - 1);
  }
}

let doFold, noFold;
if (String.prototype.normalize) {
  doFold = (str) => str.normalize("NFD").toLowerCase();
  noFold = (str) => str.normalize("NFD");
} else {
  doFold = (str) => str.toLowerCase();
  noFold = (str) => str;
}
export { doFold, noFold };

export function StringStream(string, tabSize) {
  this.pos = this.start = 0;
  this.string = string;
  this.tabSize = tabSize || 8;
  this.lastColumnPos = this.lastColumnValue = 0;
  this.lineStart = 0;
}

StringStream.prototype = {
  eol: function () {
    return this.pos >= this.string.length;
  },
  sol: function () {
    return this.pos == this.lineStart;
  },
  peek: function () {
    return this.string.charAt(this.pos) || undefined;
  },
  next: function () {
    if (this.pos < this.string.length) return this.string.charAt(this.pos++);
  },
  eat: function (match) {
    var ch = this.string.charAt(this.pos);
    var ok;
    if (typeof match == "string") ok = ch == match;
    else ok = ch && (match.test ? match.test(ch) : match(ch));
    if (ok) {
      ++this.pos;
      return ch;
    }
  },
  eatWhile: function (match) {
    var start = this.pos;
    while (this.eat(match)) {}
    return this.pos > start;
  },
  eatSpace: function () {
    var start = this.pos;
    while (/[\s ]/.test(this.string.charAt(this.pos))) ++this.pos;
    return this.pos > start;
  },
  skipToEnd: function () {
    this.pos = this.string.length;
  },
  skipTo: function (ch) {
    var found = this.string.indexOf(ch, this.pos);
    if (found > -1) {
      this.pos = found;
      return true;
    }
  },
  backUp: function (n) {
    this.pos -= n;
  },
  column: function () {
    throw "not implemented";
  },
  indentation: function () {
    throw "not implemented";
  },
  match: function (pattern, consume, caseInsensitive) {
    if (typeof pattern == "string") {
      var cased = function (str) {
        return caseInsensitive ? str.toLowerCase() : str;
      };
      var substr = this.string.substr(this.pos, pattern.length);
      if (cased(substr) == cased(pattern)) {
        if (consume !== false) this.pos += pattern.length;
        return true;
      }
    } else {
      var match = this.string.slice(this.pos).match(pattern);
      if (match && match.index > 0) return null;
      if (match && consume !== false) this.pos += match[0].length;
      return match;
    }
  },
  current: function () {
    return this.string.slice(this.start, this.pos);
  },
  hideFirstChars: function (n, inner) {
    this.lineStart += n;
    try {
      return inner();
    } finally {
      this.lineStart -= n;
    }
  },
};
