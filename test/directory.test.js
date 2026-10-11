// The AdminDirectory entrypoint: what a binding caller can read, what it cannot
// do, and the proof that nobody else can reach it.
//
// Forward Email is stubbed at fetch, and this file never holds the real one. The
// stub goes in before any test runs and is not put back (node --test gives each
// file its own process), so nothing here can reach api.forwardemail.net, or any
// other host, whatever a test gets wrong. Every call the stub answers is
// recorded, and the tests assert on that record.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import worker from '../src/index.js';
import { DirectoryError, isHostname, recipientShape, webhookShape } from '../src/directory.js';

// `cloudflare:workers` exists only inside workerd. The stand-in keeps the one
// thing AdminDirectory uses from its base class: the constructor leaves the
// bindings on `this.env`. It answers that exact specifier and exports that one
// name, so a misspelling of either in src/worker.js fails this file at load.
// `wrangler deploy --dry-run` would not catch one: it leaves `cloudflare:`
// imports to the runtime and exits 0 (measured on wrangler 4.149.0).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
    return {
      shortCircuit: true,
      url: 'data:text/javascript,export class WorkerEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env;}}',
    };
  },
});
const main = await import('../src/worker.js');
const { AdminDirectory } = main;
const { WorkerEntrypoint } = await import('cloudflare:workers');

// ---- the stub ---------------------------------------------------------------

const FE = 'https://api.forwardemail.net/v1';
let calls;
let respond;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null });
  return respond(url, init);
};

beforeEach(() => {
  calls = [];
  respond = (url) => {
    throw new Error(`unexpected outbound fetch in a test: ${url}`);
  };
});

// Forward Email's list answer: a JSON array, with the full count in X-Item-Count.
const listed = (rows, total = rows.length) => new Response(JSON.stringify(rows), {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'X-Item-Count': String(total) },
});

// Answer the named URLs and nothing else. A value is the rows, or a function
// that returns (or throws) the answer.
function forwardEmail(answers) {
  respond = (url) => {
    if (!(url in answers)) throw new Error(`unexpected outbound fetch in a test: ${url}`);
    return typeof answers[url] === 'function' ? answers[url]() : listed(answers[url]);
  };
}

// A KV binding that answers from a map and records every call. `get` with a
// list of keys answers a Map and refuses more than 100, as the real binding does.
class FakeKV {
  constructor(records, pageSize = 1000) {
    this.records = { ...records };
    this.pageSize = pageSize;
    this.ops = [];
  }

  async list({ prefix = '', cursor } = {}) {
    this.ops.push(`list ${prefix}`);
    const names = Object.keys(this.records).filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const end = start + this.pageSize;
    return end >= names.length
      ? { keys: names.slice(start).map((name) => ({ name })), list_complete: true }
      : { keys: names.slice(start, end).map((name) => ({ name })), list_complete: false, cursor: String(end) };
  }

  async get(key, type) {
    assert.equal(type, 'json');
    if (!Array.isArray(key)) {
      this.ops.push(`get ${key}`);
      return this.records[key] ?? null;
    }
    this.ops.push(`get ${key.length} keys`);
    if (key.length > 100) throw new Error('a KV read takes at most 100 keys');
    return new Map(key.map((k) => [k, this.records[k] ?? null]));
  }

  async put(key) {
    this.ops.push(`put ${key}`);
  }

  async delete(key) {
    this.ops.push(`delete ${key}`);
  }
}

// ---- fixtures ---------------------------------------------------------------

// Every value here is something the directory must never return. Each is unique,
// so a hit in an answer can only be a leak. Hosts are under .invalid, which never
// resolves.
const SECRETS = {
  fe_api_key: 'fe-api-key-7d1c',
  send_token: 'shared-send-token-2b9e',
  turnstile_secret: 'turnstile-secret-55af',
  notify_token: 'notify-ingest-token-c41d',
  // Forward Email, on a domain.
  bounce_path: 'bounce-path-secret-9c2e',
  bounce_query: 'bounce-query-token-8a31',
  bounce_fragment: 'bounce-fragment-3f70',
  verification_record: 'verification-record-b6e4',
  webhook_key: 'webhook-signing-key-71aa',
  domain_token_hash: 'catch-all-password-hash-d09b',
  domain_token_salt: 'catch-all-password-salt-17c5',
  s3_access_key_id: 's3-access-key-id-4e77',
  s3_secret_access_key: 's3-secret-access-key-0f12',
  s3_bucket: 's3-bucket-name-88b3',
  custom_verification: 'custom-verification-key-a2d8',
  allowlist_entry: 'allowlisted-sender-63fe.example.net',
  invite_token: 'member-invite-token-5c09',
  dkim_key: 'dkim-public-key-e7b1',
  domain_future: 'domain-field-added-later-91d3',
  wrong_type_flag: 'secret-where-a-flag-belongs-2c6a',
  wrong_type_date: 'secret-where-a-date-belongs-f48e',
  wrong_type_id: 'secret-where-an-id-belongs-70ab',
  wrong_type_name: 'secret-where-a-name-belongs-b35c',
  wrong_type_plan: 'SECRET-WHERE-A-PLAN-BELONGS-1D9F',
  bounce_not_a_url: 'bounce-value-that-is-no-url-ce20',
  // Forward Email, on an alias.
  email_in_path: 'email-in-path-secret-5b1f',
  userinfo_password: 'userinfo-password-0e6b',
  one_segment: 'one-segment-token-6d2a',
  first_segment: 'First-Segment-Secret-4b8c',
  versioned_path: 'versioned-path-token-a917',
  ftp_path: 'ftp-path-token-3e55',
  schemeless_password: 'schemeless-password-c7d0',
  smtp_password: 'smtp-password-9f24',
  imap_password: 'imap-password-18e6',
  alias_token_hash: 'alias-password-hash-64ba',
  alias_description: 'description-typed-secret-d5f3',
  alias_label: 'label-typed-secret-0a7e',
  vacation_message: 'vacation-message-text-b82d',
  pgp_key: 'pgp-public-key-block-36c1',
  verified_recipient: 'verified-recipient-7c1b@example.net',
  pending_recipient: 'pending-recipient-e94a@example.net',
  account_email: 'account-owner-4e1a@example.net',
  account_api_token: 'account-api-token-2f68',
  alias_future: 'alias-field-added-later-5dd7',
  // The PRODUCTS KV.
  send_token_sha256: 'c0ffee'.repeat(10) + 'beef',
  turnstile_ref: 'TURNSTILE_SECRET_ACME',
  icon_signature: 'icon-url-signature-83ac',
  unsubscribe_token: 'unsubscribe-token-f1b9',
  origin_userinfo: 'origin-userinfo-4c3e',
  origin_query: 'origin-query-key-a06d',
  product_future: 'product-field-added-later-7e42',
  product_wrong_type: 'secret-where-an-address-belongs-b9c8',
  other_key: 'record-under-another-prefix-d3a1',
  // Forward Email's error answers.
  error_body: 'error-body-token-6a5f',
  thrown_message: 'thrown-message-token-e2c4',
};

