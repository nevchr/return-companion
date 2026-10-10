import { expect, test } from '@playwright/test';

const JOURNAL_KEY = 'return-companion-pending-mutation-v1';
const originalOrder = 'NS-DEMO-1001';
const anotherOrder = 'NS-DEMO-1002';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Fetch the real synthetic response first, then withhold delivery to the browser.
// Writes therefore commit in the isolated E2E DB before their response is lost.
async function holdFirstResponse(page, pattern, predicate = () => true, transform) {
  const received = deferred();
  const held = deferred();
  const finished = deferred();
  let captured = false;
  const handler = async (route) => {
    if (captured || !predicate(route.request())) {
      await route.continue();
      return;
    }
    captured = true;
    try {
      const response = await route.fetch();
      const payload = await response.json();
      received.resolve({ payload, body: route.request().postDataJSON() });
      await held.promise;
      try {
        await route.fulfill(transform ? { response, json: transform(payload) } : { response });
      } catch {
        // Cancelling, timing out, or reloading may close the intercepted request.
      }
    } catch (error) {
      received.reject(error);
    } finally {
      finished.resolve();
    }
  };
  await page.route(pattern, handler);
  return {
    received: received.promise,
    release: async () => {
      held.resolve();
      if (captured) await finished.promise;
    },
    dispose: async () => {
      held.resolve();
      if (captured) await finished.promise;
      await page.unroute(pattern, handler);
    },
  };
}

function observeToolCalls(page) {
  const calls = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/mcp' || request.method() !== 'POST') return;
    const message = request.postDataJSON();
    if (message?.method === 'tools/call') calls.push(message.params);
  });
  return calls;
}

const mutationCalls = (calls) => calls.filter(({ name }) => ['prepare_return_proposal', 'submit_simulated_return'].includes(name));
const purchase = (page, orderId) => page.getByRole('radio', { name: new RegExp(orderId) });
const askButton = (page) => page.getByRole('button', { name: 'Ask', exact: true });
const outcome = (page) => page.getByRole('heading', { name: 'Outcome unconfirmed', exact: true });

async function openDemo(page) {
  const health = await (await page.request.get('/api/health')).json();
  expect(health.provider).toBe('deterministic_fake_tool_simulation');
  await page.goto('/');
  await expect(purchase(page, originalOrder)).toBeVisible();
  await expect(askButton(page)).toBeEnabled();
}

async function reviewReceipt(page) {
  await page.getByRole('checkbox', { name: /I reviewed the synthetic receipt/ }).check();
  await page.getByRole('checkbox', { name: /All required accessories are included/ }).check();
}

async function ask(page, message) {
  await page.getByRole('textbox', { name: 'Ask the demo guide' }).fill(message);
  await askButton(page).click();
}

async function finishReadChat(page, orderId) {
  await ask(page, 'Can I return this sample order?');
  await expect(page.locator('.tool-trace code')).toHaveText('check_return_options');
  await expect(page.locator('.tool-trace')).toContainText(orderId);
  await expect(askButton(page)).toBeEnabled();
}

async function savedCases(page) {
  const response = await page.request.get('/api/demo');
  expect(response.ok()).toBeTruthy();
  return (await response.json()).cases;
}

