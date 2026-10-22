import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendToCrm, crmConfigured, CrmError } from './crm.mjs';

const URL_ = 'https://script.example.test/exec/SECRET_URL';
const rec = { id: 'r1', name: 'Anna' };
const res = (status, body) => new Response(body, { status });

test('crm: posts JSON with the shared secret in the body', async () => {
  let seen;
  await sendToCrm({ CRM_WEBHOOK_URL: URL_, CRM_WEBHOOK_SECRET: 's3' }, rec, async (u, init) => { seen = { u, init }; return res(200, '{"ok":true}'); });
  assert.equal(seen.u, URL_);
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { id: 'r1', name: 'Anna', secret: 's3' });
});

test('crm: omits the secret field when none is configured', async () => {
  let body;
  await sendToCrm({ CRM_WEBHOOK_URL: URL_ }, rec, async (u, init) => { body = JSON.parse(init.body); return res(200, 'OK'); });
  assert.equal('secret' in body, false);
});

test('crm: configured only with a non-empty URL', () => {
  assert.equal(crmConfigured({}), false);
  assert.equal(crmConfigured({ CRM_WEBHOOK_URL: '  ' }), false);
  assert.equal(crmConfigured({ CRM_WEBHOOK_URL: URL_ }), true);
});

test('crm: HTTP errors, ok:false, network errors and timeouts throw CrmError without leaking the URL', async () => {
  const env = { CRM_WEBHOOK_URL: URL_, HTTP_TIMEOUT_MS: '50' };
  const cases = [
    async () => res(500, 'SECRET_URL'),
    async () => res(200, '{"ok":false,"error":"bad secret"}'),
    async () => { throw new TypeError(URL_); },
    (u, init) => new Promise((_, rej) => { const t = setTimeout(() => {}, 500); init.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error(URL_)); }); }),
  ];
  for (const impl of cases) {
    await assert.rejects(sendToCrm(env, rec, impl), (e) => {
      assert.ok(e instanceof CrmError);
      assert.ok(!e.message.includes('SECRET_URL'));
      return true;
    });
  }
});

test('crm: throws when not configured', async () => {
  await assert.rejects(sendToCrm({}, rec, async () => res(200, '')), CrmError);
});
