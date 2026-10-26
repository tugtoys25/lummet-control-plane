// Round 6.3C (stage 2): PII and secret scrubbing shared by error tracking, the Logpush-bound console output and the audit stream.
// Acceptance tests written first. The scrubber is a safety net over free text (error messages, stacks, reasons); it is not
// proof that no personal data can ever reach a log, and these tests do not claim that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, containsSensitive, scrubValue, logRedactionMode, installConsoleRedaction } from '../worker/redact.js';

const UUID = '6f1e2d3c-1111-2222-3333-444455556666';

// Fake secrets are assembled at run time so this file itself never contains a string that a secret scanner would flag.
const j = (...p) => p.join('');
const STRIPE_LIVE = j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc');
const STRIPE_RESTRICTED = j('rk_', 'test_', '51HqLyjWDarjtT1zdp7dcAbCdEf');
const WEBHOOK = j('whsec_', 'abc123def456ghi789jkl012');
const RESEND = j('re_', '123456789_', 'abcdefghijklmnopqrstuv');
const LMK = j('lmk_', '0123456789abcdef0123456789abcdef');
const GITHUB = j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const AWS = j('AKIA', 'IOSFODNN7EXAMPLE');
const SLACK = j('xox', 'b-', '123456789012-abcdefghijkl');
const JWT = j('eyJhbGciOiJSUzI1NiJ9', '.', 'eyJzdWIiOiJ1c2VyLTEifQ', '.', 'c2lnbmF0dXJlLXZhbHVlLWhlcmU');

// ---- text patterns -------------------------------------------------------------------------------------------------

test('emails are removed, wherever they sit in the text', () => {
  const out = redactText('Resend rejected jane.doe+promo@mail.example.co.uk: mailbox full; cc "ops@example.com".');
  assert.doesNotMatch(out, /@/);
  assert.match(out, /Resend rejected \[email\]: mailbox full; cc "\[email\]"\./);
});

test('IPv4 and IPv6 addresses are removed; clock times, ISO timestamps and version numbers survive', () => {
  assert.equal(redactText('from 203.0.113.7 then 198.51.100.200'), 'from [ip] then [ip]');
  for (const v6 of ['2001:db8:85a3:0:0:8a2e:370:7334', '2001:db8::8a2e:370:7334', 'fe80::1ff:fe23:4567:890a']) assert.equal(redactText(`peer ${v6} closed`), 'peer [ip] closed', v6);
  assert.equal(redactText('at 12:30:45 on 2026-10-25T12:30:45.123Z took 3:07'), 'at 12:30:45 on 2026-10-25T12:30:45.123Z took 3:07');
  assert.equal(redactText('node v22.23.4 and 2.6.0.8'), 'node v22.23.4 and 2.6.0.8');
});

test('JWTs, Bearer and Basic credentials are removed', () => {
  assert.doesNotMatch(redactText(`assertion ${JWT} was rejected`), /eyJ/);
  assert.match(redactText(`assertion ${JWT} was rejected`), /\[jwt\]/);
  const out = redactText('Authorization: Bearer abc.DEF-123_xyz~+/= and Basic dXNlcjpwYXNz');
  assert.doesNotMatch(out, /abc\.DEF|dXNlcjpwYXNz/);
});

test('provider keys and webhook secrets are removed (Stripe, Resend, GitHub, AWS, Slack and this platform\'s own key prefix)', () => {
  for (const secret of [STRIPE_LIVE, STRIPE_RESTRICTED, WEBHOOK, RESEND, LMK, GITHUB, AWS, SLACK]) {
    const out = redactText(`call failed with ${secret} attached`);
    assert.ok(!out.includes(secret), `still contains ${secret.slice(0, 7)}...`);
    assert.match(out, /call failed with \[(key|token)\] attached/);
  }
});

test('query strings and fragments are removed from absolute and relative URLs; the path stays', () => {
  const abs = redactText('GET https://app.example.test/api/customer/email/verify?token=abc123&u=1#frag failed');
  assert.equal(abs, 'GET https://app.example.test/api/customer/email/verify?[redacted] failed');
  assert.equal(redactText('redirect to /app/reset?token=zzz987&next=/app'), 'redirect to /app/reset?[redacted]');
});

