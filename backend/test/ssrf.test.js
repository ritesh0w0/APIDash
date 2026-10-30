// backend/test/ssrf.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateUrlSyntax,
  isForbiddenIp,
  resolveAndValidateDestination,
  createPinnedAgents,
  safeMonitoringRequest,
  SsrfValidationError,
} = require('../services/ssrfProtection');

test('validateUrlSyntax permits valid http and https URLs and normalizes hostname', () => {
  const url1 = validateUrlSyntax('https://api.example.com/v1/health');
  assert.equal(url1.protocol, 'https:');
  assert.equal(url1.hostname, 'api.example.com');

  const url2 = validateUrlSyntax('http://example.org:8080/status?test=1');
  assert.equal(url2.protocol, 'http:');
  assert.equal(url2.port, '8080');
});

test('validateUrlSyntax rejects non-http schemes, malformed URLs, and embedded credentials', () => {
  // Disallowed schemes
  assert.throws(() => validateUrlSyntax('ftp://files.example.com'), SsrfValidationError);
  assert.throws(() => validateUrlSyntax('file:///etc/passwd'), SsrfValidationError);
  assert.throws(() => validateUrlSyntax('gopher://gopher.floodgap.com'), SsrfValidationError);
  assert.throws(() => validateUrlSyntax('javascript:alert(1)'), SsrfValidationError);

  // Embedded credentials
  assert.throws(() => validateUrlSyntax('http://admin:secret@api.example.com'), SsrfValidationError);
  assert.throws(() => validateUrlSyntax('https://user@example.com'), SsrfValidationError);

  // Localhost aliases and .local domains
  assert.throws(() => validateUrlSyntax('http://localhost:3000'), SsrfValidationError);
  assert.throws(() => validateUrlSyntax('http://foo.localhost'), SsrfValidationError);
  assert.throws(() => validateUrlSyntax('http://printer.local'), SsrfValidationError);
  assert.throws(() => validateUrlSyntax('http://metadata.google.internal'), SsrfValidationError);
});

test('isForbiddenIp rejects IPv4 loopback, private, carrier-grade NAT, and cloud metadata', () => {
  // Loopback (127.0.0.0/8)
  assert.equal(isForbiddenIp('127.0.0.1').safe, false);
  assert.equal(isForbiddenIp('127.0.0.2').safe, false);
  assert.equal(isForbiddenIp('127.255.255.255').safe, false);

  // Private RFC 1918
  assert.equal(isForbiddenIp('10.0.0.1').safe, false);
  assert.equal(isForbiddenIp('10.254.0.1').safe, false);
  assert.equal(isForbiddenIp('172.16.0.1').safe, false);
  assert.equal(isForbiddenIp('172.31.255.255').safe, false);
  assert.equal(isForbiddenIp('192.168.1.1').safe, false);
  assert.equal(isForbiddenIp('192.168.0.254').safe, false);

  // Cloud metadata and link-local (169.254.0.0/16)
  assert.equal(isForbiddenIp('169.254.169.254').safe, false);
  assert.equal(isForbiddenIp('169.254.1.1').safe, false);

  // Unspecified & broadcast
  assert.equal(isForbiddenIp('0.0.0.0').safe, false);
  assert.equal(isForbiddenIp('255.255.255.255').safe, false);

  // Public IP is allowed
  assert.equal(isForbiddenIp('93.184.216.34').safe, true);
  assert.equal(isForbiddenIp('8.8.8.8').safe, true);
  assert.equal(isForbiddenIp('1.1.1.1').safe, true);
});

test('isForbiddenIp rejects IPv6 loopback, link-local, unique-local, and IPv4-mapped IPv6', () => {
  // IPv6 loopback
  assert.equal(isForbiddenIp('::1').safe, false);
  assert.equal(isForbiddenIp('0:0:0:0:0:0:0:1').safe, false);

  // IPv6 link-local (fe80::/10)
  assert.equal(isForbiddenIp('fe80::1').safe, false);

  // IPv6 unique-local (fc00::/7)
  assert.equal(isForbiddenIp('fc00::1').safe, false);
  assert.equal(isForbiddenIp('fd00:ec2::254').safe, false); // AWS IPv6 metadata

  // IPv4-mapped IPv6 representation of forbidden addresses
  assert.equal(isForbiddenIp('::ffff:127.0.0.1').safe, false);
  assert.equal(isForbiddenIp('::ffff:169.254.169.254').safe, false);
  assert.equal(isForbiddenIp('::ffff:10.0.0.1').safe, false);
  assert.equal(isForbiddenIp('::ffff:192.168.1.1').safe, false);

  // Public IPv6 unicast is allowed
  assert.equal(isForbiddenIp('2606:4700:4700::1111').safe, true);
});