const BOUNCE_URL =
  `https://notify.example.invalid/bounce/${SECRETS.bounce_path}?token=${SECRETS.bounce_query}#${SECRETS.bounce_fragment}`;
const EMAIL_IN_URL = `https://notify.example.invalid/email-in/${SECRETS.email_in_path}`;

// A row as Forward Email's list serializer builds one (its
// app/controllers/api/v1/domains.js and app/models/domains.js, read at d706205
// on 2026-10-11), with a secret planted in every field that could hold one. It
// omits some of these itself (tokens, webhook_key, the S3 keys); they are here
// because the directory must not depend on that.
const FE_DOMAINS = [
  {
    object: 'domain',
    id: '64f0c1d2e3a4b5c6d7e8f901',
    name: 'example.com',
    plan: 'enhanced_protection',
    has_mx_record: true,
    has_txt_record: true,
    has_smtp: true,
    smtp_verified_at: '2026-08-01T12:00:00.000Z',
    is_smtp_suspended: false,
    has_dkim_record: true,
    has_return_path_record: true,
    has_dmarc_record: false,
    bounce_webhook: BOUNCE_URL,
    verification_record: SECRETS.verification_record,
    webhook_key: SECRETS.webhook_key,
    tokens: [{ description: 'catch-all', hash: SECRETS.domain_token_hash, salt: SECRETS.domain_token_salt }],
    has_custom_s3: true,
    s3_endpoint: 'https://s3.example.invalid',
    s3_region: 'us-central-1',
    s3_bucket: SECRETS.s3_bucket,
    s3_access_key_id: SECRETS.s3_access_key_id,
    s3_secret_access_key: SECRETS.s3_secret_access_key,
    has_custom_verification: true,
    custom_verification: { redirect: `https://example.invalid/verified?key=${SECRETS.custom_verification}` },
    allowlist: [SECRETS.allowlist_entry],
    denylist: [],
    restricted_alias_names: ['admin'],
    invites: [{ email: 'invited@example.net', group: 'user', token: SECRETS.invite_token }],
    smtp_dns_records: {
      dkim: { name: 'fe-0123456789._domainkey', value: `v=DKIM1; k=rsa; p=${SECRETS.dkim_key};` },
      return_path: { name: 'fe-bounces', value: 'forwardemail.net' },
      dmarc: { name: '_dmarc', value: 'v=DMARC1; p=reject; pct=100; rua=mailto:dmarc-64f0c1d2e3a4b5c6d7e8f901@forwardemail.net;' },
    },
    has_delivery_logs: true,
    require_tls_inbound: true,
    retention_days: 30,
    max_recipients_per_alias: 10,
    storage_used: 1024,
    link: 'https://forwardemail.net/my-account/domains/example.com',
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-09-30T03:04:05.000Z',
    added_later: SECRETS.domain_future,
  },
  // A domain that only forwards: no outbound approval, no bounce webhook, and
  // the optional fields absent, as the serializer leaves a field never written.
  {
    object: 'domain',
    id: '64f0c1d2e3a4b5c6d7e8f902',
    name: 'forward-only.example.org',
    plan: 'free',
    has_mx_record: true,
    has_txt_record: false,
    has_smtp: false,
    is_smtp_suspended: false,
    has_dkim_record: false,
    has_return_path_record: false,
    has_dmarc_record: false,
  },
  // Every allow-listed field holding a value of the wrong shape.
  {
    id: SECRETS.wrong_type_id,
    name: `https://x.example.invalid/${SECRETS.wrong_type_name}`,
    plan: SECRETS.wrong_type_plan,
    has_mx_record: SECRETS.wrong_type_flag,
    has_txt_record: 1,
    has_smtp: 'true',
    // A date as far as Date.parse is concerned, which reads past the parentheses.
    smtp_verified_at: `Aug 1 2026 (${SECRETS.wrong_type_date})`,
    is_smtp_suspended: null,
    has_dkim_record: { nested: SECRETS.wrong_type_flag },
    has_return_path_record: [true],
    has_dmarc_record: 0,
    bounce_webhook: SECRETS.bounce_not_a_url,
  },
];