test('key=value and "key":"value" pairs for secret-like keys are removed, other keys are kept', () => {
  const out = redactText('password=hunter2 secret: topsecret {"token":"tok_abc","api_key":"k-1","status":"failed"} session=abc; code=42');
  for (const leaked of ['hunter2', 'topsecret', 'tok_abc', 'k-1', 'abc;']) assert.ok(!out.includes(leaked), leaked);
  assert.match(out, /"status":"failed"/);
});

test('card numbers that pass the Luhn check are removed; other digit runs, epoch times and ids are kept', () => {
  assert.doesNotMatch(redactText('card 4242 4242 4242 4242 declined'), /4242/);
  assert.doesNotMatch(redactText('card 4242-4242-4242-4242 declined'), /4242/);
  assert.doesNotMatch(redactText('amex 378282246310005'), /378282246310005/);
  assert.equal(redactText('order 1234567890123456 stuck'), 'order 1234567890123456 stuck');   // fails Luhn
  assert.equal(redactText('at 1761400000000 ms'), 'at 1761400000000 ms');
});

test('long mixed tokens are removed but request ids (UUIDs), short ids and plain long words are kept', () => {
  assert.equal(redactText('key 0123456789abcdef0123456789abcdef0123 rejected'), 'key [token] rejected');
  assert.equal(redactText(`request ${UUID} and req-1 and cus_Nf8abc12 and sub_1Mxyz`), `request ${UUID} and req-1 and cus_Nf8abc12 and sub_1Mxyz`);
  assert.equal(redactText('internationalizationlocalizationconfigurationmanager failed'), 'internationalizationlocalizationconfigurationmanager failed');
});

test('redaction is idempotent, bounded and tolerant of non-strings', () => {
  const dirty = `a@b.com ${STRIPE_LIVE} 203.0.113.7 https://x.test/p?q=1`;
  const once = redactText(dirty);
  assert.equal(redactText(once), once);
  assert.ok(redactText('x'.repeat(5000)).length <= 1000);
  assert.ok(redactText('x'.repeat(5000), { max: 50 }).length <= 50);
  assert.equal(redactText(undefined), ''); assert.equal(redactText(null), ''); assert.equal(redactText(42), '42');
  assert.equal(redactText({ toString() { return 'obj a@b.com'; } }), 'obj [email]');
});

test('containsSensitive names what it finds and is silent on ordinary log lines and on redacted output', () => {
  const found = containsSensitive(`user a@b.com from 203.0.113.7 sent ${STRIPE_LIVE} and ${JWT}`);
  for (const kind of ['email', 'ip', 'key', 'jwt']) assert.ok(found.includes(kind), kind);
  const ordinary = JSON.stringify({ level: 'error', event: 'unhandled_exception', request_id: UUID, method: 'POST', route: '/api/organizations/:id/webhooks', status: 500, duration_ms: 31, error_name: 'TypeError' });
  assert.deepEqual(containsSensitive(ordinary), []);
  assert.deepEqual(containsSensitive(redactText(`a@b.com 203.0.113.7 ${STRIPE_LIVE} ${JWT} password=x`)), []);
});

// ---- structured values ---------------------------------------------------------------------------------------------

test('scrubValue drops secret-like and personal keys, redacts every string, and does not mutate its input', () => {
  const input = {
    message: 'failed for a@b.com', status: 500, ok: false,
    headers: { authorization: 'Bearer abc.def', cookie: 'sid=1', 'x-request-id': UUID },
    email: 'a@b.com', password: 'x', token: 't', ip: '203.0.113.7', user: { id: 1, email: 'a@b.com' }, body: { card: '4242424242424242' }, query: 'token=1',
    nested: { list: ['a@b.com', 7, null, { secret: 's', note: 'ip 203.0.113.7' }] }
  };
  const snapshot = JSON.stringify(input);
  const out = scrubValue(input);
  assert.equal(JSON.stringify(input), snapshot, 'input untouched');
  for (const dropped of ['headers', 'email', 'password', 'token', 'ip', 'user', 'body', 'query']) assert.ok(!(dropped in out), `${dropped} should be dropped`);
  assert.equal(out.message, 'failed for [email]'); assert.equal(out.status, 500); assert.equal(out.ok, false);
  assert.deepEqual(out.nested.list, ['[email]', 7, null, { note: 'ip [ip]' }]);
  assert.deepEqual(containsSensitive(JSON.stringify(out)), []);
});

