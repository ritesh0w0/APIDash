// backend/services/ssrfProtection.js
'use strict';

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { URL } = require('url');
const ipaddr = require('ipaddr.js');
const axios = require('axios');
const { AppError } = require('../middleware/errors');

class SsrfValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, details);
    this.name = 'SsrfValidationError';
  }
}

const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'metadata.google.internal',
  'instance-data',
]);

const CLOUD_METADATA_IPS = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
]);

/**
 * Safe test hook: Local test targets (loopback) are ONLY permitted when:
 * 1. NODE_ENV is strictly NOT 'production'
 * 2. APIDASH_ALLOW_LOCAL_TEST_TARGETS === 'true'
 * Under NO circumstances can this be enabled in production.
 * Cloud metadata endpoints remain strictly forbidden in all modes.
 */
function isLocalTestAllowed() {
  return process.env.NODE_ENV !== 'production' && process.env.APIDASH_ALLOW_LOCAL_TEST_TARGETS === 'true';
}

/**
 * Validates the basic syntax of a target URL.
 *
 * @param {string} urlString
 * @returns {URL} parsed URL
 */
function validateUrlSyntax(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    throw new SsrfValidationError('Target URL is required and must be a string');
  }

  let parsed;
  try {
    parsed = new URL(urlString.trim());
  } catch (_err) {
    throw new SsrfValidationError('Target URL is malformed or invalid');
  }

  // Enforce protocol: HTTP and HTTPS only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfValidationError(`Forbidden protocol: "${parsed.protocol}". Only http: and https: are permitted`);
  }

  // Disallow embedded credentials (http://user:pass@host)
  if (parsed.username || parsed.password) {
    throw new SsrfValidationError('Target URL must not contain embedded username or password credentials');
  }

  // Disallow missing or empty hostname
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new SsrfValidationError('Target URL must contain a valid host');
  }

  // Reject known dangerous hostnames immediately
  if (FORBIDDEN_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    if (!isLocalTestAllowed() || hostname === 'metadata.google.internal' || hostname === 'instance-data') {
      throw new SsrfValidationError(`Forbidden host: "${hostname}". Localhost and internal destinations are blocked`);
    }
  }

  return parsed;
}

/**
 * Classifies an IP address string to determine if it is in a private, loopback, or forbidden range.
 *
 * @param {string} ipString
 * @returns {{ safe: boolean, reason: string | null }}
 */
function isForbiddenIp(ipString) {
  let addr;
  try {
    addr = ipaddr.parse(ipString);
  } catch (_err) {
    return { safe: false, reason: `Malformed IP address: ${ipString}` };
  }

  // If IPv4-mapped IPv6 address (e.g. ::ffff:127.0.0.1), unmap to IPv4
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }

  const range = addr.range();

  // Check against cloud metadata IPs
  if (CLOUD_METADATA_IPS.has(addr.toString())) {
    return { safe: false, reason: 'Destination is a cloud metadata address' };
  }

  // Allowed public unicast range only
  const forbiddenRanges = [
    'loopback',
    'private',
    'linkLocal',
    'uniqueLocal',
    'carrierGradeNat',
    'unspecified',
    'broadcast',
    'multicast',
    'reserved',
  ];

  if (forbiddenRanges.includes(range)) {
    if (isLocalTestAllowed() && range === 'loopback') {
      // Loopback explicitly permitted for controlled local tests
    } else {
      return { safe: false, reason: `Destination IP is in forbidden range: ${range} (${addr.toString()})` };
    }
  }

  // Extra check for 127.0.0.0/8 and 0.0.0.0
  const ipStr = addr.toString();
  if (ipStr.startsWith('127.') || ipStr === '0.0.0.0') {
    if (isLocalTestAllowed() && ipStr.startsWith('127.')) {
      // Loopback explicitly permitted for controlled local tests
    } else {
      return { safe: false, reason: `Destination IP is in forbidden range: loopback/unspecified (${ipStr})` };
    }
  }

  return { safe: true, reason: null };
}

/**
 * Resolves a hostname and verifies all returned DNS records are safe public IP addresses.
 *
 * @param {string} hostname
 * @param {typeof dns.lookup} [dnsLookupFn]
 * @returns {Promise<{ approvedIp: string, approvedFamily: number }>}
 */