test('resolveAndValidateDestination rejects hostnames with mixed or forbidden DNS records', async () => {
  // Mock DNS resolver returning a forbidden address
  const mockDnsPrivate = async () => [{ address: '10.0.0.1', family: 4 }];
  await assert.rejects(
    () => resolveAndValidateDestination('internal-service.example.com', mockDnsPrivate),
    SsrfValidationError
  );

  // Mock DNS resolver returning mixed public and private answers (rebinding / multi-homing attempt)
  const mockDnsMixed = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(
    () => resolveAndValidateDestination('mixed.example.com', mockDnsMixed),
    SsrfValidationError
  );

  // Mock DNS resolver returning safe public addresses
  const mockDnsPublic = async () => [
    { address: '93.184.216.34', family: 4 },
  ];
  const validated = await resolveAndValidateDestination('public.example.com', mockDnsPublic);
  assert.equal(validated.approvedIp, '93.184.216.34');
  assert.equal(validated.approvedFamily, 4);
});

test('createPinnedAgents forces connection socket to use validated IP and prevents DNS rebinding', async () => {
  const approvedIp = '93.184.216.34';
  const approvedFamily = 4;
  const { httpAgent, httpsAgent } = createPinnedAgents(approvedIp, approvedFamily);

  assert.ok(httpAgent);
  assert.ok(httpsAgent);

  // Verify custom lookup returns pinned IP regardless of what hostname is passed
  await new Promise((resolve) => {
    httpAgent.options.lookup('any-attacker-host.com', {}, (err, address, family) => {
      assert.equal(err, null);
      assert.equal(address, approvedIp);
      assert.equal(family, 4);
      resolve();
    });
  });
});

test('safeMonitoringRequest performs manual redirect validation and blocks forbidden redirect destinations', async () => {
  const mockDnsLookup = async (hostname) => {
    if (hostname === 'safe-redirector.com') {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    if (hostname === 'internal-victim.com') {
      return [{ address: '192.168.1.100', family: 4 }];
    }
    return [{ address: '93.184.216.34', family: 4 }];
  };

  // Mock HTTP client that redirects to a private IP on first hop
  const mockHttpClient = async (config) => {
    if (config.url === 'https://safe-redirector.com/hop') {
      return {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        data: '',
      };
    }
    return { status: 200, headers: {}, data: { ok: true } };
  };

  await assert.rejects(
    () =>
      safeMonitoringRequest(
        { url: 'https://safe-redirector.com/hop' },
        { dnsLookupFn: mockDnsLookup, httpClient: mockHttpClient }
      ),
    /Destination IP is in forbidden range|Insecure redirect downgrade/
  );
});

test('safeMonitoringRequest rejects HTTPS to HTTP redirect downgrade', async () => {
  const mockDnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  const mockHttpClient = async (config) => {
    if (config.url === 'https://public.example.com/start') {
      return {
        status: 301,
        headers: { location: 'http://public.example.com/downgrade' },
        data: '',
      };
    }
    return { status: 200, headers: {}, data: 'ok' };
  };

  await assert.rejects(
    () =>
      safeMonitoringRequest(
        { url: 'https://public.example.com/start' },
        { dnsLookupFn: mockDnsLookup, httpClient: mockHttpClient }
      ),
    SsrfValidationError
  );
});

test('safeMonitoringRequest halts after maximum redirect count', async () => {
  const mockDnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  let hop = 0;
  const mockHttpClient = async () => {
    hop++;
    return {
      status: 302,
      headers: { location: `https://public.example.com/hop-${hop}` },
      data: '',
    };
  };

  await assert.rejects(
    () =>
      safeMonitoringRequest(
        { url: 'https://public.example.com/start', maxRedirects: 2 },
        { dnsLookupFn: mockDnsLookup, httpClient: mockHttpClient }
      ),
    /Maximum redirect limit of 2 exceeded/
  );
});

test('safeMonitoringRequest succeeds for approved destination and passes pinned agents to client', async () => {
  const mockDnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  let clientReceivedConfig = null;
  const mockHttpClient = async (config) => {
    clientReceivedConfig = config;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { status: 'healthy' },
    };
  };

  const response = await safeMonitoringRequest(
    { url: 'https://api.github.com/zen', method: 'GET', timeout: 5000 },
    { dnsLookupFn: mockDnsLookup, httpClient: mockHttpClient }
  );

  assert.equal(response.status, 200);
  assert.equal(clientReceivedConfig.url, 'https://api.github.com/zen');
  assert.equal(clientReceivedConfig.maxRedirects, 0);
  assert.equal(clientReceivedConfig.proxy, false, 'Axios proxy must be explicitly false to prevent proxy bypass');
  assert.ok(clientReceivedConfig.httpAgent);
  assert.ok(clientReceivedConfig.httpsAgent);
});

