// Keeps removals and edits visible on the page until Claude delivers the real
// fix. Survives reloads (state comes from the server) and SPA re-renders
// (a MutationObserver re-applies). Never replaces React's DOM nodes: it only
// adds an attribute, a stylesheet rule and changes text node values.
import type { Change, Comment, TextChange } from '@brm/shared';
import { findTarget, isOurs } from './targets.ts';

const ATTR = 'data-brm-c';
const STYLE_ID = 'browser-review-previews';

interface Entry {
  key: string;
  change: Change;
  /** Either a fixed element (draft while editing) or a resolver from a stored comment. */
  resolve: () => Element | null;
}

interface TextEdit {
  node: Text;
  before: string;
  after: string;
}

interface Applied {
  el: Element;
  texts: TextEdit[];
}

/** Non-empty text nodes inside an element, in document order. Edits refer to them by index. */
export function textNodesOf(el: Element, limit = 30): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest('script, style, noscript')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n && out.length < limit; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Turns "color: red; font-size: 12px" into declarations that win from the app's own CSS. */
export function importantCss(css: string): string {
  return css
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.includes(':'))
    .map((d) => (/!important\s*$/i.test(d) ? d : `${d} !important`))
    .join('; ');
}

export class Previews {
  #entries = new Map<string, Entry>();
  #applied = new Map<string, Applied>();
  #suspended = false;
  #observer: MutationObserver;
  #scheduled = false;

  constructor() {
    this.#observer = new MutationObserver((records) => {
      this.#release(records);
      if (records.every((r) => isOurs(r.target instanceof Element ? r.target : r.target.parentElement))) return;
      this.#schedule();
    });
    this.#observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  /** Replace all stored previews with the ones of these comments. Drafts stay. */
  setComments(comments: Comment[]): void {
    for (const key of [...this.#entries.keys()]) if (!key.startsWith('draft')) this.#entries.delete(key);
    for (const c of comments) {
      if (!c.change || !c.target) continue;
      const target = c.target;
      this.#entries.set(`c${c.id}`, { key: `c${c.id}`, change: c.change, resolve: () => findTarget(target) });
    }
    this.apply();
  }

  setDraft(el: Element, change: Change): void {
    this.#entries.set('draft', { key: 'draft', change, resolve: () => (el.isConnected ? el : null) });
    this.apply();
  }

  clearDraft(): void {
    this.#entries.delete('draft');
    this.apply();
  }

  /** Turn every preview off for a moment, for example while Claude captures the real result. */
  suspend(on: boolean): void {
    this.#suspended = on;
    this.apply();
  }

  /** Undo every preview and stop watching the page (the extension was reloaded). */
  destroy(): void {
    this.#observer.disconnect();
    this.#suspended = true;
    this.apply();
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    requestAnimationFrame(() => {
      this.#scheduled = false;
      this.apply();
    });
  }

  apply(): void {
    this.#release(this.#observer.takeRecords());
    const wanted = this.#suspended ? [] : [...this.#entries.values()];
    const next = new Map<string, Applied>();
    const rules: string[] = [];
    const ours = new Map<Text, TextEdit>();
    const retained = new Set<Text>();
    for (const a of this.#applied.values()) for (const t of a.texts) ours.set(t.node, t);

    for (const entry of wanted) {
      const el = entry.resolve();
      if (!el) continue;
      const tokens = new Set((el.getAttribute(ATTR) ?? '').split(/\s+/).filter(Boolean));
      if (!tokens.has(entry.key)) {
        tokens.add(entry.key);
        el.setAttribute(ATTR, [...tokens].join(' '));
      }
      const sel = `[${ATTR}~="${entry.key}"]`;
      const applied: Applied = { el, texts: [] };
      if (entry.change.kind === 'remove') {
        rules.push(`${sel} { display: none !important; }`);
      } else {
        const css = importantCss(entry.change.css);
        if (css) rules.push(`${sel} { ${css}; }`);
        applied.texts = this.#applyTexts(el, entry.change.texts, ours);
        for (const t of applied.texts) retained.add(t.node);
      }
      next.set(entry.key, applied);
    }

    // Undo whatever is no longer wanted (or moved to another element).
    for (const [key, old] of this.#applied) {
      const now = next.get(key);
      // A saved edit can take over the draft's text nodes under a different key.
      for (const t of old.texts) if (!retained.has(t.node)) restoreText(t);
      if (now?.el === old.el) continue;
      const tokens = (old.el.getAttribute(ATTR) ?? '').split(/\s+/).filter((t) => t && t !== key);
      if (tokens.length) old.el.setAttribute(ATTR, tokens.join(' '));
      else old.el.removeAttribute(ATTR);
    }
    this.#applied = next;
    this.#writeStyle(rules.join('\n'));
    // Drop the records of our own writes, so they don't count as the app's.
    this.#observer.takeRecords();
  }

  /**
   * The app wrote a text node that shows our edit. If it wrote the edited text
   * itself, the code now does what the edit asked: the node is the app's again,
   * so turning the preview off must not put the old text back.
   */
  #release(records: MutationRecord[]): void {
    for (const r of records) {
      if (r.type !== 'characterData') continue;
      for (const a of this.#applied.values()) {
        a.texts = a.texts.filter((t) => !(t.node === r.target && t.node.nodeValue === t.after));
      }
    }
  }

  /** `ours`: the text nodes our previews changed so far, with what they changed. */
  #applyTexts(el: Element, changes: TextChange[], ours: Map<Text, TextEdit>): TextEdit[] {
    if (!changes.length) return [];
    const nodes = textNodesOf(el, 200);
    const out: TextEdit[] = [];
    for (const ch of changes) {
      const node = nodes[ch.index];
      if (!node) continue;
      // What the app has in the node, seen through a preview we already show.
      const prev = ours.get(node);
      const appText = prev && node.nodeValue === prev.after ? prev.before : node.nodeValue;
      // Only touch the node if the app still has the text the edit started
      // from. If it has something else (the fix itself, say), the code has
      // moved on and the node is not ours to change or restore.
      if (appText !== ch.before) continue;
      if (node.nodeValue !== ch.after) node.nodeValue = ch.after;
      out.push({ node, before: ch.before, after: ch.after });
    }
    return out;
  }

  #writeStyle(css: string): void {
    let style = document.getElementById(STYLE_ID);
    if (!css) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head ?? document.documentElement).appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }
}

function restoreText(t: TextEdit): void {
  if (t.node.nodeValue === t.after) t.node.nodeValue = t.before;
}