const DOMAINS_OUT = [
  {
    id: '64f0c1d2e3a4b5c6d7e8f901',
    name: 'example.com',
    plan: 'enhanced_protection',
    has_mx_record: true,
    has_txt_record: true,
    has_smtp: true,
    smtp_verified_at: '2026-08-01T12:00:00.000Z',
    is_smtp_suspended: false,
    has_dkim_record: true,
    has_return_path_record: true,
    has_dmarc_record: false,
    bounce_webhook: { kind: 'webhook', host: 'notify.example.invalid', path: '/bounce/[redacted]' },
  },
  {
    id: '64f0c1d2e3a4b5c6d7e8f902',
    name: 'forward-only.example.org',
    plan: 'free',
    has_mx_record: true,
    has_txt_record: false,
    has_smtp: false,
    smtp_verified_at: null,
    is_smtp_suspended: false,
    has_dkim_record: false,
    has_return_path_record: false,
    has_dmarc_record: false,
    bounce_webhook: null,
  },
  {
    id: null,
    name: null,
    plan: null,
    has_mx_record: null,
    has_txt_record: null,
    has_smtp: null,
    smtp_verified_at: null,
    is_smtp_suspended: null,
    has_dkim_record: null,
    has_return_path_record: null,
    has_dmarc_record: null,
    bounce_webhook: { kind: 'other' },
  },
];

// What rides on every alias Forward Email lists: the account that owns it, and
// the whole domain again, bounce webhook included.
const ALIAS_BAGGAGE = {
  object: 'alias',
  user: { id: '64f0c1d2e3a4b5c6d7e8f9aa', email: SECRETS.account_email, api_token: SECRETS.account_api_token },
  domain: FE_DOMAINS[0],
  created_at: '2026-01-02T03:04:05.000Z',
  updated_at: '2026-09-30T03:04:05.000Z',
};

const FE_ALIASES = [
  {
    ...ALIAS_BAGGAGE,
    id: '64f0c1d2e3a4b5c6d7e8fa01',
    name: '*',
    is_enabled: true,
    has_imap: false,
    recipients: [EMAIL_IN_URL, 'michal@example.net'],
    description: `forwards to herald, key ${SECRETS.alias_description}`,
    labels: ['catch-all', SECRETS.alias_label],
    has_recipient_verification: true,
    verified_recipients: [SECRETS.verified_recipient],
    pending_recipients: [SECRETS.pending_recipient],
    added_later: SECRETS.alias_future,
  },
  {
    ...ALIAS_BAGGAGE,
    id: '64f0c1d2e3a4b5c6d7e8fa02',
    name: 'noreply',
    is_enabled: true,
    has_imap: true,
    recipients: [],
    vacation_responder: { is_enabled: true, subject: 'Not monitored', message: SECRETS.vacation_message },
    has_pgp: true,
    public_key: SECRETS.pgp_key,
    tokens: [{ description: 'smtp', hash: SECRETS.alias_token_hash }],
    password: SECRETS.smtp_password,
    imap_password: SECRETS.imap_password,
  },
  // has_imap never written, and every kind of recipient that is not an address.
  {
    ...ALIAS_BAGGAGE,
    id: '64f0c1d2e3a4b5c6d7e8fa03',
    name: 'hooks',
    is_enabled: false,
    recipients: [
      `https://user:${SECRETS.userinfo_password}@hooks.example.invalid/${SECRETS.one_segment}`,
      `https://hooks.example.invalid/${SECRETS.first_segment}/inbound`,
      `HTTPS://HOOKS.EXAMPLE.INVALID:8443/v1/${SECRETS.versioned_path}`,
      `ftp://files.example.invalid/drop/${SECRETS.ftp_path}`,
      `user:${SECRETS.schemeless_password}@hooks.example.invalid`,
      'mx.example.net',
      '192.0.2.7',
      'Sales.Team+web@Example.NET',
      42,
      null,
    ],
  },
  // No recipients list at all, and the other fields of the wrong shape.
  {
    id: 7,
    name: ['hooks'],
    is_enabled: 'yes',
    has_imap: SECRETS.wrong_type_flag,
    recipients: EMAIL_IN_URL,
  },
];

const ALIASES_OUT = [
  {
    id: '64f0c1d2e3a4b5c6d7e8fa01',
    name: '*',
    is_enabled: true,
    has_imap: false,
    recipients: [
      { kind: 'webhook', host: 'notify.example.invalid', path: '/email-in/[redacted]' },
      { kind: 'email', address: 'michal@example.net' },
    ],
  },
  { id: '64f0c1d2e3a4b5c6d7e8fa02', name: 'noreply', is_enabled: true, has_imap: true, recipients: [] },
  {
    id: '64f0c1d2e3a4b5c6d7e8fa03',
    name: 'hooks',
    is_enabled: false,
    has_imap: null,
    recipients: [
      { kind: 'webhook', host: 'hooks.example.invalid', path: '/[redacted]' },
      { kind: 'webhook', host: 'hooks.example.invalid', path: '/[redacted]' },
      { kind: 'webhook', host: 'hooks.example.invalid:8443', path: '/[redacted]' },
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'email', address: 'Sales.Team+web@Example.NET' },
      { kind: 'other' },
      { kind: 'other' },
    ],
  },
  { id: null, name: null, is_enabled: null, has_imap: null, recipients: null },
];