test('scrubValue is bounded: depth, array length, string length, cycles and Errors', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'x' } } } } } } } };
  assert.ok(JSON.stringify(scrubValue(deep)).length < 200);
  assert.equal(scrubValue(Array.from({ length: 500 }, (_, i) => i)).length, 50);
  assert.ok(scrubValue({ s: 'y'.repeat(5000) }).s.length <= 1000);
  const loop = { name: 'loop' }; loop.self = loop;
  assert.doesNotThrow(() => scrubValue(loop));
  const err = new Error('boom for a@b.com'); err.stack = 'Error: boom for a@b.com\n    at f (x.js:1:1)';
  const out = scrubValue({ err });
  assert.doesNotMatch(JSON.stringify(out), /a@b\.com/);
  assert.equal(scrubValue(undefined), undefined); assert.equal(scrubValue(null), null); assert.equal(scrubValue(5), 5);
});

// ---- console redaction ---------------------------------------------------------------------------------------------

test('LOG_REDACTION is "on" only for that exact word; anything else is off', () => {
  assert.equal(logRedactionMode({ LOG_REDACTION: 'on' }), 'on'); assert.equal(logRedactionMode({ LOG_REDACTION: ' ON ' }), 'on');
  for (const v of [undefined, '', 'off', 'true', 'yes', '1', 'enabled']) assert.equal(logRedactionMode({ LOG_REDACTION: v }), 'off', String(v));
  assert.equal(logRedactionMode(undefined), 'off');
});

function withFakeConsole(run) {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const seen = [];
  for (const level of Object.keys(saved)) console[level] = (...args) => seen.push({ level, args });
  const originals = { ...console };
  try { return run(seen, originals); } finally { Object.assign(console, saved); }
}

test('with LOG_REDACTION off nothing is wrapped: the console functions are the very same objects', () => {
  withFakeConsole((seen, originals) => {
    installConsoleRedaction({ LOG_REDACTION: 'off' }); installConsoleRedaction({});
    for (const level of ['log', 'info', 'warn', 'error']) assert.equal(console[level], originals[level]);
    console.warn('a@b.com'); assert.equal(seen[0].args[0], 'a@b.com', 'untouched when off');
  });
});

test('with LOG_REDACTION on every level is redacted: strings, JSON lines, objects and Errors', () => {
  withFakeConsole((seen) => {
    installConsoleRedaction({ LOG_REDACTION: 'on' });
    console.log(`user a@b.com`); console.info('ip 203.0.113.7'); console.warn(JSON.stringify({ msg: 'x', error: `bad ${STRIPE_LIVE}` }));
    console.error('failed:', { who: 'a@b.com', n: 3 }, new Error('boom 203.0.113.7'));
    assert.deepEqual(seen.map((s) => s.level), ['log', 'info', 'warn', 'error']);
    assert.deepEqual(containsSensitive(JSON.stringify(seen.map((s) => s.args))), []);
    assert.equal(seen[0].args[0], 'user [email]');
    assert.equal(JSON.parse(seen[2].args[0]).msg, 'x', 'the JSON line is still JSON');
    assert.equal(seen[3].args[1].n, 3, 'non-sensitive fields are kept');
  });
});

test('installing twice does not double-wrap; a console replaced later is wrapped again; a throwing argument cannot break logging', () => {
  withFakeConsole((seen) => {
    const env = { LOG_REDACTION: 'on' };
    installConsoleRedaction(env); installConsoleRedaction(env);
    console.warn('a@b.com'); assert.equal(seen.length, 1);
    const replaced = []; console.warn = (...a) => replaced.push(a);
    installConsoleRedaction(env); console.warn('c@d.com');
    assert.deepEqual(replaced, [['[email]']]);
    const hostile = { get boom() { throw new Error('getter'); }, toString() { throw new Error('toString'); } };
    assert.doesNotThrow(() => console.log(hostile));
  });
});

test('switching the flag off in a later request stops redaction without a redeploy of the wrapper', () => {
  withFakeConsole((seen) => {
    installConsoleRedaction({ LOG_REDACTION: 'on' }); console.log('a@b.com');
    installConsoleRedaction({ LOG_REDACTION: 'off' }); console.log('a@b.com');
    assert.equal(seen[0].args[0], '[email]'); assert.equal(seen[1].args[0], 'a@b.com');
  });
});