test('resolveAndValidateDestination handles bracketed IPv6 literals and rejects forbidden IPv6', async () => {
  // Loopback IPv6 with brackets
  await assert.rejects(
    () => resolveAndValidateDestination('[::1]'),
    SsrfValidationError
  );

  // AWS metadata IPv6 with brackets
  await assert.rejects(
    () => resolveAndValidateDestination('[fd00:ec2::254]'),
    SsrfValidationError
  );

  // Public IPv6 unicast with brackets
  const res = await resolveAndValidateDestination('[2606:4700:4700::1111]');
  assert.equal(res.approvedIp, '2606:4700:4700::1111');
  assert.equal(res.approvedFamily, 6);
});

test('createPinnedAgents supports 2-arg and 3-arg (all: true) custom lookup conventions', async () => {
  const approvedIp = '93.184.216.34';
  const approvedFamily = 4;
  const { httpAgent, httpsAgent } = createPinnedAgents(approvedIp, approvedFamily);

  // 2-argument calling convention: lookup(hostname, callback)
  await new Promise((resolve) => {
    httpAgent.options.lookup('internal.secret.corp', (err, address, family) => {
      assert.equal(err, null);
      assert.equal(address, approvedIp);
      assert.equal(family, approvedFamily);
      resolve();
    });
  });

  // 3-argument calling convention with all: true
  await new Promise((resolve) => {
    httpsAgent.options.lookup('internal.secret.corp', { all: true }, (err, addresses) => {
      assert.equal(err, null);
      assert.ok(Array.isArray(addresses));
      assert.equal(addresses.length, 1);
      assert.equal(addresses[0].address, approvedIp);
      assert.equal(addresses[0].family, approvedFamily);
      resolve();
    });
  });
});

test('DNS rebinding defense: pinned socket agent guarantees connection to validated IP regardless of subsequent DNS changes', async () => {
  const initialApprovedIp = '93.184.216.34'; // Safe public IP validated at request start
  const rebindingTarget = 'rebound-host.attacker.com';

  const { httpAgent } = createPinnedAgents(initialApprovedIp, 4);

  // When Node net.connect invokes the agent's lookup function during TCP handshake:
  // Even if attacker's DNS server now returns 169.254.169.254 or 127.0.0.1:
  await new Promise((resolve) => {
    httpAgent.options.lookup(rebindingTarget, {}, (err, address, family) => {
      assert.equal(err, null);
      assert.equal(address, initialApprovedIp, 'Socket MUST connect only to initial approved IP');
      assert.equal(family, 4);
      resolve();
    });
  });
});

test('safeMonitoringRequest handles DNS resolution failures cleanly', async () => {
  const failingDns = async () => {
    const err = new Error('getaddrinfo ENOTFOUND non-existent-domain.xyz');
    err.code = 'ENOTFOUND';
    throw err;
  };

  await assert.rejects(
    () => safeMonitoringRequest({ url: 'https://non-existent-domain.xyz' }, { dnsLookupFn: failingDns }),
    (err) => {
      assert.ok(err instanceof SsrfValidationError);
      assert.match(err.message, /DNS resolution failed/);
      return true;
    }
  );
});

test('safe test hook allows loopback in test mode but remains strictly disabled in production', () => {
  const origEnv = process.env.NODE_ENV;
  const origAllow = process.env.APIDASH_ALLOW_LOCAL_TEST_TARGETS;

  try {
    // 1. In test mode with flag enabled, loopback is permitted
    process.env.NODE_ENV = 'test';
    process.env.APIDASH_ALLOW_LOCAL_TEST_TARGETS = 'true';
    assert.doesNotThrow(() => validateUrlSyntax('http://127.0.0.1:4000/health'));
    assert.equal(isForbiddenIp('127.0.0.1').safe, true);

    // 2. Cloud metadata is ALWAYS forbidden, even with flag enabled
    assert.equal(isForbiddenIp('169.254.169.254').safe, false);

    // 3. In production mode, flag is completely ignored and loopback is strictly blocked
    process.env.NODE_ENV = 'production';
    assert.throws(() => validateUrlSyntax('http://127.0.0.1:4000/health'), SsrfValidationError);
    assert.equal(isForbiddenIp('127.0.0.1').safe, false);
  } finally {
    process.env.NODE_ENV = origEnv;
    if (origAllow !== undefined) {
      process.env.APIDASH_ALLOW_LOCAL_TEST_TARGETS = origAllow;
    } else {
      delete process.env.APIDASH_ALLOW_LOCAL_TEST_TARGETS;
    }
  }
});