// Records as herald's `notifyctl sync-mailer` writes them, plus the fields
// index.js reads that it does not write (accent, unsubscribe_url).
const PRODUCT_RECORDS = {
  'product:acme': {
    name: 'Acme',
    domain: 'acme.example.com',
    from_addr: 'noreply@acme.example.com',
    contact_to: 'owner@acme.example.com',
    allowed_origins: [
      'https://acme.example.com',
      `https://user:${SECRETS.origin_userinfo}@www.acme.example.com/contact?key=${SECRETS.origin_query}`,
      'not an origin',
    ],
    white_label: true,
    transactional_only: true,
    send_token_sha256: SECRETS.send_token_sha256,
    turnstile_ref: SECRETS.turnstile_ref,
    icon_url: `https://cdn.example.invalid/acme.png?sig=${SECRETS.icon_signature}`,
    unsubscribe_url: `https://acme.example.com/unsubscribe/${SECRETS.unsubscribe_token}`,
    accent: '#123456',
    added_later: SECRETS.product_future,
  },
  'product:plain': {
    name: 'Plain',
    domain: 'plain.example.org',
    from_addr: 'noreply@plain.example.org',
    contact_to: 'ops@plain.example.org',
    allowed_origins: [],
    white_label: false,
    transactional_only: false,
  },
  // Every allow-listed field holding a value of the wrong shape, under a key no
  // route can reach.
  'product:Odd Key': {
    name: 42,
    domain: `https://odd.example.invalid/${SECRETS.product_wrong_type}`,
    from_addr: `https://user:${SECRETS.product_wrong_type}@odd.example.invalid/path`,
    contact_to: null,
    allowed_origins: `https://odd.example.invalid/${SECRETS.product_wrong_type}`,
    white_label: 'true',
    transactional_only: 1,
    send_token_sha256: '',
  },
  'other:config': { name: 'not a product', token: SECRETS.other_key },
};

const PRODUCTS_OUT = [
  {
    slug: null,
    name: null,
    domain: null,
    from_addr: null,
    contact_to: null,
    allowed_origins: null,
    white_label: false,
    transactional_only: false,
    has_send_token: false,
  },
  {
    slug: 'acme',
    name: 'Acme',
    domain: 'acme.example.com',
    from_addr: 'noreply@acme.example.com',
    contact_to: 'owner@acme.example.com',
    allowed_origins: ['https://acme.example.com', 'https://www.acme.example.com', null],
    white_label: true,
    transactional_only: true,
    has_send_token: true,
  },
  {
    slug: 'plain',
    name: 'Plain',
    domain: 'plain.example.org',
    from_addr: 'noreply@plain.example.org',
    contact_to: 'ops@plain.example.org',
    allowed_origins: [],
    white_label: false,
    transactional_only: false,
    has_send_token: false,
  },
];

// Each failure, with a secret planted wherever Forward Email could repeat one.
const FAILURES = {
  'a 401': {
    planted: SECRETS.error_body,
    answer: () => new Response(JSON.stringify({ statusCode: 401, message: `Invalid API token ${SECRETS.error_body}` }), { status: 401 }),
    code: 'fe_status',
    message: 'fe_status: Forward Email answered 401',
  },
  'a 404': {
    planted: SECRETS.error_body,
    answer: () => new Response(JSON.stringify({ message: `Domain does not exist ${SECRETS.error_body}` }), { status: 404 }),
    code: 'fe_status',
    message: 'fe_status: Forward Email answered 404',
  },
  'a 429': {
    planted: SECRETS.error_body,
    answer: () => new Response(`Rate limit exceeded ${SECRETS.error_body}`, { status: 429 }),
    code: 'fe_status',
    message: 'fe_status: Forward Email answered 429',
  },
  'a 503 with an HTML page': {
    planted: SECRETS.error_body,
    answer: () => new Response(`<html>${SECRETS.error_body}</html>`, { status: 503 }),
    code: 'fe_status',
    message: 'fe_status: Forward Email answered 503',
  },
  'a request that never completes': {
    planted: SECRETS.thrown_message,
    answer: () => {
      throw new TypeError(`fetch failed ${SECRETS.thrown_message}`);
    },
    code: 'fe_unreachable',
    message: 'fe_unreachable: no answer from Forward Email (TypeError)',
  },
  'a 200 that is not JSON': {
    // The parser's own complaint quotes the start of the body.
    planted: EMAIL_IN_URL,
    answer: () => new Response(`${EMAIL_IN_URL} took longer than 30000ms`, { status: 200 }),
    code: 'fe_bad_body',
    message: 'fe_bad_body: Forward Email answered 2xx without a JSON list',
  },
  'a 200 with JSON that is not a list': {
    planted: BOUNCE_URL,
    answer: () => new Response(JSON.stringify({ result: [{ name: 'example.com', bounce_webhook: BOUNCE_URL }] }), { status: 200 }),
    code: 'fe_bad_body',
    message: 'fe_bad_body: Forward Email answered 2xx without a JSON list',
  },
  'one page of a longer list': {
    planted: BOUNCE_URL,
    answer: () => listed(FE_DOMAINS.slice(0, 2), 1001),
    code: 'fe_incomplete',
    message: 'fe_incomplete: Forward Email returned 2 rows of a longer list',
  },
};

const DOMAINS_URL = `${FE}/domains?pagination=false`;
const ALIASES_URL = `${FE}/domains/example.com/aliases?pagination=false`;

function setup(records = PRODUCT_RECORDS, pageSize) {
  const env = {
    PRODUCTS: new FakeKV(records, pageSize),
    FORWARDEMAIL_API_KEY: SECRETS.fe_api_key,
    TURNSTILE_SECRET: SECRETS.turnstile_secret,
    SEND_TOKEN: SECRETS.send_token,
    NOTIFY_URL: 'https://notify.example.invalid',
    NOTIFY_TOKEN: SECRETS.notify_token,
  };
  forwardEmail({ [DOMAINS_URL]: FE_DOMAINS, [ALIASES_URL]: FE_ALIASES });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  return { env, ctx, pending, directory: new AdminDirectory(ctx, env) };
}

// ---- the entrypoint and the module that carries it ---------------------------

test('the main module is index.js with one export added, and wrangler deploys that module', () => {
  assert.equal(main.default, worker, 'the default export must be the same object, not a copy');
  assert.equal(typeof main.default.fetch, 'function');
  assert.deepEqual(Object.keys(main).sort(), ['AdminDirectory', 'default']);

  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.equal(toml.match(/^main\s*=\s*"([^"]+)"/m)?.[1], 'src/worker.js');
});

