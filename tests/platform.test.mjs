// Detecting the system a site is built with, so fix instructions can be tailored.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPlatform } from '../scripts/lib/platform.mjs';

const scan = ({ generator = null, classes = '', dataAttrs = [], requests = [] } = {}) => ({
  host: 'example.de',
  pages: [{ facts: { generator, htmlClasses: classes, htmlDataAttributes: dataAttrs } }],
  requests: requests.map((url) => ({ url })),
});

test('WordPress with WooCommerce and Divi', () => {
  const result = detectPlatform(scan({
    generator: 'WordPress 6.8', classes: 'home woocommerce et_divi_theme',
    requests: ['https://example.de/wp-content/themes/Divi/style.css', 'https://example.de/wp-content/plugins/woocommerce/x.js'],
  }));
  assert.equal(result.name, 'WordPress');
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.extras, ['WooCommerce', 'Divi']);
});

test('hosted builders are recognised by their asset hosts or generator', () => {
  assert.equal(detectPlatform(scan({ requests: ['https://cdn.shopify.com/s/files/1/x.css'] })).name, 'Shopify');
  assert.equal(detectPlatform(scan({ requests: ['https://static.wixstatic.com/media/x.jpg'] })).name, 'Wix');
  assert.equal(detectPlatform(scan({ generator: 'Webflow', dataAttrs: ['data-wf-site'] })).name, 'Webflow');
  assert.equal(detectPlatform(scan({ generator: 'TYPO3 CMS' })).name, 'TYPO3');
  assert.equal(detectPlatform(scan({ requests: ['https://static1.squarespace.com/static/x.js'] })).name, 'Squarespace');
  assert.equal(detectPlatform(scan({ requests: ['https://assets.jimstatic.com/x.css'] })).name, 'Jimdo');
  assert.equal(detectPlatform(scan({ requests: ['https://example.de/bundles/storefront/x.js'] })).name, 'Shopware');
});

test('unknown when no signal is found', () => {
  assert.deepEqual(detectPlatform(scan()), { name: null, confidence: 'none', evidence: [], extras: [] });
});

test('Framer is recognised by its generator or asset hosts (observed on a real site)', () => {
  const byGenerator = detectPlatform(scan({ generator: 'Framer c9b3949' }));
  assert.equal(byGenerator.name, 'Framer');
  assert.equal(byGenerator.confidence, 'medium');
  const both = detectPlatform(scan({ generator: 'Framer c9b3949', requests: ['https://framerusercontent.com/images/x.png', 'https://app.framerstatic.com/x.js'] }));
  assert.equal(both.name, 'Framer');
  assert.equal(both.confidence, 'high');
  assert.equal(detectPlatform(scan({ requests: ['https://framerusercontent.com/sites/x.mjs'] })).name, 'Framer');
  assert.equal(detectPlatform(scan({ requests: ['https://example.de/framerusercontent.com.html'] })).name, null);
});