async function readCase(page, caseId) {
  const response = await page.request.get(`/api/cases/${caseId}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function createOfferedCase(page) {
  const response = await page.request.post('/api/cases', { data: {
    order_id: originalOrder, receipt_reviewed: true, accessories_complete: true,
  } });
  expect(response.ok()).toBeTruthy();
  const created = await response.json();
  const offer = await page.request.post(`/api/cases/${created.case_id}/offers`);
  expect(offer.ok()).toBeTruthy();
  return (await offer.json()).case;
}

test('cancelling chat before its response prevents a later MCP mutation', async ({ page }) => {
  const calls = observeToolCalls(page);
  await openDemo(page);
  await reviewReceipt(page);
  const before = (await savedCases(page)).map(({ case_id }) => case_id).sort();
  const held = await holdFirstResponse(page, '**/api/chat');
  try {
    await ask(page, 'Prepare a return proposal for this sample order.');
    const { payload } = await held.received;
    expect(payload.tool_calls[0].name).toBe('prepare_return_proposal');
    await page.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await expect(askButton(page)).toBeEnabled();
    await held.release();
    await held.dispose();
    await finishReadChat(page, originalOrder);
    expect(mutationCalls(calls)).toEqual([]);
    expect((await savedCases(page)).map(({ case_id }) => case_id).sort()).toEqual(before);
    await expect(outcome(page)).toHaveCount(0);
  } finally {
    await held.dispose();
  }
});

test('a late chat result cannot restore the previously selected purchase', async ({ page }) => {
  const calls = observeToolCalls(page);
  await openDemo(page);
  const held = await holdFirstResponse(page, '**/api/chat', () => true,
    (payload) => ({ ...payload, tool_calls: [], reply: 'STALE PURCHASE CHAT RESPONSE' }));
  try {
    await ask(page, 'Can I return this sample order?');
    await held.received;
    // Purchase controls stay locked until the held read reaches the 2s deadline.
    await expect(purchase(page, anotherOrder)).toBeDisabled();
    await expect(purchase(page, anotherOrder)).toBeEnabled({ timeout: 5000 });
    await purchase(page, anotherOrder).click();
    await finishReadChat(page, anotherOrder);
    await held.release();
    await expect(purchase(page, anotherOrder)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.tool-trace')).toContainText(anotherOrder);
    await expect(page.getByText('STALE PURCHASE CHAT RESPONSE', { exact: true })).toHaveCount(0);
    expect(calls.map(({ arguments: args }) => args.order_id)).toEqual([anotherOrder]);
    await expect(page.locator('.active-case-summary')).toHaveCount(0);
  } finally {
    await held.dispose();
  }
});

test('an out-of-order chat response cannot replace a newer conversation', async ({ page }) => {
  await openDemo(page);
  const held = await holdFirstResponse(page, '**/api/chat', () => true,
    (payload) => ({ ...payload, tool_calls: [], reply: 'STALE CONVERSATION RESPONSE' }));
  try {
    await ask(page, 'Show me the old sample order facts.');
    await held.received;
    await page.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await finishReadChat(page, originalOrder);
    const currentConversation = await page.locator('.chat-transcript').textContent();
    await held.release();
    await expect(page.locator('.chat-transcript')).toHaveText(currentConversation);
    await expect(page.getByText('STALE CONVERSATION RESPONSE', { exact: true })).toHaveCount(0);
    await expect(page.locator('.tool-trace code')).toHaveText('check_return_options');
  } finally {
    await held.dispose();
  }
});

test('a late saved-case read cannot overwrite a newer purchase selection', async ({ page }) => {
  const record = await createOfferedCase(page);
  await openDemo(page);
  const held = await holdFirstResponse(page, `**/api/cases/${record.case_id}`,
    (request) => request.method() === 'GET');
  try {
    await page.locator('.saved-case').filter({ hasText: record.case_id }).click();
    await held.received;
    // The timed-out read must remain stale after purchase controls unlock.
    await expect(purchase(page, anotherOrder)).toBeDisabled();
    await expect(purchase(page, anotherOrder)).toBeEnabled({ timeout: 5000 });
    await purchase(page, anotherOrder).click();
    await finishReadChat(page, anotherOrder);
    await held.release();
    await expect(purchase(page, anotherOrder)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.active-case-summary')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Here are your options' })).toHaveCount(0);
    await expect(page.locator('.tool-trace')).toContainText(anotherOrder);
    expect((await readCase(page, record.case_id)).approval).toBeNull();
  } finally {
    await held.dispose();
  }
});

test('synchronous repeated proposal clicks dispatch exactly one mutation', async ({ page }) => {
  const calls = observeToolCalls(page);
  await openDemo(page);
  await reviewReceipt(page);
  const before = (await savedCases(page)).length;
  const held = await holdFirstResponse(page, '**/mcp', (request) => {
    const message = request.postDataJSON();
    return message.method === 'tools/call' && message.params.name === 'prepare_return_proposal';
  });
  try {
    await page.getByRole('button', { name: 'Check return options', exact: true }).evaluate((button) => {
      button.click();
      button.click();
    });
    const { payload } = await held.received;
    expect(mutationCalls(calls)).toHaveLength(1);
    await held.release();
    await expect(page.locator('.active-case-summary')).toContainText(payload.result.structuredContent.case.case_id);
    await expect(askButton(page)).toBeEnabled();
    expect(mutationCalls(calls)).toHaveLength(1);
    expect((await savedCases(page)).length).toBe(before + 1);
    expect((await readCase(page, payload.result.structuredContent.case.case_id)).return).toBeNull();
  } finally {
    await held.dispose();
  }
});

test('a lost proposal response survives reload and only an explicit retry reuses its exact key', async ({ page }) => {
  const calls = observeToolCalls(page);
  await openDemo(page);
  await reviewReceipt(page);
  const before = (await savedCases(page)).map(({ case_id }) => case_id);
  const held = await holdFirstResponse(page, '**/mcp', (request) => {
    const message = request.postDataJSON();
    return message.method === 'tools/call' && message.params.name === 'prepare_return_proposal';
  });
  try {
    await page.getByRole('button', { name: 'Check return options', exact: true }).click();
    const { payload, body } = await held.received;
    const committed = payload.result.structuredContent.case;
    expect(committed.order_id).toBe(originalOrder);
    await expect(outcome(page)).toBeVisible({ timeout: 5000 });
    await expect(askButton(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Check return options', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Confirm simulated return' })).toHaveCount(0);
    const pending = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), JOURNAL_KEY);
    expect(pending.kind).toBe('proposal');
    expect(pending.orderId).toBe(originalOrder);
    expect(pending.args).toEqual(body.params.arguments);
    expect(mutationCalls(calls)).toHaveLength(1);

    await page.reload();
    await expect(outcome(page)).toBeVisible({ timeout: 5000 });
    expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), JOURNAL_KEY)).toEqual(pending);
    await expect(askButton(page)).toBeDisabled();
    expect(mutationCalls(calls)).toHaveLength(1);
    await held.release();
    await held.dispose();
    await page.getByRole('button', { name: 'Retry same reviewed proposal', exact: true }).click();
    await expect(page.locator('.active-case-summary')).toContainText(committed.case_id);
    await expect(outcome(page)).toHaveCount(0);
    await expect(askButton(page)).toBeEnabled();

    const mutations = mutationCalls(calls);
    expect(mutations).toHaveLength(2);
    expect(mutations.map(({ name }) => name)).toEqual(['prepare_return_proposal', 'prepare_return_proposal']);
    expect(mutations[1].arguments).toEqual(mutations[0].arguments);
    expect(mutations[1].arguments.idempotency_key).toBe(body.params.arguments.idempotency_key);
    const newlySaved = (await savedCases(page)).filter(({ case_id }) => !before.includes(case_id));
    expect(newlySaved.map(({ case_id }) => case_id)).toEqual([committed.case_id]);
    const recovered = await readCase(page, committed.case_id);
    expect(recovered.timeline.filter(({ event_type }) => event_type === 'CASE_CREATED')).toHaveLength(1);
    expect(recovered.timeline.filter(({ event_type }) => event_type === 'SIMULATED_RETURN_CREATED')).toHaveLength(0);
    expect(recovered.return).toBeNull();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), JOURNAL_KEY)).toBeNull();
  } finally {
    await held.dispose();
  }
});

test('checking a lost approval restores only its original case and exact saved approval without submitting', async ({ page }) => {
  const calls = observeToolCalls(page);
  const record = await createOfferedCase(page);
  await openDemo(page);
  await page.locator('.saved-case').filter({ hasText: record.case_id }).click();
  await expect(page.locator('.active-case-summary')).toContainText(record.case_id);
  await page.locator('.approval-check').click();
  const held = await holdFirstResponse(page, `**/api/cases/${record.case_id}/approve`);
  const approvals = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/cases/${record.case_id}/approve`) {
      approvals.push(request.postDataJSON());
    }
  });
  try {
    await page.getByRole('button', { name: 'Approve this option', exact: true }).click();
    const { payload } = await held.received;
    const savedApproval = payload.approval ?? payload.case?.approval;
    expect(savedApproval.approval_id).toBeTruthy();
    await expect(outcome(page)).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.confirm-panel button:enabled')).toHaveCount(0);
    await purchase(page, anotherOrder).click();
    await expect(purchase(page, anotherOrder)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: 'Confirm simulated return' })).toHaveCount(0);
    await held.release();
    await held.dispose();

    await page.getByRole('button', { name: 'Check saved progress', exact: true }).click();
    await expect(outcome(page)).toHaveCount(0);
    await expect(purchase(page, originalOrder)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.active-case-summary')).toContainText(record.case_id);
    await expect(page.getByText(/Option approved/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm simulated return' })).toBeEnabled();
    expect(approvals).toHaveLength(1);
    expect(mutationCalls(calls)).toEqual([]);
    const recovered = await readCase(page, record.case_id);
    expect(recovered.approval).toEqual(savedApproval);
    expect(recovered.return).toBeNull();
    expect(recovered.timeline.filter(({ event_type }) => event_type === 'USER_APPROVED_SIMULATION')).toHaveLength(1);
    expect(recovered.timeline.filter(({ event_type }) => event_type === 'SIMULATED_RETURN_CREATED')).toHaveLength(0);
    await purchase(page, anotherOrder).click();
    await expect(page.getByRole('button', { name: 'Confirm simulated return' })).toHaveCount(0);
    await expect(page.getByText(/Option approved/)).toHaveCount(0);
  } finally {
    await held.dispose();
  }
});