async function resolveAndValidateDestination(hostname, dnsLookupFn = dns.lookup) {
  // If hostname is an IPv6 literal enclosed in brackets (e.g. [::1]), strip brackets
  const cleanHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  // If hostname is already an IP address, check directly
  if (ipaddr.isValid(cleanHost)) {
    const check = isForbiddenIp(cleanHost);
    if (!check.safe) {
      throw new SsrfValidationError(check.reason);
    }
    const parsedIp = ipaddr.parse(cleanHost);
    return {
      approvedIp: parsedIp.toString(),
      approvedFamily: parsedIp.kind() === 'ipv6' ? 6 : 4,
    };
  }

  let records;
  try {
    records = await dnsLookupFn(hostname, { all: true });
  } catch (err) {
    throw new SsrfValidationError(`DNS resolution failed for host "${hostname}": ${err.message}`);
  }

  if (!records || records.length === 0) {
    throw new SsrfValidationError(`No DNS records found for host "${hostname}"`);
  }

  // Inspect all resolved IP addresses: if ANY is forbidden, reject the entire hostname
  for (const record of records) {
    const check = isForbiddenIp(record.address);
    if (!check.safe) {
      throw new SsrfValidationError(
        `Host "${hostname}" resolved to unsafe address ${record.address}: ${check.reason}`
      );
    }
  }

  // Select the first approved record
  const selected = records[0];
  return {
    approvedIp: selected.address,
    approvedFamily: selected.family,
  };
}

/**
 * Creates custom HTTP and HTTPS agents with connection pinning to prevent DNS rebinding.
 * Supports both lookup(host, options, cb) and lookup(host, cb) calling conventions.
 *
 * @param {string} approvedIp
 * @param {number} approvedFamily
 */
function createPinnedAgents(approvedIp, approvedFamily) {
  const customLookup = (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options !== null ? options : {};
    if (opts.all) {
      return cb(null, [{ address: approvedIp, family: approvedFamily }]);
    }
    return cb(null, approvedIp, approvedFamily);
  };

  const httpAgent = new http.Agent({ lookup: customLookup, keepAlive: false });
  const httpsAgent = new https.Agent({ lookup: customLookup, keepAlive: false });

  return { httpAgent, httpsAgent };
}

/**
 * Executes an HTTP monitoring request with full SSRF destination validation,
 * connection pinning, manual redirect validation, and resource bounds.
 *
 * @param {Object} options
 * @param {string} options.url
 * @param {string} [options.method='GET']
 * @param {number} [options.timeout=10000]
 * @param {number} [options.maxRedirects=3]
 * @param {number} [options.maxBodyBytes=1048576]
 * @param {Object} [deps]
 * @param {typeof dns.lookup} [deps.dnsLookupFn]
 * @param {typeof axios} [deps.httpClient]
 */
async function safeMonitoringRequest(options, deps = {}) {
  const dnsLookupFn = deps.dnsLookupFn || dns.lookup;
  const client = deps.httpClient || axios;
  const maxRedirects = Number(options.maxRedirects !== undefined ? options.maxRedirects : 3);
  const timeout = Number(options.timeout || 10000);
  const maxBodyBytes = Number(options.maxBodyBytes || 1048576); // 1 MB default
  const method = (options.method || 'GET').toLowerCase();

  let currentUrl = options.url;
  let redirectsCount = 0;

  while (true) {
    const parsedUrl = validateUrlSyntax(currentUrl);

    // Resolve DNS and validate destination addresses
    const { approvedIp, approvedFamily } = await resolveAndValidateDestination(parsedUrl.hostname, dnsLookupFn);

    // Create pinned agents enforcing the approved IP at socket connect time
    const { httpAgent, httpsAgent } = createPinnedAgents(approvedIp, approvedFamily);

    let response;
    try {
      const requestHeaders = { ...(options.headers || {}) };
      // Pinned Host header overrides any caller-supplied Host header to prevent host spoofing
      requestHeaders['Host'] = parsedUrl.host;

      response = await client({
        method,
        url: currentUrl,
        timeout,
        maxRedirects: 0, // Disable automatic redirects
        validateStatus: () => true, // Don't throw on non-2xx status
        maxContentLength: maxBodyBytes,
        maxBodyLength: maxBodyBytes,
        httpAgent,
        httpsAgent,
        proxy: false, // CRITICAL: Disable uncontrolled environment proxy routing
        headers: requestHeaders,
        data: options.body !== undefined ? options.body : options.data,
      });
    } catch (err) {
      if (err instanceof SsrfValidationError) {
        throw err;
      }
      throw err;
    }

    // Check for HTTP redirect response (301, 302, 303, 307, 308)
    const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && response.headers && response.headers.location;

    if (isRedirect) {
      if (redirectsCount >= maxRedirects) {
        throw new SsrfValidationError(`Maximum redirect limit of ${maxRedirects} exceeded`);
      }

      redirectsCount++;
      const nextLocation = response.headers.location;
      const nextUrl = new URL(nextLocation, currentUrl).toString();

      // Enforce protocol downgrade prevention: HTTPS -> HTTP disallowed
      if (currentUrl.startsWith('https://') && nextUrl.startsWith('http://')) {
        throw new SsrfValidationError('Insecure redirect downgrade from HTTPS to HTTP is forbidden');
      }

      currentUrl = nextUrl;
      continue;
    }

    return response;
  }
}

module.exports = {
  validateUrlSyntax,
  isForbiddenIp,
  resolveAndValidateDestination,
  createPinnedAgents,
  safeMonitoringRequest,
  SsrfValidationError,
};
