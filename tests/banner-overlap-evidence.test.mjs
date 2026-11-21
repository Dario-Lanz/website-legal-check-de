// Fix 7: IMP-01/DSE-01 findings carry whether the consent banner covered the footer legal links.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLegalPages } from '../scripts/lib/checks/legal-pages.mjs';

const page = (index, bannerOverlap) => ({
  index, url: `https://x.de/p${index}`, finalUrl: `https://x.de/p${index}`, status: 200, pageType: 'other', bannerOverlap,
  screenshots: { ansicht: `belege/seite-0${index}-ansicht.jpg` },
  facts: { title: '', links: [], buttons: [], forms: [], prices: [], banner: null, bodyText: '', footerText: '' },
});
const scanOf = (pages) => ({ startUrl: 'https://x.de/', pages, requests: [], cookies: [], transport: {} });
const run = (check, pages) => checkLegalPages(scanOf(pages)).filter((f) => f.check === check && f.status === 'gap');

test('IMP-01 and DSE-01 gaps name per page whether the banner covered the footer legal links', () => {
  const pages = [
    page(1, { footerLegalLinks: 2, covered: 2, links: [{ text: 'Impressum', kind: 'imprint', covered: true }, { text: 'Datenschutz', kind: 'privacy', covered: true }] }),
    page(2, { footerLegalLinks: 0, covered: 0, links: [] }),
    page(3, null),
  ];
  for (const check of ['IMP-01', 'DSE-01']) {
    const [gap] = run(check, pages);
    assert.deepEqual(gap.evidence.bannerOverlap, [
      { page: 'https://x.de/p1', footerLegalLinks: 1, covered: 1, notInView: 0 },
      { page: 'https://x.de/p2', footerLegalLinks: 0, covered: 0, notInView: 0 },
    ], 'counted for the link kind of the check');
  }
});

test('no banner anywhere: no overlap evidence', () => {
  const [gap] = run('IMP-01', [page(1, null)]);
  assert.equal('bannerOverlap' in gap.evidence, false);
});