test('a received HTTP 500 after approval commits preserves uncertainty until saved progress is checked', async ({ page }) => {
  const calls = observeToolCalls(page);
  const record = await createOfferedCase(page);
  await openDemo(page);
  await page.locator('.saved-case').filter({ hasText: record.case_id }).click();
  await expect(page.locator('.active-case-summary')).toContainText(record.case_id);
  await page.locator('.approval-check').click();
  let committedApproval;
  let dispatched = 0;
  const pattern = `**/api/cases/${record.case_id}/approve`;
  const handler = async (route) => {
    dispatched += 1;
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    committedApproval = (await response.json()).approval;
    await route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ detail: 'Synthetic response failure after approval committed.' }),
    });
  };
  await page.route(pattern, handler);
  try {
    await page.getByRole('button', { name: 'Approve this option', exact: true }).click();
    await expect(outcome(page)).toBeVisible({ timeout: 5000 });
    expect(committedApproval.approval_id).toBeTruthy();
    await expect(page.locator('.confirm-panel button:enabled')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve this option', exact: true })).toBeDisabled();
    const pending = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), JOURNAL_KEY);
    expect(pending.kind).toBe('approve');
    expect(pending.caseId).toBe(record.case_id);
    expect(pending.orderId).toBe(originalOrder);
    expect((await readCase(page, record.case_id)).approval).toEqual(committedApproval);

    await page.getByRole('button', { name: 'Check saved progress', exact: true }).click();
    await expect(outcome(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirm simulated return' })).toBeEnabled();
    expect(dispatched).toBe(1);
    expect(mutationCalls(calls)).toEqual([]);
    const recovered = await readCase(page, record.case_id);
    expect(recovered.approval).toEqual(committedApproval);
    expect(recovered.return).toBeNull();
    expect(recovered.timeline.filter(({ event_type }) => event_type === 'USER_APPROVED_SIMULATION')).toHaveLength(1);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), JOURNAL_KEY)).toBeNull();
  } finally {
    await page.unroute(pattern, handler);
  }
});
