// Switching channels: WhatsApp-only must stop Apps Script from emailing on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startGas, startBridge, waitFor, tempHome, SECRET } from './helpers/harness.js';
import { AppsScriptClient } from '../src/google-chat/chat-client.js';
import { setEnvValue, parseEnvFile } from '../src/config.js';
import { createFakeWhatsApp, linkedHome } from './helpers/fake-whatsapp.js';

const mailCount = async (gas) => (await gas.state()).gmail.reduce((n, t) => n + t.messages.length, 0);
const bridgeProp = async (gas) => JSON.parse((await gas.state()).props.BRIDGE || '{}');

test('setEnvValue replaces or appends a key and keeps comments', () => {
  const file = path.join(tempHome(), '.env');
  fs.writeFileSync(file, '# my settings\nBRIDGE_CHANNELS=gmail\n# keep me\nOTHER=1\n');
  setEnvValue(file, 'BRIDGE_CHANNELS', 'whatsapp');
  setEnvValue(file, 'NEW_KEY', 'x');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# my settings\nBRIDGE_CHANNELS=whatsapp\n# keep me\nOTHER=1\nNEW_KEY=x\n$/);
  assert.deepEqual(parseEnvFile(text), { BRIDGE_CHANNELS: 'whatsapp', OTHER: '1', NEW_KEY: 'x' });
});

test('paused relay sends no emails (offline notice, reminders, re-pushes) until the bridge polls again', async () => {
  const gas = await startGas({ props: { SERVICE_ACCOUNT_JSON: '', PUSH_MODE: 'gmail', CHAT_SPACE: '', OFFLINE_AFTER_MIN: '0' } });
  try {
    const client = new AppsScriptClient({ url: gas.url, secret: SECRET });
    await client.call('ping', {});
    const res = await client.call('setActive', { active: false, channels: ['whatsapp'] });
    assert.equal(res.paused, true);
    await gas.setProps({ BRIDGE: JSON.stringify({ ...(await bridgeProp(gas)), lastSeenAt: Date.now() - 3600_000 }) });
    const before = await mailCount(gas);
    await gas.run('housekeeping');
    await gas.run('gmailPoll');
    assert.equal(await mailCount(gas), before, 'no "bridge offline" email while paused');

    await client.call('poll', { wait: 0 }); // the bridge uses email again
    assert.equal((await bridgeProp(gas)).paused, false);
    // Control: the same situation unpaused does email.
    await gas.setProps({ BRIDGE: JSON.stringify({ ...(await bridgeProp(gas)), lastSeenAt: Date.now() - 3600_000 }) });
    await gas.run('housekeeping');
    assert.ok(await mailCount(gas) > before, '"bridge offline" email once resumed');
  } finally {
    await gas.stop();
  }
});

test('a WhatsApp-only bridge pauses Apps Script when it starts', async () => {
  const gas = await startGas({ props: { SERVICE_ACCOUNT_JSON: '', PUSH_MODE: 'gmail', CHAT_SPACE: '' } });
  const wa = createFakeWhatsApp();
  const b = await startBridge({ gas, home: linkedHome(tempHome()), env: { BRIDGE_CHANNELS: 'whatsapp' }, whatsappLoader: wa.loader });
  try {
    await waitFor(async () => (await bridgeProp(gas)).paused === true, { message: 'relay paused' });
    assert.deepEqual((await bridgeProp(gas)).channels, ['whatsapp']);
  } finally {
    await b.shutdown('done');
    await gas.stop();
  }
});
