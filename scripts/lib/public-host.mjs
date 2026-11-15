// Which hosts may the scanner follow on its own (redirects, sitemaps, landing host)?
// Only public ones: a redirect must not lead the checker into the local network (SSRF).

import { baseDomain } from './url.mjs';

// Literal inspection only: DNS-based tricks (rebinding, nip.io-style names that resolve to private IPs) are out of scope.
const INTERNAL_NAME = /(^|\.)(localhost|local|internal|localdomain|lan|home|corp|intranet|home\.arpa)$|(^|\.)fritz\.box$/i;

/** @param {number[]} p the four parts of an IPv4 address */
function isPrivateIpv4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}

/** @param {string} host IPv6 address without brackets, as URL normalises it */
function isPrivateIpv6(host) {
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  const embedded = embeddedIpv4(host);
  if (embedded) return isPrivateIpv4(embedded);
  if (/^(::|::1)$/.test(host) || /^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(host)) return true; // unspecified, loopback, IPv4-compatible ::/96
  const first = parseInt(host.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
}

/** The IPv4 address inside a NAT64 (64:ff9b::/96) or 6to4 (2002::/16) address, else null. */
function embeddedIpv4(host) {
  const nat64 = host.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64) return [parseInt(nat64[1], 16) >> 8, parseInt(nat64[1], 16) & 255, parseInt(nat64[2], 16) >> 8, parseInt(nat64[2], 16) & 255];
  const sixToFour = host.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(:|$)/);
  if (sixToFour) return [parseInt(sixToFour[1], 16) >> 8, parseInt(sixToFour[1], 16) & 255, parseInt(sixToFour[2], 16) >> 8, parseInt(sixToFour[2], 16) & 255];
  return null;
}

/**
 * True for a host name or IP that is reachable from the public internet by literal inspection
 * (no DNS lookup): not localhost, not a private, loopback or link-local address, not .local/.internal.
 * @param {string} hostname as in URL.hostname (IPv6 in brackets)
 * @returns {boolean}
 */
export function isPublicHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (host.startsWith('[')) return !isPrivateIpv6(host.slice(1, -1));
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) return !isPrivateIpv4(parts.map(Number));
  return parts.length > 1 && !INTERNAL_NAME.test(host);
}

/**
 * May a redirect from origin to next be followed? The host the user named is always fine; any other
 * target must be public (and, with sameDomain, on the registrable domain of the origin).
 * @param {URL} next
 * @param {URL} origin
 * @param {{allowInternal?: boolean, sameDomain?: boolean}} [options] allowInternal is for tests that serve local hosts
 */
export function redirectAllowed(next, origin, { allowInternal = false, sameDomain = false } = {}) {
  if (!/^https?:$/.test(next.protocol)) return false;
  if (sameDomain && baseDomain(next.hostname) !== baseDomain(origin.hostname)) return false;
  return allowInternal || next.hostname === origin.hostname || isPublicHost(next.hostname);
}
