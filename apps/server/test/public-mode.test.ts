import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness } from './harness.js';

// Cloud server open to the internet (KPH_PUBLIC=1)
describe('internet mode', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeAll(async () => {
    process.env.KPH_PUBLIC = '1';
    h = await makeHarness();
  });
  afterAll(async () => {
    delete process.env.KPH_PUBLIC;
    await h.close();
  });

  it('a new device needs an admin PIN of 6+ digits to be approved on the spot', async () => {
    const reg = await h.call('POST', '/api/devices/register', { name: 'Phone' }, { device: '' });
    expect(reg.status).toBe(200);
    const short = await h.call('POST', '/api/devices/approve-here', { approverId: h.users.admin.id, pin: '1111' }, { device: reg.body.token });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('PIN_TOO_SHORT');
  });

  it('an already set-up shop asks for no setup code', async () => {
    const b = await h.call('GET', '/api/bootstrap');
    expect(b.body.setupCodeNeeded).toBe(false);
  });
});
