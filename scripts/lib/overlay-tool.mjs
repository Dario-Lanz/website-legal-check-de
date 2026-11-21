// Runs inside the browser page (passed to locator.evaluate on the detected consent banner). Must be self-contained:
// no imports, no closures over module variables. One entry point with three operations so that "which elements belong
// to the overlay" is decided in one place: measure (which legal links does it cover) and hide (CSS visibility
// only; nothing is clicked).

/* global document, window, getComputedStyle */
/**
 * @param {Element} banner the detected consent dialog (marked data-wlc-banner)
 * @param {{op: 'measure'|'hide'|'box', sources?: string[], kinds?: string[]}} args
 */
export function overlayTool(banner, args) {
  const CONSENT_NAME = /cookie|consent|brlbs|cmplz|usercentrics|onetrust|cookiebot|didomi|backdrop|overlay|dimmer/i;
  const MEDIA = 'a, button, input, img, picture, video, canvas, svg, iframe, object, embed';

  function alphaOf(color) {
    if (!/^rgba?\(/.test(color)) return color === 'transparent' ? 0 : 1;
    const parts = color.slice(color.indexOf('(') + 1, -1).split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    return parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  }

  /** An empty full-screen layer behind the dialog: semi-transparent, darkened by opacity or named like a consent tool part; never content. */
  function isBackdrop(el) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const fullScreen = rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9;
    if (!['fixed', 'absolute'].includes(style.position) || !fullScreen) return false;
    if (el.innerText.trim() !== '' || el.querySelector(MEDIA) || style.backgroundImage !== 'none') return false;
    const alpha = alphaOf(style.backgroundColor);
    const dimmed = alpha === 1 && parseFloat(style.opacity) < 1; // opaque (dark) colour made see-through by opacity
    return (alpha > 0 && alpha < 1) || dimmed || CONSENT_NAME.test(`${el.id} ${String(el.className?.baseVal ?? el.className)}`);
  }

  const overlayElements = () => [banner, ...[...(banner.parentElement?.children ?? [])].filter((el) => el !== banner && isBackdrop(el))];

  const nextFrames = () => new Promise((resolve) => {
    const timer = setTimeout(resolve, 200); // a page without animation frames must not block the measurement
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
  const inView = (rect) => rect.left + rect.width / 2 >= 0 && rect.top + rect.height / 2 >= 0
    && rect.left + rect.width / 2 <= window.innerWidth && rect.top + rect.height / 2 <= window.innerHeight;
  // "instant": a page with scroll-behavior: smooth would otherwise still be moving when the link is measured.
  // Inner scroll containers that the measurement scrolls are put back by restoreOverlay.
  function rememberScroll(el) {
    window.__wlcScroll ??= new Map();
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight && !window.__wlcScroll.has(n)) window.__wlcScroll.set(n, n.scrollTop);
    }
  }
  const scrollTo = (el, block) => { rememberScroll(el); el.scrollIntoView({ block, behavior: 'instant' }); };

  /** Bring the link into the view (footer end first, then the link itself), return whether the overlay is on top of it. */
  async function coverOf(a, overlay, hosts) {
    const parentOf = (node) => node.parentNode ?? node.host ?? null;
    const within = (node, ancestor) => { for (let n = node; n; n = parentOf(n)) if (n === ancestor) return true; return false; };
    for (const block of ['end', 'nearest', 'center']) {
      let rect = a.getBoundingClientRect();
      if (!inView(rect)) {
        scrollTo(a, block);
        await nextFrames();
        rect = a.getBoundingClientRect();
      }
      if (!inView(rect)) continue;
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const real = top && top !== document.body && top !== document.documentElement;
      return Boolean(real && (overlay.some((el) => within(top, el)) || hosts.includes(top)));
    }
    return null; // never brought into the view (e.g. a scroll lock)
  }

  async function measure() {
    const patterns = args.sources.map((source) => new RegExp(source, 'i'));
    const decode = (text) => { try { return decodeURIComponent(text); } catch { return text; } };
    const footer = [...document.querySelectorAll('footer, [role="contentinfo"]')].at(-1);
    if (!footer) return { footerLegalLinks: 0, covered: 0, notInView: 0, links: [] };
    scrollTo(footer, 'end'); // the state the footer photo shows
    await nextFrames();
    const overlay = overlayElements();
    const hosts = [];
    for (let n = banner.getRootNode(); n && n.host; n = n.host.getRootNode()) hosts.push(n.host);
    const kindOf = (a) => args.kinds[patterns.findIndex((p) => p.test(a.textContent) || p.test(decode(a.pathname)))];
    const anchors = [...footer.querySelectorAll('a[href]')].filter((a) => kindOf(a) !== undefined && a.getBoundingClientRect().width > 0 && a.getBoundingClientRect().height > 0);
    const links = [];
    for (const a of anchors) {
      const covered = await coverOf(a, overlay, hosts);
      links.push({ text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 80), href: a.href.slice(0, 300), kind: kindOf(a), covered });
    }
    return { footerLegalLinks: links.length, covered: links.filter((l) => l.covered).length, notInView: links.filter((l) => l.covered === null).length, links };
  }

  function hide() {
    const hidden = [];
    window.__wlcHidden = hidden; // set first: a failure half way can still be restored
    for (const el of overlayElements()) {
      hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
      el.style.setProperty('visibility', 'hidden', 'important');
    }
    return hidden.length;
  }

  /** Union of the visible boxes in the dialog, for a wrapper without own height; null when nothing is visible. */
  function box() {
    const rects = [banner, ...banner.querySelectorAll('*')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return null;
    const left = Math.max(0, Math.min(...rects.map((r) => r.left)));
    const top = Math.max(0, Math.min(...rects.map((r) => r.top)));
    const right = Math.min(window.innerWidth, Math.max(...rects.map((r) => r.right)));
    const bottom = Math.min(window.innerHeight, Math.max(...rects.map((r) => r.bottom)));
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }

  return { measure, hide, box }[args.op]();
}

/**
 * Runs in the page (page.evaluate, no banner needed): give back the elements `hide` changed. An element that has left the
 * page (a dialog that removed itself) needs nothing. restoredVisible is false when a remaining element is still hidden.
 */
export function restoreOverlay() {
  const hidden = window.__wlcHidden ?? [];
  for (const [el, value, priority] of hidden) {
    if (!el.isConnected) continue;
    if (value) el.style.setProperty('visibility', value, priority);
    else el.style.removeProperty('visibility');
  }
  delete window.__wlcHidden;
  for (const [container, top] of window.__wlcScroll ?? []) container.scrollTo({ top, behavior: 'instant' });
  delete window.__wlcScroll;
  return { restored: hidden.length, restoredVisible: hidden.every(([el]) => !el.isConnected || getComputedStyle(el).visibility !== 'hidden') };
}
