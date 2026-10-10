import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('reviews evidence, uses policy tools, refreshes approval, submits once, and recovers the mock case', async ({ page }, testInfo) => {
  const isMobile = testInfo.project.name === 'mobile';
  const orderId = isMobile ? 'NS-DEMO-1003' : 'NS-DEMO-1001';
  const mcpMethods = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/mcp' && request.method() === 'POST') {
      try { mcpMethods.push(JSON.parse(request.postData()).method); } catch { /* request assertion below will fail */ }
    }
  });
  await page.goto('/');
  await expect(page.getByText('Synthetic receipt loaded')).toBeVisible();

  if (!isMobile) {
    const firstOrder = page.getByRole('radio', { name: /NS-DEMO-1001/ });
    await firstOrder.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /NS-DEMO-1002/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(firstOrder).toHaveAttribute('aria-checked', 'true');
  } else {
    await page.getByRole('radio', { name: /NS-DEMO-1003/ }).click();
    await expect(page.getByText('No delivery date is present.')).toBeVisible();
    await page.getByLabel(/Delivery date from this synthetic receipt/).fill('2026-09-08');
  }

  const receiptReview = page.getByRole('checkbox', { name: /I reviewed the synthetic receipt/ });
  await receiptReview.check();
  await page.getByRole('checkbox', { name: /All required accessories are included/ }).check();
  const chat = page.getByRole('textbox', { name: 'Ask the demo guide' });
  await chat.fill('Can I return this sample order?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.tool-trace code')).toHaveText('check_return_options');
  await expect(page.locator('.tool-trace')).toContainText('MCP Streamable HTTP');
  await expect(page.locator('.chat-turn-assistant').last()).toContainText('eligible');
  expect(mcpMethods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);

  await page.getByRole('button', { name: 'Check return options' }).click();
  await expect(page.getByRole('heading', { name: 'Here are your options' })).toBeVisible();
  await expect(page.getByText(/Oct 8, 2026/)).toBeVisible();
  await expect(page.getByText('OFFER EXPIRES')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('policy-and-receipt.png'), fullPage: true });

  await page.locator('.approval-check').click();
  await page.getByRole('button', { name: 'Approve this option' }).click();
  await expect(page.getByText(/Option approved/)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh offer and require new approval' }).click();
  await expect(page.getByText(/offer was refreshed/i)).toBeVisible();
  await expect(page.getByText(/Option approved/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve this option' })).toBeDisabled();

  await page.locator('.approval-check').click();
  await page.getByRole('button', { name: 'Approve this option' }).click();
  await expect(page.getByText(/Option approved/)).toBeVisible();
  await chat.fill('Send return instructions.');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.tool-trace code')).toHaveText('check_return_options');
  await expect(page.locator('.invalid-label')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm simulated return' })).toBeEnabled();
  if (isMobile) {
    let submissions = 0;
    await page.route('**/mcp', async (route) => {
      const body = route.request().postDataJSON();
      if (body.method !== 'tools/call' || body.params?.name !== 'submit_simulated_return') { await route.continue(); return; }
      submissions++;
      const response = await route.fetch();
      const payload = await response.json();
      await route.fulfill({ response, json: { ...payload, result: { ...payload.result, structuredContent: { ...payload.result.structuredContent, simulation: false, state: 'DRAFT' } } } });
    });
    await chat.fill('Please submit the approved return.');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toBeVisible();
    await expect(page.locator('.invalid-label')).toHaveCount(0);
    await page.getByRole('button', { name: 'Check saved progress', exact: true }).click();
    await expect(page.locator('.invalid-label')).toHaveText('DEMO ONLY - NOT VALID FOR SHIPPING');
    expect(submissions).toBe(1);
    await page.unroute('**/mcp');
  } else {
    // Commit the synthetic submission, then lose its response. Recovery may read
    // the same case but must never dispatch a second submission.
    let release;
    let committed;
    let submitted = 0;
    const held = new Promise((resolve) => { release = resolve; });
    const accepted = new Promise((resolve) => { committed = resolve; });
    await page.route('**/mcp', async (route) => {
      const body = route.request().postDataJSON();
      if (body.method !== 'tools/call' || body.params?.name !== 'submit_simulated_return') {
        await route.continue(); return;
      }
      submitted++;
      const response = await route.fetch();
      committed();
      await held;
      await route.fulfill({ response }).catch(() => {}); // Original request has timed out.
    });
    try {
      await page.getByRole('button', { name: 'Confirm simulated return' }).click();
      await accepted;
      await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toBeVisible();
      await expect(page.locator('.confirm-panel button')).toBeDisabled();
      expect(submitted).toBe(1);
      await page.getByRole('button', { name: 'Check saved progress', exact: true }).click();
      await expect(page.locator('.invalid-label')).toHaveText('DEMO ONLY - NOT VALID FOR SHIPPING');
      await expect(page.getByRole('heading', { name: 'Outcome unconfirmed' })).toHaveCount(0);
      expect(submitted).toBe(1);
    } finally {
      release();
      await page.unroute('**/mcp');
    }
  }
  await expect(page.locator('.invalid-label')).toHaveText('DEMO ONLY - NOT VALID FOR SHIPPING');
  await expect(page.locator(".label-card p:not(.eyebrow)")).toContainText("Pack the fictional headphones");

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download invalid demo label/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('northstar-demo-invalid-label.txt');
  const downloaded = await readFile(await download.path(), 'utf8');
  expect(downloaded).toContain('DEMO ONLY - NOT VALID FOR SHIPPING');

  const caseId = (await page.locator('.return-id code').textContent())?.trim();
  expect(caseId).toMatch(/^NS-RET-DEMO-/);
  await page.reload();
  await page.locator('.saved-case').first().click();
  await expect(page.locator('.return-id code')).toHaveText(caseId);
  await expect(page.locator('.case-status-line')).toContainText('Awaiting Dropoff');
  await expect(page.getByRole('button', { name: 'Confirm simulated return' })).toHaveCount(0);
  await expect(page.getByText(/Option approved/)).toHaveCount(0);
  const bodyWidth = await page.locator('body').evaluate((element) => element.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(testInfo.project.use.viewport.width);
});