test('AdminDirectory offers a binding caller exactly three methods, and no fetch', () => {
  // Every public method on a WorkerEntrypoint is callable over the binding.
  assert.deepEqual(
    Object.getOwnPropertyNames(AdminDirectory.prototype).sort(),
    ['constructor', 'feAliases', 'feDomains', 'products'],
  );
  // And only a class that extends WorkerEntrypoint is callable at all: workerd
  // refuses a binding to a plain exported class (measured on 2026-10-11).
  assert.equal(Object.getPrototypeOf(AdminDirectory), WorkerEntrypoint);
});

// ---- what each method returns -------------------------------------------------

test('feDomains: one GET to Forward Email, and exactly the allow-listed fields', async () => {
  const s = setup();
  assert.deepEqual(await s.directory.feDomains(), DOMAINS_OUT);

  assert.equal(calls.length, 1, 'one call to Forward Email');
  assert.equal(calls[0].url, DOMAINS_URL);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, null);
  // The key, base URL, and Basic auth sendEmail uses.
  assert.deepEqual(calls[0].headers, { Authorization: 'Basic ' + btoa(`${SECRETS.fe_api_key}:`) });
  assert.deepEqual(s.env.PRODUCTS.ops, [], 'the KV is not read for a Forward Email answer');
});

test('feAliases: one GET for the named domain, and exactly the allow-listed fields', async () => {
  const s = setup();
  assert.deepEqual(await s.directory.feAliases('example.com'), ALIASES_OUT);

  assert.equal(calls.length, 1, 'one call to Forward Email');
  assert.equal(calls[0].url, ALIASES_URL);
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(calls[0].headers, { Authorization: 'Basic ' + btoa(`${SECRETS.fe_api_key}:`) });
});

test('feAliases: the domain goes into the URL as given, for every shape of hostname', async () => {
  const s = setup();
  for (const domain of ['thompsonblack.us', 'a.b.example.co.uk', 'xn--bcher-kva.example', 'my-site.example.com', '1.example.com']) {
    calls = [];
    forwardEmail({ [`${FE}/domains/${domain}/aliases?pagination=false`]: [] });
    assert.deepEqual(await s.directory.feAliases(domain), []);
    assert.deepEqual(calls.map((c) => c.url), [`${FE}/domains/${domain}/aliases?pagination=false`]);
  }
});

test('feAliases: anything that is not a lowercase hostname is refused before Forward Email is called', async () => {
  const s = setup();
  // U+0430, which renders as a Latin a.
  const CYRILLIC_A = `ex${String.fromCharCode(0x430)}mple.com`;
  const refused = [
    // Not a hostname.
    '', ' ', 'localhost', 'example', '.', '..', 'example.com.', '.example.com', 'example..com',
    '-a.example.com', 'a-.example.com', 'exa_mple.com', 'Example.com', 'EXAMPLE.COM', CYRILLIC_A,
    `${'a'.repeat(64)}.example.com`, `${'a.'.repeat(126)}com`, '192.0.2.7', '127.0.0.1', 'example.123',
    // Would change the path, the query, or the host the request goes to.
    '../emails', '..%2Femails', 'example.com/aliases/64f0c1d2e3a4b5c6d7e8fa01', 'example.com/../../emails',
    'example.com?pagination=true', 'example.com#', 'example.com%2F..', 'example.com\\..', 'example.com:443',
    'user@example.com', 'https://example.com', '//evil.example.net', 'example.com\n', ' example.com', 'exa mple.com',
    // Not a string.
    undefined, null, 0, 42, true, {}, [], ['example.com'], { toString: () => 'example.com' },
  ];
  for (const domain of refused) {
    await assert.rejects(
      s.directory.feAliases(domain),
      (e) => e instanceof DirectoryError && e.code === 'invalid_domain' && e.message.startsWith('invalid_domain: '),
      `feAliases accepted ${JSON.stringify(domain)}`,
    );
    assert.equal(isHostname(domain), false);
  }
  assert.deepEqual(calls, [], 'no request left for any of them');
});

test('products: the PRODUCTS KV as held, and exactly the allow-listed fields', async () => {
  const s = setup();
  assert.deepEqual(await s.directory.products(), PRODUCTS_OUT);

  assert.deepEqual(s.env.PRODUCTS.ops, ['list product:', 'get 3 keys']);
  assert.deepEqual(calls, [], 'no outbound request for the product records');
});

test('products: follows the KV cursor, and reads at most 100 keys at a time', async () => {
  const records = { 'other:config': { name: 'not a product' } };
  for (let i = 0; i < 130; i++) {
    const slug = `p${String(i).padStart(3, '0')}`;
    records[`product:${slug}`] = { name: `Product ${i}`, domain: `${slug}.example.com` };
  }
  const s = setup(records, 50);
  const out = await s.directory.products();

  assert.equal(out.length, 130);
  assert.equal(new Set(out.map((p) => p.slug)).size, 130, 'every product once');
  assert.deepEqual([out[0].slug, out[0].domain, out[129].slug], ['p000', 'p000.example.com', 'p129']);
  assert.deepEqual(s.env.PRODUCTS.ops, ['list product:', 'list product:', 'list product:', 'get 100 keys', 'get 30 keys']);
});

test('products: a KV with no product records is an empty list, and a KV that fails is an error', async () => {
  assert.deepEqual(await setup({ 'other:config': {} }).directory.products(), []);
  // A key that is listed and gone by the time it is read is not a product.
  const gone = await setup({ 'product:gone': null, 'product:plain': PRODUCT_RECORDS['product:plain'] }).directory.products();
  assert.deepEqual(gone.map((p) => p.slug), ['plain']);

  const s = setup();
  s.env.PRODUCTS.get = async () => {
    throw new Error('KV GET failed: 500');
  };
  await assert.rejects(s.directory.products(), /KV GET failed/);
  delete s.env.PRODUCTS;
  await assert.rejects(s.directory.products(), TypeError);
});

