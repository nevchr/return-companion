import { expect, test } from '@playwright/test';

test('read timeout retries only on request and late bootstrap cannot replace newer selection', async ({ page }, testInfo) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let block = true;
  let retries = 0;
  let mutations = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/mcp' && request.postDataJSON()?.method === 'tools/call') mutations++;
  });
  await page.route('**/api/demo', async (route) => {
    if (!block) { retries++; await route.continue(); return; }
    try {
      const response = await route.fetch();
      const payload = await response.json();
      await held;
      await route.fulfill({ response, json: { ...payload, orders: [{ ...payload.orders[0], product_name: 'STALE DEMO DATA' }] } }).catch(() => {});
    } catch { /* StrictMode or navigation may cancel the intercepted bootstrap. */ }
  });
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Retry loading', exact: true })).toBeVisible();
    for (const design of ['Quiet Ledger', 'Return Observatory', 'Field Notes']) {
      await page.getByRole('radio', { name: new RegExp(design) }).check();
      await page.screenshot({ path: testInfo.outputPath(`read-recovery-${design.replaceAll(' ', '-')}.png`), fullPage: true });
      expect(await page.locator('body').evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(testInfo.project.use.viewport.width);
    }
    block = false;
    await page.getByRole('button', { name: 'Retry loading', exact: true }).evaluate((button) => { button.click(); button.click(); });
    await expect(page.getByRole('radio', { name: /NS-DEMO-1002/ })).toBeEnabled();
    expect(retries).toBe(1);
    await page.getByRole('radio', { name: /NS-DEMO-1002/ }).click();
    release();
    await expect(page.getByRole('radio', { name: /NS-DEMO-1002/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('STALE DEMO DATA', { exact: true })).toHaveCount(0);
    expect(mutations).toBe(0);
  } finally { release(); await page.unroute('**/api/demo'); }
});

test('blocked recovery storage prevents the proposal tool from dispatching a mutation', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'return-companion-pending-mutation-v1') throw new Error('Synthetic blocked recovery storage');
      return original.call(this, key, value);
    };
  });
  const calls = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/mcp' && request.postDataJSON()?.method === 'tools/call') calls.push(request.postDataJSON().params.name);
  });
  await page.goto('/');
  await page.getByRole('checkbox', { name: /I reviewed the synthetic receipt/ }).check();
  await page.getByRole('checkbox', { name: /All required accessories are included/ }).check();
  await page.getByRole('button', { name: 'Check return options', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Session recovery storage is unavailable');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Recovery unavailable', exact: true })).toBeVisible();
  expect(calls).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toHaveCount(0);
});

test('an invalid existing journal blocks fresh writes and is never discarded by retry', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('return-companion-pending-mutation-v1', '{malformed synthetic journal'));
  let mutations = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/mcp' && request.postDataJSON()?.method === 'tools/call') mutations++;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recovery unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await expect(page.locator('.start-button')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry recovery storage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recovery unavailable', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('return-companion-pending-mutation-v1'))).toBe('{malformed synthetic journal');
  expect(mutations).toBe(0);
});

