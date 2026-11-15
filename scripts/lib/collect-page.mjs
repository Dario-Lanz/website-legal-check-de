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
  function findBanner() {
    for (const selector of BANNER_SELECTORS) {
      const chosen = chooseBanner(queryAllDeep(selector).filter(isVisible).map(bannerCandidate).filter(Boolean));
      if (!chosen) continue;
      chosen.el.setAttribute('data-wlc-banner', '1');
      return { selector, text: chosen.text, buttons: chosen.buttons };
    }
    return null;
  }

  const banner = findBanner();

  const prices = collectPrices();
  function collectPrices() {
    const pattern = /\d{1,3}(?:[.\s]\d{3})*(?:,\d{2}|,-)?\s?(€|EUR)|(€|EUR)\s?\d/g;
    // Amounts of share capital and fines are no offer prices ("Stammkapital: 25.000 €", "bis zu 20.000.000 EUR").
    const notAPrice = /(stammkapital|grundkapital|bußgeld\w*|bis zu)[^\d€]{0,25}$/i;
    const hasPrice = (text) => [...text.matchAll(pattern)].some((m) => !notAPrice.test(text.slice(Math.max(0, m.index - 40), m.index)));
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && found.length < LIMITS.prices) {
      const node = walker.currentNode;
      if (!hasPrice(node.nodeValue)) continue;
      const block = node.parentElement?.closest('li, article, tr, section, div, p') ?? node.parentElement;
      if (!block || !isVisible(node.parentElement)) continue;
      found.push({ text: clean(node.nodeValue, 60), context: clean(block.innerText, 240) });
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