// ---- nothing secret crosses ---------------------------------------------------

test('no method returns a planted secret, and every secret was planted', async () => {
  const s = setup();
  const answers = {
    feDomains: await s.directory.feDomains(),
    feAliases: await s.directory.feAliases('example.com'),
    products: await s.directory.products(),
  };
  for (const [method, answer] of Object.entries(answers)) {
    const body = JSON.stringify(answer);
    for (const [name, secret] of Object.entries(SECRETS)) {
      assert.ok(!body.includes(secret), `${method} returned ${name}`);
      assert.ok(!body.toLowerCase().includes(secret.toLowerCase()), `${method} returned ${name} in another case`);
    }
  }
  // No URL crosses at all. A webhook is a host and a path, and the one field
  // that holds a scheme, an allowed origin, holds nothing after the host.
  const origins = answers.products.flatMap((p) => p.allowed_origins ?? []).filter((o) => o !== null);
  assert.deepEqual(origins, ['https://acme.example.com', 'https://www.acme.example.com']);
  for (const o of origins) assert.equal(new URL(o).origin, o);
  const withoutOrigins = answers.products.map((p) => ({ ...p, allowed_origins: null }));
  assert.ok(!JSON.stringify([answers.feDomains, answers.feAliases, withoutOrigins]).includes('://'), 'a URL crossed');

  // The needles are real. Each one is in what the stubs handed the Worker, so a
  // clean answer above means it was withheld and not that it was never there.
  const handed = JSON.stringify([FE_DOMAINS, FE_ALIASES, PRODUCT_RECORDS, s.env])
    + JSON.stringify(Object.values(FAILURES).map((f) => f.planted));
  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.ok(handed.includes(secret), `${name} is in no fixture, so nothing was proved about it`);
  }
});

test('webhookShape: a host and at most a route name cross, never the URL', () => {
  const hook = (host, path) => ({ kind: 'webhook', host, path });
  const cases = [
    // herald's two webhooks, which are the reason for the rule.
    ['https://notify.thompsonblack.us/bounce/s3cr3t', hook('notify.thompsonblack.us', '/bounce/[redacted]')],
    ['https://notify.thompsonblack.us/email-in/s3cr3t', hook('notify.thompsonblack.us', '/email-in/[redacted]')],
    ['https://h.example.invalid/bounce/s3cr3t?token=s3cr3t#s3cr3t', hook('h.example.invalid', '/bounce/[redacted]')],
    ['https://h.example.invalid/api/webhooks/123/s3cr3t', hook('h.example.invalid', '/api/[redacted]')],
    ['https://h.example.invalid/bounce//s3cr3t', hook('h.example.invalid', '/bounce/[redacted]')],
    // One segment cannot be told from a token, so it does not cross.
    ['https://h.example.invalid/s3cr3t', hook('h.example.invalid', '/[redacted]')],
    ['https://h.example.invalid/bounce', hook('h.example.invalid', '/[redacted]')],
    ['https://h.example.invalid/bounce/', hook('h.example.invalid', '/[redacted]')],
    // A first segment that does not read as a route name does not cross.
    ['https://h.example.invalid/v1/s3cr3t', hook('h.example.invalid', '/[redacted]')],
    ['https://h.example.invalid/Bounce/s3cr3t', hook('h.example.invalid', '/[redacted]')],
    ['https://h.example.invalid/s3cr3t/inbound', hook('h.example.invalid', '/[redacted]')],
    ['https://h.example.invalid/%62ounce/s3cr3t', hook('h.example.invalid', '/[redacted]')],
    ['https://h.example.invalid/seventeen-letters/s3cr3t', hook('h.example.invalid', '/[redacted]')],
    ['https://h.example.invalid/sixteen-letters-/s3cr3t', hook('h.example.invalid', '/sixteen-letters-/[redacted]')],
    // No path, nothing to redact.
    ['https://h.example.invalid', hook('h.example.invalid', '/')],
    ['https://h.example.invalid/?token=s3cr3t', hook('h.example.invalid', '/')],
    // Userinfo is dropped, the port is kept, and the host is lowercased.
    ['https://user:s3cr3t@h.example.invalid/bounce/s3cr3t', hook('h.example.invalid', '/bounce/[redacted]')],
    ['http://h.example.invalid:8080/bounce/s3cr3t', hook('h.example.invalid:8080', '/bounce/[redacted]')],
    ['HTTPS://H.EXAMPLE.INVALID/bounce/s3cr3t', hook('h.example.invalid', '/bounce/[redacted]')],
    // Not a web URL: no value at all.
    ['ftp://h.example.invalid/drop/s3cr3t', { kind: 'other' }],
    ['mailto:s3cr3t@example.net', { kind: 'other' }],
    ['javascript:s3cr3t', { kind: 'other' }],
    ['h.example.invalid/bounce/s3cr3t', { kind: 'other' }],
    ['s3cr3t', { kind: 'other' }],
    ['', { kind: 'other' }],
    [null, { kind: 'other' }],
    [undefined, { kind: 'other' }],
    [42, { kind: 'other' }],
    [{ url: 's3cr3t' }, { kind: 'other' }],
  ];
  for (const [value, want] of cases) {
    const got = webhookShape(value);
    assert.deepEqual(got, want, String(value));
    assert.ok(!JSON.stringify(got).includes('s3cr3t'), String(value));
  }
});