test('cancelling an uncommitted approval keeps writes blocked after unchanged reads', async ({ page }) => {
  const created = await (await page.request.post('/api/cases', { data: { order_id: 'NS-DEMO-1001', receipt_reviewed: true, accessories_complete: true } })).json();
  const offered = (await (await page.request.post(`/api/cases/${created.case_id}/offers`)).json()).case;
  await page.goto('/');
  await page.locator('.saved-case').filter({ hasText: created.case_id }).click();
  await page.locator('.approval-check').click();
  let release;
  let started;
  const held = new Promise((resolve) => { release = resolve; });
  const dispatched = new Promise((resolve) => { started = resolve; });
  let body;
  let count = 0;
  await page.route(`**/api/cases/${created.case_id}/approve`, async (route) => {
    count++;
    body = route.request().postDataJSON();
    started();
    await held;
    await route.fulfill({ status: 503, json: { detail: 'Synthetic undelivered approval' } }).catch(() => {});
  });
  try {
    await page.getByRole('button', { name: 'Approve this option', exact: true }).click();
    await dispatched;
    await page.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toBeVisible();
    await page.getByRole('button', { name: 'Check saved progress', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve this option', exact: true })).toBeDisabled();
    expect(count).toBe(1);
    expect(body.offer_id).toBe(offered.offer.offer_id);
    release();
    await page.unroute(`**/api/cases/${created.case_id}/approve`);
    // Finish the original frozen action independently to model a server that
    // accepted a write after the browser stopped waiting; recovery stays read-only.
    expect((await page.request.post(`/api/cases/${created.case_id}/approve`, { data: body })).ok()).toBeTruthy();
    await page.getByRole('button', { name: 'Check saved progress', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirm simulated return', exact: true })).toBeEnabled();
    const saved = await (await page.request.get(`/api/cases/${created.case_id}`)).json();
    expect(saved.return).toBeNull();
    expect(saved.timeline.filter((event) => event.event_type === 'USER_APPROVED_SIMULATION')).toHaveLength(1);
  } finally { release(); await page.unroute(`**/api/cases/${created.case_id}/approve`); }
});

test('an unchanged offer acknowledgement stays unconfirmed across all designs', async ({ page }, testInfo) => {
  const created = await (await page.request.post('/api/cases', { data: { order_id: 'NS-DEMO-1001', receipt_reviewed: true, accessories_complete: true } })).json();
  const offered = (await (await page.request.post(`/api/cases/${created.case_id}/offers`)).json()).case;
  await page.goto('/');
  await page.locator('.saved-case').filter({ hasText: created.case_id }).click();
  const pattern = `**/api/cases/${created.case_id}/offers`;
  await page.route(pattern, (route) => route.fulfill({ json: { case: offered, eligibility: offered.eligibility_result } }));
  try {
    await page.getByRole('button', { name: 'Refresh offer and require new approval' }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toBeVisible();
    await page.getByRole('button', { name: 'Check saved progress', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toBeVisible();
    for (const design of ['Quiet Ledger', 'Return Observatory', 'Field Notes']) {
      await page.getByRole('radio', { name: new RegExp(design) }).check();
      await expect(page.getByRole('button', { name: 'Approve this option', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
      await page.screenshot({ path: testInfo.outputPath(`pending-${design.replaceAll(' ', '-')}.png`), fullPage: true });
      await page.locator('.recovery-panel').screenshot({ path: testInfo.outputPath(`pending-panel-${design.replaceAll(' ', '-')}.png`) });
      for (const selector of ['.recovery-panel > p:not(.eyebrow)', '.recovery-panel dd', '.recovery-panel .button']) {
        const ratio = await page.locator(selector).first().evaluate((element) => {
          const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
          const light = (channels) => channels.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          const foreground = light(rgb(getComputedStyle(element).color));
          const background = light(rgb(getComputedStyle(element.closest('.recovery-panel')).backgroundColor));
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        });
        expect(ratio, `${design} ${selector} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expect(await page.locator('body').evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(testInfo.project.use.viewport.width);
    }
    await page.unroute(pattern);
    expect((await page.request.post(`/api/cases/${created.case_id}/offers`)).ok()).toBeTruthy();
    await page.getByRole('button', { name: 'Check saved progress', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('return-companion-pending-mutation-v1'))).toBeNull();
  } finally { await page.unroute(pattern); }
});

test('a malformed successful proposal retains its key until an explicit replay confirms saved facts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('checkbox', { name: /I reviewed the synthetic receipt/ }).check();
  await page.getByRole('checkbox', { name: /All required accessories are included/ }).check();
  let original;
  let caseId;
  let calls = 0;
  await page.route('**/mcp', async (route) => {
    const message = route.request().postDataJSON();
    if (message.method !== 'tools/call' || message.params.name !== 'prepare_return_proposal') { await route.continue(); return; }
    calls++;
    if (calls > 1) { expect(message.params.arguments).toEqual(original); await route.continue(); return; }
    original = message.params.arguments;
    const response = await route.fetch();
    const payload = await response.json();
    caseId = payload.result.structuredContent.case.case_id;
    await route.fulfill({ response, json: { ...payload, result: { ...payload.result, structuredContent: { case: { case_id: caseId, order_id: original.order_id } } } } });
  });
  try {
    await page.getByRole('button', { name: 'Check return options', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toBeVisible();
    await expect(page.locator('.active-case-summary')).toHaveCount(0);
    expect(calls).toBe(1);
    await page.getByRole('button', { name: 'Retry same reviewed proposal', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toHaveCount(0);
    await expect(page.locator('.active-case-summary')).toContainText(caseId);
    expect(calls).toBe(2);
    const saved = await (await page.request.get(`/api/cases/${caseId}`)).json();
    expect(saved.timeline.filter((event) => event.event_type === 'CASE_CREATED')).toHaveLength(1);
    expect(saved.return).toBeNull();
  } finally { await page.unroute('**/mcp'); }
});

test('proposal recovery preserves an explicitly missing receipt date', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: /NS-DEMO-1003/ }).click();
  await page.getByRole('checkbox', { name: /I reviewed the synthetic receipt/ }).check();
  await page.getByRole('checkbox', { name: /All required accessories are included/ }).check();
  let calls = 0;
  let original;
  let caseId;
  await page.route('**/mcp', async (route) => {
    const message = route.request().postDataJSON();
    if (message.method !== 'tools/call' || message.params.name !== 'prepare_return_proposal') { await route.continue(); return; }
    calls++;
    if (calls > 1) { expect(message.params.arguments).toEqual(original); await route.continue(); return; }
    original = message.params.arguments;
    expect(original.delivery_date_override).toBeNull();
    const response = await route.fetch();
    const payload = await response.json();
    const facts = payload.result.structuredContent;
    caseId = facts.case.case_id;
    await route.fulfill({ response, json: { ...payload, result: { ...payload.result, structuredContent: { ...facts, case: { ...facts.case, order_evidence: { ...facts.case.order_evidence, delivery_date: '2026-09-08' } } } } } });
  });
  try {
    await page.getByRole('button', { name: 'Check return options', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toBeVisible();
    await expect(page.locator('.active-case-summary')).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry same reviewed proposal', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toHaveCount(0);
    await expect(page.locator('.active-case-summary')).toContainText(caseId);
    await expect(page.getByLabel(/Delivery date from this synthetic receipt/)).toHaveValue('');
    const saved = await (await page.request.get(`/api/cases/${caseId}`)).json();
    expect(saved.order_evidence.delivery_date).toBeNull();
    expect(saved.state).toBe('NEEDS_INFO');
    expect(saved.return).toBeNull();
    expect(calls).toBe(2);
  } finally { await page.unroute('**/mcp'); }
});
