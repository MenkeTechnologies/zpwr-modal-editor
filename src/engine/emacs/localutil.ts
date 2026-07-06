// zmodal-editor — tiny, dependency-free replacements for the two lodash helpers
// the vendored monaco-emacs source used (lodash.throttle, lodash.kebabcase). Keeping
// them in-package means the whole editor bundles with no external runtime deps.

/** Trailing+leading throttle with a `.cancel()`, matching the lodash.throttle
 *  surface monaco-emacs relies on (it calls `_throttledScroll.cancel()` on dispose). */
export function throttle<T extends (...args: any[]) => any>(fn: T, wait: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] | null = null;
  let lastThis: any = null;

  const invoke = (time: number) => {
    last = time;
    fn.apply(lastThis, lastArgs as any[]);
    lastArgs = lastThis = null;
  };

  const throttled = function (this: any, ...args: any[]) {
    const now = Date.now();
    const remaining = wait - (now - last);
    lastArgs = args;
    lastThis = this;
    if (remaining <= 0 || remaining > wait) {
      if (timer) { clearTimeout(timer); timer = null; }
      invoke(now);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; invoke(Date.now()); }, remaining);
    }
  } as T & { cancel: () => void };

  throttled.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    last = 0;
    lastArgs = lastThis = null;
  };

  return throttled;
}

/** CamelCase / PascalCase / spaced → kebab-case (e.g. "BlockOutline" → "block-outline").
 *  monaco-emacs only feeds it enum names, so this narrow implementation suffices. */
export function kebabCase(input: string): string {
  return String(input)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}