test('recipientShape: an address is an address, a URL is never one, and the rest has no value', () => {
  const address = (a) => ({ kind: 'email', address: a });
  for (const a of ['michal@example.net', 'first.last+tag@sub.example.co.uk', "o'brien@example.net", 'A_b%c-d@EXAMPLE.net']) {
    assert.deepEqual(recipientShape(a), address(a));
  }

  // The send path's EMAIL_RE matches every one of these, and each holds a secret.
  const loose = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const urls = [
    'https://user:s3cr3t@h.example.invalid/hook/s3cr3t',
    'https://h.example.invalid/s3cr3t@example.net',
    'user:s3cr3t@h.example.invalid',
    's3cr3t/path@h.example.invalid',
    's3cr3t?x@h.example.invalid',
    'x@h.example.invalid/s3cr3t',
    'x@h.example.invalid:8443',
  ];
  for (const value of urls) {
    assert.match(value, loose, 'the control: a loose address test would return this whole');
    const got = recipientShape(value);
    assert.notEqual(got.kind, 'email', value);
    assert.ok(!JSON.stringify(got).includes('s3cr3t'), value);
  }

  for (const value of ['mx.example.net', '192.0.2.7', '2001:db8::7', 'not an address', 'a@b', '@example.net', 'x@', '', 42, null, undefined, {}, ['a@example.net']]) {
    assert.deepEqual(recipientShape(value), { kind: 'other' }, String(value));
  }
});

// ---- read-only ----------------------------------------------------------------

test('no method writes KV, sends mail, or calls Forward Email with anything but GET', async () => {
  const s = setup();
  await s.directory.feDomains();
  await s.directory.feAliases('example.com');
  await s.directory.products();
  await Promise.all(s.pending);

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${DOMAINS_URL}`, `GET ${ALIASES_URL}`]);
  assert.ok(calls.every((c) => c.body === null), 'no request carried a body');
  assert.deepEqual(s.env.PRODUCTS.ops, ['list product:', 'get 3 keys']);
  assert.deepEqual(s.pending, [], 'nothing is deferred past the answer');
});

test('control: the same recorders do see a send and a KV write', async () => {
  // Without this, the test above would pass just as well with deaf recorders.
  const s = setup();
  respond = () => new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
  const res = await worker.fetch(
    new Request('https://mailer.example.invalid/send/plain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Send-Token': SECRETS.send_token },
      body: JSON.stringify({ subject: 'Hello', message: 'A message.' }),
    }),
    s.env,
    s.ctx,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST ${FE}/emails`]);
  assert.notEqual(calls[0].body, null);

  await s.env.PRODUCTS.put('product:plain', '{}');
  assert.deepEqual(s.env.PRODUCTS.ops, ['get product:plain', 'put product:plain']);
});

test('nothing is cached: every call asks again, and returns what it was told that time', async () => {
  const s = setup();
  assert.equal((await s.directory.feDomains()).length, 3);
  forwardEmail({ [DOMAINS_URL]: FE_DOMAINS.slice(1, 2), [ALIASES_URL]: [] });
  assert.deepEqual(await s.directory.feDomains(), DOMAINS_OUT.slice(1, 2));
  assert.deepEqual(await s.directory.feAliases('example.com'), []);
  assert.equal(calls.length, 3);

  assert.equal((await s.directory.products()).length, 3);
  delete s.env.PRODUCTS.records['product:plain'];
  assert.deepEqual((await s.directory.products()).map((p) => p.slug), [null, 'acme']);
});

// ---- failures -----------------------------------------------------------------

test('a Forward Email failure is a thrown error with a code, never an empty list', async () => {
  const s = setup();
  const reads = { feDomains: () => s.directory.feDomains(), feAliases: () => s.directory.feAliases('example.com') };
  for (const [name, failure] of Object.entries(FAILURES)) {
    for (const [method, read] of Object.entries(reads)) {
      calls = [];
      respond = failure.answer;
      const error = await read().then(() => null, (e) => e);
      assert.ok(error instanceof DirectoryError, `${method} did not throw on ${name}`);
      assert.equal(error.name, 'DirectoryError');
      assert.equal(error.code, failure.code, `${method} on ${name}`);
      // The message is exact: the code, then a detail with no body text in it.
      assert.equal(error.message, failure.message, `${method} on ${name}`);
      assert.equal(calls.length, 1, `${method} retried on ${name}`);
      assert.equal(calls[0].method, 'GET');
    }
  }
  await Promise.all(s.pending);
  assert.deepEqual(s.pending, [], 'a failed read reports to nobody but its caller');
  assert.deepEqual(s.env.PRODUCTS.ops, []);
});

test('an account with no domains, and a domain with no aliases, are empty lists', async () => {
  const s = setup();
  forwardEmail({ [DOMAINS_URL]: [], [ALIASES_URL]: [] });
  assert.deepEqual(await s.directory.feDomains(), []);
  assert.deepEqual(await s.directory.feAliases('example.com'), []);

  // A full page that is the whole list is not refused, with or without the header.
  forwardEmail({
    [DOMAINS_URL]: () => listed(FE_DOMAINS, 3),
    [ALIASES_URL]: () => new Response(JSON.stringify(FE_ALIASES), { status: 200 }),
  });
  assert.equal((await s.directory.feDomains()).length, 3);
  assert.equal((await s.directory.feAliases('example.com')).length, 4);
});

// ---- the trust exists only on the entrypoint ---------------------------------

const NOT_FOUND = { error: 'not found', code: 'not_found' };
const HEADERS = {
  'CF-Worker': 'tgwab-admin', 'CF-Service-Binding': 'AdminDirectory', 'CF-Entrypoint': 'AdminDirectory',
  'X-Admin-Directory': '1', 'X-Entrypoint': 'AdminDirectory', 'X-Service-Binding': 'MAILER_DIRECTORY',
  'X-Forwarded-Host': 'mailer.internal', 'X-Forwarded-For': '127.0.0.1',
  Authorization: 'Bearer service-binding:AdminDirectory', 'X-Send-Token': SECRETS.send_token,
  'Cf-Access-Jwt-Assertion': 'service-binding:AdminDirectory', Origin: 'https://admin.tgwab.us',
  Referer: 'https://admin.tgwab.us/mail',
};
const QUERY = '?entrypoint=AdminDirectory&binding=1&method=feDomains&domain=example.com';
const HOSTS = [
  'mailer.thompsonblack.us', 'admin.tgwab.us', 'mailer.internal', 'tgwab-admin', 'mailer', 'admindirectory',
  'localhost', '127.0.0.1',
];

