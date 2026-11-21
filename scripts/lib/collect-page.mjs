// Runs inside the browser page (passed to page.evaluate). Must be self-contained:
// no imports, no closures over module variables. Collects facts only, judges nothing.

/* global document, window, NodeFilter */
export function collectPageFacts() {
  const LIMITS = { text: 30000, footer: 3000, linkText: 120, prices: 30, banner: 800, asyncLoad: 20000, legalText: 200000 };
  // Imprints and privacy policies are read in full for the content checks (IMP-04, DSE-02, DSE-03).
  const LEGAL_PAGE = /impressum|imprint|anbieterkennzeichnung|legal-notice|datenschutz|privacy|dsgvo|gdpr/i;
  const REGION_SELECTOR = 'header, footer, nav, [role="banner"], [role="contentinfo"], [role="navigation"]';
  // Named consent tools first, then generic name patterns; generic matches must prove to be a dialog (see findBanner).
  const BANNER_SELECTORS = [
    '#CybotCookiebotDialog', '#onetrust-banner-sdk', '#usercentrics-root', '#usercentrics-cmp-ui',
    '.cmplz-cookiebanner', '#BorlabsCookieBox', '#cookie-law-info-bar', '#cookie-notice',
    '#didomi-host', '#qc-cmp2-container', '#iubenda-cs-banner', '.cky-consent-container', '#cmpbox', '#cmpwrapper', '.klaro',
    '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
    '[aria-modal="true"]', '[role="dialog"]', '[role="alertdialog"]',
  ];
  const BANNER_TEXT = /cookie|einwillig|zustimm|consent|datenschutz|tracking|akzept|accept/i;
  // A consent dialog offers at least one choice: accept, reject or settings.
  const CHOICE_LABEL = /akzept|accept|ablehn|reject|decline|deny|refuse|verweiger|zustimm|einwillig|einverstanden|erlauben|zulassen|allow|einstellung|settings|anpassen|customi[sz]e|auswahl|speichern|save|preferences|notwendig|necessary|essen[tz]|verstanden|got it|agree|\bok\b/i;
  const BANNER_CONTROLS = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
  const clean = (text, max) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const regionOf = (el) => {
    const region = el.closest(REGION_SELECTOR);
    if (region) {
      const tag = region.tagName.toLowerCase();
      const role = region.getAttribute('role');
      if (tag === 'footer' || role === 'contentinfo') return 'footer';
      if (tag === 'header' || role === 'banner') return 'header';
      return 'nav';
    }
    const named = el.closest('[id*="footer" i], [class*="footer" i]');
    return named ? 'footer' : 'main';
  };
  const labelOf = (el) => clean(el.innerText || el.value || el.getAttribute('aria-label') || el.title, LIMITS.linkText);

  // Elements inside open shadow roots (many consent tools render there).
  const allRoots = () => {
    const roots = [document];
    for (let i = 0; i < roots.length; i += 1) {
      roots[i].querySelectorAll('*').forEach((el) => { if (el.shadowRoot) roots.push(el.shadowRoot); });
    }
    return roots;
  };
  const queryAllDeep = (selector) => allRoots().flatMap((root) => [...root.querySelectorAll(selector)]);

  const links = [...document.querySelectorAll('a[href]')].map((a) => ({
    href: a.href, text: labelOf(a), region: regionOf(a), visible: isVisible(a),
  }));

  const buttons = queryAllDeep('button, input[type="submit"], input[type="button"], [role="button"]')
    .map((el) => ({ text: labelOf(el), visible: isVisible(el), region: el.closest ? regionOf(el) : 'main' }))
    .filter((b) => b.text);

  const forms = [...document.querySelectorAll('form')].map((form) => ({
    action: form.action || '',
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    hasEmail: !!form.querySelector('input[type="email"], input[name*="mail" i]'),
    hasPassword: !!form.querySelector('input[type="password"]'),
    hasTextarea: !!form.querySelector('textarea'),
    hasFile: !!form.querySelector('input[type="file"]'),
    text: clean(form.innerText, 300),
  }));

  const iframes = [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src || '', visible: isVisible(f) }));

  // The page itself (html, body, main) or a wrapper around nearly all of it is no dialog; a fixed or sticky box is.
  function isPageWrapper(el) {
    if (el === document.documentElement || el === document.body || el.tagName === 'MAIN') return true;
    const position = window.getComputedStyle(el).position;
    if (position === 'fixed' || position === 'sticky') return false;
    const rect = el.getBoundingClientRect();
    const pageHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    return rect.height >= pageHeight * 0.8 && rect.width >= document.documentElement.clientWidth * 0.8;
  }
  function controlsOf(el) {
    const scopes = el.shadowRoot ? [el, el.shadowRoot] : [el];
    return scopes.flatMap((scope) => [...scope.querySelectorAll(BANNER_CONTROLS)]).filter(isVisible).map(labelOf).filter(Boolean);
  }
  function bannerCandidate(el) {
    if (isPageWrapper(el)) return null;
    const text = clean(el.innerText || el.textContent, LIMITS.banner);
    if (!BANNER_TEXT.test(text)) return null;
    const buttons = controlsOf(el);
    if (!buttons.some((label) => CHOICE_LABEL.test(label))) return null;
    const message = buttons.reduce((rest, label) => rest.replace(label, ''), text).trim();
    return { el, text, buttons, hasMessage: message.length > 0 };
  }
  // Outermost box that is no page wrapper (the choice buttons may sit in a sibling of the message);
  // go inward only into a box that still has the message and every choice control of the outer one.
  function chooseBanner(found) {
    let chosen = found.find((c) => !found.some((o) => o !== c && o.el.contains(c.el)));
    if (!chosen) return null;
    const keepsAll = (inner) => inner.hasMessage && chosen.buttons.every((label) => inner.buttons.includes(label));
    for (;;) {
      const inner = found.find((c) => c !== chosen && chosen.el.contains(c.el) && keepsAll(c));
      if (!inner) return chosen;
      chosen = inner;
    }
  }
  // The matched element can be an inner text block of the dialog (Borlabs: [id*="cookie"] inside the box). The evidence
  // photos, the hiding and the overlap measurement need the whole dialog: climb through positioned (fixed, sticky,
  // absolute) or consent-tool-named ancestors, but only while the ancestor is still the dialog: its text is at most about
  // 1.5 times the dialog's text, it has few links outside the dialog (a menu is no dialog), it holds no main, header,
  // footer or nav, and it is no page wrapper covering the document. Consent-tool-named ancestors skip the text and link tests.
  const CONSENT_ROOT = /brlbs|borlabs|cmplz|cookiebot|onetrust|usercentrics|didomi|qc-cmp|iubenda|cky-|klaro|cmpbox|cmpwrapper|cookie-law|cookie-notice/i;
  const MAX_TEXT_RATIO = 1.5;
  const MAX_OUTSIDE_LINKS = 5;
  const textOf = (el) => clean(el.innerText || el.textContent, 1_000_000).length;
  function isStillDialog(n, el, own, docArea) {
    const style = window.getComputedStyle(n);
    const rect = n.getBoundingClientRect();
    const wholePage = style.position !== 'fixed' && rect.width * rect.height >= 0.9 * docArea;
    const outsideLinks = [...n.querySelectorAll('a[href]')].filter((a) => !el.contains(a)).length;
    return !wholePage && outsideLinks <= MAX_OUTSIDE_LINKS && textOf(n) <= own * MAX_TEXT_RATIO + 40;
  }
  function outermostConsentContainer(el) {
    const own = textOf(el);
    const docArea = document.documentElement.clientWidth * Math.max(document.documentElement.scrollHeight, window.innerHeight);
    let best = el;
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.matches('main, header, footer, nav') || n.querySelector('main, header, footer, nav')) break;
      const named = CONSENT_ROOT.test(`${n.id} ${String(n.className?.baseVal ?? n.className)}`);
      if (!named && !isStillDialog(n, el, own, docArea)) break;
      if (named || ['fixed', 'sticky', 'absolute'].includes(window.getComputedStyle(n).position)) best = n;
    }
    return best;
  }
  // A wrapper without own height (Borlabs renders the box through positioned children) is a visible dialog only when
  // a descendant is really on screen: positioned (fixed/absolute) and not clipped by a collapsed ancestor, or hit by
  // elementFromPoint at its centre. A max-height: 0 settings block with cookie text is not (its content is clipped).
  function clippedByCollapsedAncestor(d, root) {
    for (let n = d.parentElement; n; n = n.parentElement) {
      const style = window.getComputedStyle(n);
      const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
      const rect = n.getBoundingClientRect();
      if (clips && (rect.height < 4 || rect.width < 4)) return true;
      if (n === root) break;
    }
    return false;
  }
  function isOnScreen(d, root) {
    if (!isVisible(d)) return false;
    if (['fixed', 'absolute'].includes(window.getComputedStyle(d).position)) return !clippedByCollapsedAncestor(d, root);
    const rect = d.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit) && (hit === d || d.contains(hit));
  }
  function hasVisibleBox(el) {
    if (isVisible(el)) return true;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && [...el.querySelectorAll('*')].some((d) => isOnScreen(d, el));
  }
  function findBanner() {
    for (const selector of BANNER_SELECTORS) {
      const chosen = chooseBanner(queryAllDeep(selector).filter(hasVisibleBox).map(bannerCandidate).filter(Boolean));
      if (!chosen) continue;
      outermostConsentContainer(chosen.el).setAttribute('data-wlc-banner', '1');
      return { selector, text: chosen.text, buttons: chosen.buttons };
    }
    return null;
  }

  const banner = findBanner();

  const prices = collectPrices();
  /** Inside content-visibility: hidden nothing is rendered (keeeper: lazy sections), so there is no price on the page. */
  function isSkippedContent(el) {
    for (let n = el; n; n = n.parentElement) if (window.getComputedStyle(n).contentVisibility === 'hidden') return true;
    return false;
  }
  function collectPrices() {
    // „Euro“ spelled out counts; "Europa", "Europäer" do not (no letter, and no hyphen with a letter, may follow the currency word: "Euro-Paletten").
    const pattern = /\d{1,3}(?:[.\s]\d{3})*(?:,\d{2}|,-)?\s?(?:€|(?:EURO?|[Ee]uro)(?![\p{L}]|-\p{L}))|(?:€|EUR)\s?\d/gu;
    // Amounts of share capital and fines are no offer prices ("Stammkapital: 25.000 €", "bis zu 20.000.000 EUR").
    const notAPrice = /(stammkapital|grundkapital|bußgeld\w*|bis zu)[^\d€]{0,25}$/i;
    const hasPrice = (text) => [...text.matchAll(pattern)].some((m) => !notAPrice.test(text.slice(Math.max(0, m.index - 40), m.index)));
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && found.length < LIMITS.prices) {
      const node = walker.currentNode;
      if (!hasPrice(node.nodeValue)) continue;
      const block = node.parentElement?.closest('li, article, tr, section, div, p') ?? node.parentElement;
      if (!block || !isVisible(node.parentElement) || isSkippedContent(node.parentElement)) continue;
      // innerText is empty for content-visibility: auto sections that were not scrolled into view yet: textContent then.
      const text = clean(node.nodeValue, 60);
      const context = clean(block.innerText || block.textContent, 240);
      if (text && context) found.push({ text, context });
    }
    return found;
  }

  const footers = [...document.querySelectorAll('footer, [role="contentinfo"]')];
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;

  const htmlClasses = clean(`${document.documentElement.className} ${document.body?.className ?? ''}`, 600);
  const htmlDataAttributes = [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-'));

  // Shopify script tags are listed in an inline asyncLoad function (checks/script-tags.mjs).
  const asyncLoadScript = [...document.scripts].find((s) => !s.src && s.text.includes('function asyncLoad'))
    ?.text.slice(0, LIMITS.asyncLoad) ?? null;

  return {
    title: clean(document.title, 200),
    generator: meta('generator'),
    htmlClasses, htmlDataAttributes,
    lang: document.documentElement.getAttribute('lang'),
    viewport: meta('viewport'),
    hasFooterElement: footers.length > 0,
    footerText: clean(footers.map((f) => f.innerText).join(' '), LIMITS.footer),
    bodyText: clean(document.body?.innerText,
      LEGAL_PAGE.test(`${window.location.pathname} ${document.title}`) ? LIMITS.legalText : LIMITS.text),
    links, buttons, forms, iframes, banner, prices, asyncLoadScript,
  };
}