function publicRequest(host, path, method, headers = {}) {
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : JSON.stringify({ entrypoint: 'AdminDirectory', method: 'feDomains', args: ['example.com'], domain: 'example.com' });
  return new Request(`https://${host}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
}

test('no path, method, header, query, or hostname makes a public request the directory', async () => {
  const s = setup();
  const paths = [
    '/feDomains', '/feAliases', '/feAliases/example.com', '/products', '/AdminDirectory', '/AdminDirectory/feDomains',
    '/AdminDirectory/feAliases/example.com', '/AdminDirectory/products', '/admin-directory/products', '/directory',
    '/directory/products', '/rpc/feDomains', '/rpc/AdminDirectory/products', '/api/products', '/api/v1/domains',
    '/v1/domains', '/domains', '/domains/example.com/aliases', '/fe/domains', '/send', '/contact', '/worker.js',
  ];
  for (const host of HOSTS) {
    for (const path of paths) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const tries = [
          publicRequest(host, path, method),
          publicRequest(host, path + QUERY, method),
          publicRequest(host, path + QUERY, method, HEADERS),
          publicRequest(host, `/${path}/`, method, HEADERS),
        ];
        for (const request of tries) {
          const res = await worker.fetch(request, s.env, s.ctx);
          assert.equal(res.status, 404, `${method} ${request.url}`);
          assert.deepEqual(await res.json(), NOT_FOUND, `${method} ${request.url}`);
        }
      }
    }
  }
  assert.deepEqual(calls, [], 'Forward Email was not asked for any of them');
  assert.deepEqual(s.env.PRODUCTS.ops, [], 'the KV was not read for any of them');
});

test('a directory name in the slug position is an unknown product, and lists nothing', async () => {
  const s = setup();
  const slugs = ['feDomains', 'feAliases', 'products', 'AdminDirectory', 'directory'];
  for (const kind of ['send', 'contact']) {
    for (const slug of slugs) {
      for (const [method, status, code] of [['GET', 404, 'not_found'], ['POST', 404, 'unknown_product']]) {
        const res = await worker.fetch(publicRequest('mailer.thompsonblack.us', `/${kind}/${slug}${QUERY}`, method, HEADERS), s.env, s.ctx);
        assert.equal(res.status, status, `${method} /${kind}/${slug}`);
        assert.equal((await res.json()).code, code, `${method} /${kind}/${slug}`);
      }
    }
  }
  assert.deepEqual(calls, [], 'Forward Email was not asked for any of them');
  // The one read the router makes for a slug, as it always has. Never a list.
  assert.equal(s.env.PRODUCTS.ops.length, 20);
  assert.ok(s.env.PRODUCTS.ops.every((op) => /^get product:[a-z]+$/.test(op)), s.env.PRODUCTS.ops.join(', '));
});

test('only the entrypoint module can reach the directory: index.js never imports it', () => {
  const dir = new URL('../src/', import.meta.url);
  const imports = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [
    f,
    // A specifier has no space in it, which is what keeps a comment's prose out.
    [...readFileSync(new URL(f, dir), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"\s]+)['"]/g)]
      .map((m) => m[1].replace(/^\.\//, '')),
  ]));
  assert.ok(imports['index.js'].includes('email.js'), 'the scan reads imports, or this test proves nothing');

  const importers = (target) => Object.keys(imports).filter((f) => imports[f].includes(target));
  assert.deepEqual(importers('directory.js'), ['worker.js']);
  assert.deepEqual(importers('cloudflare:workers'), ['worker.js']);
  assert.deepEqual(importers('worker.js'), []);
  assert.deepEqual(imports['directory.js'], [], 'the directory imports nothing, so it cannot reach the send path either');

  // Everything the public handler can run, transitively.
  const reach = new Set(['index.js']);
  for (const f of reach) for (const dep of imports[f] ?? []) reach.add(dep);
  assert.ok(reach.has('sanitize.js') && reach.has('markdown.js'));
  assert.ok(!reach.has('directory.js') && !reach.has('worker.js'));
});

// ---- the README says what the code does ---------------------------------------

test('README lists every field each method returns, and the binding that reaches them', async () => {
  const s = setup();
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Admin directory'), readme.indexOf('## Deploy'));
  assert.ok(section.length > 0, 'the section exists, between its heading and Deploy');

  const answers = {
    feDomains: await s.directory.feDomains(),
    feAliases: await s.directory.feAliases('example.com'),
    products: await s.directory.products(),
  };
  // Each method has a heading and a table; the first cell of a row names fields.
  const documented = (method) => {
    const start = section.indexOf(`### \`${method}`);
    assert.ok(start >= 0, `no heading for ${method}`);
    const next = section.indexOf('\n### ', start + 1);
    return section.slice(start, next < 0 ? undefined : next).split('\n')
      .filter((line) => line.startsWith('| `'))
      .flatMap((line) => [...line.split('|')[1].matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]));
  };
  for (const [method, rows] of Object.entries(answers)) {
    assert.deepEqual(documented(method), Object.keys(rows[0]), `${method}: the README table and the answer disagree`);
  }
  for (const code of new Set(Object.values(FAILURES).map((f) => f.code)).add('invalid_domain')) {
    assert.ok(section.includes(`\`${code}\``), `the README does not name ${code}`);
  }
  assert.match(section, /\[\[services\]\]\nbinding = "MAILER_DIRECTORY"\nservice = "mailer"\nentrypoint = "AdminDirectory"\n/);
});
