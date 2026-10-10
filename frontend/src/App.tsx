import { useEffect, useMemo, useRef, useState } from 'react';
import { buildApprovalRequest } from './approvalRequest.js';
import { callMcpTool } from './mcpClient.js';
import { LocalApiError, MCP_TIMEOUT_MS, requestLocalApi } from './localApi.js';
import { clearPendingMutation, pendingOutcomeIsRecorded, readPendingMutation, savePendingMutation } from './mutationRecovery.js';
import type { PendingMutation } from './mutationRecovery.js';
import { isRequestInterruption, RequestCoordinator } from './requestLifecycle.js';
import type { RequestInterruptionKind, RequestScope } from './requestLifecycle.js';
import './styles.css';

type AnyRecord = Record<string, any>;
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type DesignVariant = 'refined' | 'extravagant' | 'middle';

const DESIGN_VARIANTS: { id: DesignVariant; name: string; subtitle: string }[] = [
  { id: 'refined', name: 'Quiet Ledger', subtitle: 'Refined' },
  { id: 'extravagant', name: 'Return Observatory', subtitle: 'Expressive' },
  { id: 'middle', name: 'Field Notes', subtitle: 'Balanced' },
];

function initialDesign(): DesignVariant {
  try {
    const saved = window.localStorage.getItem('return-companion-design');
    return DESIGN_VARIANTS.some((item) => item.id === saved) ? saved as DesignVariant : 'middle';
  } catch { return 'middle'; }
}

function initialRecovery(): { pending: PendingMutation | null; storageError: string } {
  try { return { pending: readPendingMutation(), storageError: '' }; }
  catch (cause) {
    return { pending: null, storageError: cause instanceof Error ? cause.message : 'Session recovery storage could not be read.' };
  }
}

function providerDescription(provider: AnyRecord | string | null) {
  if (provider === 'deterministic_fake_tool_simulation') return 'No model call - reproducible default';
  if (provider === 'ollama_local_tool_selector') return 'Ollama on loopback - server-gated local tool selection';
  if (typeof provider === 'string') return provider + ' - local only';
  if (!provider) return 'Optional Ollama model · deterministic fake is the default';
  const name = provider.model ?? provider.name ?? provider.provider ?? 'Optional Ollama model';
  const available = provider.available;
  return `${name}${available === false ? ' · unavailable; fake remains available' : ''} · local only`;
}

const money = (cents?: number, currency = 'CAD') =>
  typeof cents === 'number'
    ? new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100)
    : '—';

function unwrap(value: any): any {
  return value?.data ?? value;
}

function asList(value: any, ...keys: string[]): AnyRecord[] {
  const data = unwrap(value);
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function displayDate(value?: string) {
  if (!value) return 'Not provided';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00Z`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeZone: 'America/Toronto' }).format(date);
}

function displayDateTime(value?: string) {
  if (!value) return 'Not provided';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto',
  }).format(date);
}

function statusLabel(value?: string) {
  return (value || 'DRAFT').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function amountFor(offer: AnyRecord) {
  return offer.refund_estimate_cents ?? offer.estimated_refund_cents ?? offer.refund_cents ?? offer.estimate_cents ?? offer.amount_cents;
}

function deadlineFor(value: AnyRecord) {
  return value.deadline_at ?? value.return_by ?? value.deadline ?? value.next_action_due_at;
}

function moveRadio(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
  event.preventDefault();
  const radios = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? []).filter((radio) => !radio.disabled);
  if (!radios.length) return;
  const index = radios.indexOf(event.currentTarget);
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
  const next = radios[(index + step + radios.length) % radios.length];
  next?.focus(); next?.click();
}

export default function App() {
  const [designVariant, setDesignVariant] = useState<DesignVariant>(initialDesign);
  const [orders, setOrders] = useState<AnyRecord[]>([]);
  const [cases, setCases] = useState<AnyRecord[]>([]);
  const [receiptSamples, setReceiptSamples] = useState<AnyRecord>({});
  const [selectedOrder, setSelectedOrder] = useState('');
  const [receiptDateDraft, setReceiptDateDraft] = useState('');
  const [receiptReviewed, setReceiptReviewed] = useState(false);
  const [accessoriesComplete, setAccessoriesComplete] = useState(false);
  const [activeCase, setActiveCase] = useState<AnyRecord | null>(null);
  const [offers, setOffers] = useState<AnyRecord[]>([]);
  const [selectedOffer, setSelectedOffer] = useState('');
  const [approved, setApproved] = useState(false);
  const [approval, setApproval] = useState<AnyRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [chatMessage, setChatMessage] = useState('My headphones stopped working. Can I return them?');
  const [chatReply, setChatReply] = useState('');
  const [toolTrace, setToolTrace] = useState<AnyRecord[]>([]);
  const [toolResults, setToolResults] = useState<AnyRecord[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [modelProvider, setModelProvider] = useState<AnyRecord | string | null>(null);
  const [agentStatus, setAgentStatus] = useState('fake');
  const [fallbackReason, setFallbackReason] = useState('');
  const [recovery] = useState(initialRecovery);
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(recovery.pending);
  const [recoveryStorageError, setRecoveryStorageError] = useState(recovery.storageError);
  const recoveryStorageErrorRef = useRef(recovery.storageError);
  const [readFailed, setReadFailed] = useState(false);
  const pendingRef = useRef(pendingMutation);
  const coordinator = useRef(new RequestCoordinator());
  const actionLock = useRef(false);
  const scopeMutations = useRef(new WeakMap<RequestScope, PendingMutation>());

  function beginAction(writeOrChat = false, replay?: PendingMutation) {
    if (actionLock.current) return null;
    if (writeOrChat && recoveryStorageErrorRef.current) {
      setError('Recovery storage is unavailable. Retry reading it before changing a saved case or asking the guide.');
      return null;
    }
    if (writeOrChat && pendingRef.current && pendingRef.current !== replay) {
      setError('An earlier action has an unconfirmed outcome. Check its saved progress before starting another action.');
      return null;
    }
    const scope = coordinator.current.begin();
    actionLock.current = true;
    setBusy(true); setReadFailed(false);
    return scope;
  }

  function endAction(scope: RequestScope) {
    if (!coordinator.current.finish(scope)) return;
    actionLock.current = false;
    setBusy(false); setLoading(false);
  }

  function cancelRequest(kind: RequestInterruptionKind = 'cancelled') {
    coordinator.current.cancel(kind);
    actionLock.current = false;
    setBusy(false); setLoading(false);
    if (kind === 'cancelled') {
      setNotice(pendingRef.current
        ? 'Request cancelled. Cancellation cannot undo an action already accepted by the local service. Check its saved progress.'
        : 'Request cancelled. You can retry loading or choose another sample purchase.');
      setReadFailed(true);
    }
  }

  function journalMutation(scope: RequestScope, pending: PendingMutation, replay = false) {
    scope.assertCurrent();
    if (recoveryStorageErrorRef.current) throw new Error('Recovery storage is unavailable. This action was not dispatched.');
    if (pendingRef.current && (!replay || pendingRef.current !== pending)) {
      throw new Error('Check the unconfirmed action before changing another saved case.');
    }
    // A storage failure stops the write before dispatch.
    try { savePendingMutation(pending); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Session recovery storage could not be written.';
      recoveryStorageErrorRef.current = message;
      setRecoveryStorageError(message);
      throw cause;
    }
    scope.assertCurrent();
    pendingRef.current = pending;
    setPendingMutation(pending);
    scopeMutations.current.set(scope, pending);
    scope.mutationStarted = true;
  }

  function clearJournal(scope: RequestScope, pending: PendingMutation) {
    scope.assertCurrent();
    if (pendingRef.current !== pending) return;
    try { clearPendingMutation(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Session recovery storage could not be updated.';
      recoveryStorageErrorRef.current = message;
      setRecoveryStorageError(message);
      throw cause;
    }
    pendingRef.current = null;
    setPendingMutation(null);
  }

  function retryRecoveryStorage() {
    try {
      const pending = readPendingMutation();
      pendingRef.current = pending;
      setPendingMutation(pending);
      recoveryStorageErrorRef.current = '';
      setRecoveryStorageError('');
      setError('');
      setNotice(pending ? 'The original pending action was restored. Check its saved progress.' : 'Session recovery storage is readable.');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Session recovery storage is still unavailable.';
      recoveryStorageErrorRef.current = message;
      setRecoveryStorageError(message);
    }
  }

  function mutation(kind: PendingMutation['kind'], orderId: string, id: string | null, args: AnyRecord): PendingMutation {
    return { version: 1, kind, orderId, caseId: id, args: JSON.parse(JSON.stringify(args)), startedAt: new Date().toISOString(),
      ...(kind === 'offer' ? { beforeOfferId: currentOfferId } : {}) };
  }

  function handleFailure(scope: RequestScope, cause: unknown, fallback: string, read = false) {
    if (!scope.isCurrent()) return;
    const pending = scopeMutations.current.get(scope);
    // Server errors can follow committed writes. Only received 4xx rejects one.
    if (pending && cause instanceof LocalApiError && cause.status >= 400 && cause.status < 500) {
      try { clearJournal(scope, pending); }
      catch (storageError) {
        setError(storageError instanceof Error ? storageError.message : 'Recovery storage could not be updated.');
        return;
      }
    }
    if (read) setReadFailed(true);
    const message = isRequestInterruption(cause) && cause.kind === 'timeout'
      ? 'The request timed out. Check saved progress before repeating an action that may have been accepted.'
      : cause instanceof Error ? cause.message : fallback;
    setError(message.includes('OFFER_EXPIRED')
      ? 'This offer expired. Refresh it below, then review and approve the fresh terms.' : message);
  }

  async function request(scope: RequestScope, path: string, method = 'GET', body?: AnyRecord) {
    scope.assertCurrent();
    try {
      const result = await requestLocalApi(path, { method, body, signal: scope.signal });
      scope.assertCurrent();
      return result;
    } catch (cause) {
      if (method === 'GET' && scope.isCurrent()) setReadFailed(true);
      throw cause;
    }
  }

  async function refresh(scope: RequestScope) {
    scope.assertCurrent(); setLoading(true);
    const payload = unwrap(await request(scope, '/api/demo'));
    scope.assertCurrent();
    const nextOrders = asList(payload, 'orders', 'purchases');
    setModelProvider(payload.model_provider ?? null);
    setReceiptSamples(payload.receipt_samples ?? {});
    setOrders(nextOrders); setCases(asList(payload, 'cases'));
    if (!selectedOrder && nextOrders[0]) {
      setSelectedOrder(nextOrders[0].order_id ?? nextOrders[0].id ?? '');
      setReceiptDateDraft(nextOrders[0].delivery_date ?? '');
    }
    setLoading(false);
  }

  function verifyCase(record: AnyRecord, id: string, orderId?: string) {
    if ((record.case_id ?? record.id) !== id || (orderId && record.order_id !== orderId)) {
      throw new Error('The local service returned a different case. The original action remains unconfirmed.');
    }
  }

  async function loadCase(scope: RequestScope, id: string, orderId?: string) {
    const result = await request(scope, '/api/cases/' + encodeURIComponent(id));
    scope.assertCurrent();
    const record = result.case ?? result;
    verifyCase(record, id, orderId);
    applyCaseRecord(record);
    return record;
  }

  async function reconcilePending(scope: RequestScope, pending: PendingMutation) {
    scope.assertCurrent();
    if (!pending.caseId) {
      setNotice('This proposal has no confirmed case ID. Use Retry same reviewed proposal to retrieve or save the exact original proposal with its original key.');
      return;
    }
    const result = await request(scope, '/api/cases/' + encodeURIComponent(pending.caseId));
    scope.assertCurrent();
    const record = result.case ?? result;
    verifyCase(record, pending.caseId, pending.orderId);
    clearConversation(); setSelectedOrder(pending.orderId); applyCaseRecord(record);
    if (pendingOutcomeIsRecorded(pending, record)) {
      clearJournal(scope, pending);
      setNotice('The original action is recorded in its saved case. Review the recovered progress before continuing.');
    } else {
      setNotice('The saved case does not yet confirm the original action. Its outcome remains unconfirmed; another write is blocked.');
    }
  }

  async function retryLoading() {
    const scope = beginAction();
    if (!scope) return;
    setError(''); setNotice('');
    try {
      await refresh(scope);
      scope.assertCurrent();
      const pending = pendingRef.current;
      if (pending?.caseId) {
        await reconcilePending(scope, pending);
        scope.assertCurrent();
      } else if (caseId) {
        await loadCase(scope, caseId, selectedOrder);
        scope.assertCurrent();
      }
    } catch (cause) { handleFailure(scope, cause, 'Could not load the local demo.', true); }
    finally { endAction(scope); }
  }

  useEffect(() => {
    void retryLoading();
    const onPageHide = () => cancelRequest('navigation');
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      coordinator.current.cancel('navigation');
      actionLock.current = false;
    };
  }, []); // StrictMode cleanup invalidates the first read before the next setup.

  useEffect(() => {
    try { window.localStorage.setItem('return-companion-design', designVariant); } catch { /* Selection remains available for this visit. */ }
    document.body.dataset.design = designVariant;
  }, [designVariant]);

  const selectedOrderRecord = useMemo(
    () => orders.find((item) => (item.order_id ?? item.id) === selectedOrder), [orders, selectedOrder],
  );
  const currentOffers = offers.length ? offers : (activeCase?.offer?.options ?? activeCase?.offers ?? activeCase?.options ?? activeCase?.eligibility?.options ?? activeCase?.eligibility_result?.options ?? []);
  const chosenOffer = currentOffers.find((item: AnyRecord) => (item.offer_id ?? item.option_id ?? item.id) === selectedOffer) ?? currentOffers[0];
  const caseId = activeCase?.case_id ?? activeCase?.id;
  const currentOfferId = activeCase?.offer?.offer_id ?? activeCase?.offer_id;
  const currentStatus = String(activeCase?.state ?? activeCase?.status ?? '').toUpperCase();
  const canSubmit = Boolean(approval?.approval_id) && activeCase?.order_id === selectedOrder && currentStatus === 'AWAITING_APPROVAL'
    && approval?.offer_id === currentOfferId && approval?.case_revision === activeCase?.revision
    && (activeCase?.offer?.options ?? []).some((option: AnyRecord) => option.terms_hash === approval?.terms_hash);
  const writesBlocked = Boolean(pendingMutation) || Boolean(recoveryStorageError);
  const evidenceLocked = busy || writesBlocked || (Boolean(activeCase) && currentStatus !== 'NEEDS_INFO');
  const timeline = activeCase?.events ?? activeCase?.timeline ?? activeCase?.history ?? [];
  const currentInstructions = activeCase?.instructions ?? activeCase?.return?.instructions;

  function clearConversation() {
    setChatHistory([]); setChatReply(''); setToolTrace([]); setToolResults([]);
    setFallbackReason(''); setAgentStatus('fake');
  }

  function selectPurchase(order: AnyRecord) {
    const id = order.order_id ?? order.id;
    if (selectedOrder === id) return;
    cancelRequest('superseded'); clearConversation();
    setSelectedOrder(id); setReceiptDateDraft(order.delivery_date ?? '');
    setReceiptReviewed(false); setAccessoriesComplete(false);
    setActiveCase(null); setOffers([]); setSelectedOffer('');
    setApproval(null); setApproved(false); setError(''); setNotice(''); setReadFailed(false);
  }

  function applyCaseRecord(record: AnyRecord) {
    setActiveCase(record);
    if (record.order_evidence) {
      setReceiptDateDraft(record.order_evidence.delivery_date ?? '');
      setReceiptReviewed(true); setAccessoriesComplete(Boolean(record.accessories_complete));
    }
    const list = asList(record, 'offers', 'options');
    setOffers(list.length ? list : (record.offer?.options ?? []));
    setApproval(record.approval ?? null); setApproved(Boolean(record.approval));
    const approvedTerms = record.approval?.terms_hash;
    const approvedOffer = approvedTerms && (record.offer?.options ?? list).find((offer: AnyRecord) => offer.terms_hash === approvedTerms);
    setSelectedOffer(approvedOffer?.offer_id ?? approvedOffer?.option_id ?? approvedOffer?.id ?? '');
  }

  function acceptProposal(scope: RequestScope, facts: AnyRecord, pending: PendingMutation) {
    scope.assertCurrent();
    const proposal = facts.case;
    if (!proposal?.case_id || proposal.order_id !== pending.orderId || !proposal.order_evidence
      || !['AWAITING_APPROVAL', 'NEEDS_INFO', 'INELIGIBLE', 'AWAITING_DROPOFF', 'DROPPED_OFF', 'RECEIVED', 'REFUNDED'].includes(proposal.state)
      || proposal.order_evidence.order_id !== pending.orderId || !facts.eligibility?.status
      || proposal.issue !== pending.args.issue || proposal.condition !== pending.args.condition
      || proposal.accessories_complete !== pending.args.accessories_complete
      || (Object.prototype.hasOwnProperty.call(pending.args, 'delivery_date_override')
        && (proposal.order_evidence.delivery_date ?? null) !== (pending.args.delivery_date_override ?? null))
      || (proposal.state === 'AWAITING_APPROVAL' && (!proposal.offer?.offer_id || !proposal.offer?.options?.length))) {
      throw new Error('The proposal tool did not confirm a saved case for the original sample order.');
    }
    setSelectedOrder(pending.orderId);
    applyCaseRecord({ ...proposal, eligibility_result: facts.eligibility ?? proposal.eligibility_result });
    clearJournal(scope, pending);
    setNotice('A proposal was saved locally. Review its exact terms and explicitly approve before confirming the simulation.');
    return proposal;
  }

  async function prepareProposal(scope: RequestScope, pending: PendingMutation, replay = false) {
    scope.assertCurrent();
    const prepared = await callMcpTool('prepare_return_proposal', pending.args, {
      signal: scope.signal, timeoutMs: MCP_TIMEOUT_MS, allowMutation: true,
      onMutationStart: () => journalMutation(scope, pending, replay),
    });
    scope.assertCurrent();
    const proposal = acceptProposal(scope, prepared.data, pending);
    setToolTrace([{ ...prepared.trace }]);
    setToolResults([{ name: prepared.trace.name, result: prepared.data }]);
    await refresh(scope);
    scope.assertCurrent();
    return { proposal, facts: prepared.data };
  }

  async function startCase() {
    if (!selectedOrder || !receiptReviewed || pendingRef.current) return;
    const correctedNeedsInfo = activeCase?.order_id === selectedOrder && currentStatus === 'NEEDS_INFO' && (
      Boolean(activeCase.accessories_complete) !== accessoriesComplete ||
      (activeCase.order_evidence?.delivery_date ?? '') !== (receiptDateDraft || '')
    );
    if (activeCase?.order_id === selectedOrder && !correctedNeedsInfo) {
      setNotice('A case is already active for this sample order. Continue reviewing it below or reopen its saved case.');
      return;
    }
    const scope = beginAction(true);
    if (!scope) return;
    setError(''); setNotice('');
    const pending = mutation('proposal', selectedOrder, null, {
      order_id: selectedOrder, issue: 'defective', condition: 'opened',
      accessories_complete: accessoriesComplete, receipt_reviewed: true,
      delivery_date_override: receiptDateDraft || null,
      idempotency_key: 'proposal-' + (globalThis.crypto?.randomUUID?.() ?? (Date.now() + '-' + Math.random().toString(16).slice(2))),
    });
    try {
      await prepareProposal(scope, pending);
      scope.assertCurrent();
    } catch (cause) { handleFailure(scope, cause, 'Could not prepare this demo case.'); }
    finally { endAction(scope); }
  }

  async function retrySameProposal() {
    const pending = pendingRef.current;
    if (pending?.kind !== 'proposal') return;
    const scope = beginAction(true, pending);
    if (!scope) return;
    setError(''); setNotice('');
    try {
      await prepareProposal(scope, pending, true);
      scope.assertCurrent();
    } catch (cause) { handleFailure(scope, cause, 'The original proposal could not be retrieved.'); }
    finally { endAction(scope); }
  }

  async function refreshOffer() {
    if (!caseId || activeCase?.order_id !== selectedOrder || currentStatus !== 'AWAITING_APPROVAL') return;
    const scope = beginAction(true);
    if (!scope) return;
    setError(''); setNotice('');
    const pending = mutation('offer', selectedOrder, caseId, {});
    try {
      journalMutation(scope, pending);
      const result = await request(scope, '/api/cases/' + encodeURIComponent(caseId) + '/offers', 'POST', pending.args);
      scope.assertCurrent();
      const record = result.case ?? result;
      verifyCase(record, caseId, selectedOrder);
      if (!pendingOutcomeIsRecorded(pending, record)) throw new Error('The response did not confirm a replacement offer. Check saved progress before continuing.');
      applyCaseRecord({ ...record, eligibility_result: result.eligibility ?? record.eligibility_result });
      clearJournal(scope, pending);
      setNotice('The offer was refreshed. Review its terms and approve the new offer again.');
      await refresh(scope);
      scope.assertCurrent();
    } catch (cause) { handleFailure(scope, cause, 'The offer could not be refreshed.'); }
    finally { endAction(scope); }
  }

  async function approveOffer() {
    if (!caseId || activeCase?.order_id !== selectedOrder || !chosenOffer || !approved || approval || currentStatus !== 'AWAITING_APPROVAL') return;
    const scope = beginAction(true);
    if (!scope) return;
    setError(''); setNotice('');
    try {
      const pending = mutation('approve', selectedOrder, caseId, buildApprovalRequest(activeCase, chosenOffer));
      journalMutation(scope, pending);
      const result = await request(scope, '/api/cases/' + encodeURIComponent(caseId) + '/approve', 'POST', pending.args);
      scope.assertCurrent();
      const record = result.case ?? result;
      verifyCase(record, caseId, selectedOrder);
      if (!record.approval?.approval_id || !pendingOutcomeIsRecorded(pending, record)) {
        throw new Error('The API did not confirm the exact saved approval. Check saved progress before continuing.');
      }
      applyCaseRecord(record); clearJournal(scope, pending);
      setNotice('Approval recorded for this exact simulated option. You still need to confirm the simulated return below.');
      await loadCase(scope, caseId, selectedOrder);
      scope.assertCurrent();
    } catch (cause) { handleFailure(scope, cause, 'Approval could not be recorded.'); }
    finally { endAction(scope); }
  }

  async function submitReturn() {
    if (!caseId || !canSubmit || pendingRef.current) return;
    const scope = beginAction(true);
    if (!scope) return;
    setError(''); setNotice('');
    try {
      const message = 'Confirm the simulated return for this approved case.';
      await executeChat(scope, message, [...chatHistory, { role: 'user' as const, content: message }].slice(-16), caseId);
      scope.assertCurrent();
    } catch (cause) { handleFailure(scope, cause, 'The simulated request could not be completed.'); }
    finally { endAction(scope); }
  }

  async function openCase(item: AnyRecord) {
    const id = item.case_id ?? item.id;
    if (!id) return;
    cancelRequest('superseded');
    const scope = beginAction();
    if (!scope) return;
    setError(''); setNotice('');
    try {
      const record = await loadCase(scope, id, item.order_id);
      scope.assertCurrent();
      if (caseId !== id) clearConversation();
      setSelectedOrder(record.order_id);
    } catch (cause) { handleFailure(scope, cause, 'Could not open saved case.', true); }
    finally { endAction(scope); }
  }

  async function refreshSavedProgress() {
    const scope = beginAction();
    if (!scope) return;
    setError(''); setNotice('');
    try {
      const pending = pendingRef.current;
      if (pending) {
        await reconcilePending(scope, pending);
        scope.assertCurrent();
      } else if (caseId) {
        await loadCase(scope, caseId, selectedOrder);
        scope.assertCurrent();
      }
      await refresh(scope);
      scope.assertCurrent();
    } catch (cause) { handleFailure(scope, cause, 'Could not refresh saved progress.', true); }
    finally { endAction(scope); }
  }

  async function sendChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOrder || !chatMessage.trim()) return;
    const scope = beginAction(true);
    if (!scope) return;
    const userMessage = chatMessage.trim();
    const nextHistory = [...chatHistory, { role: 'user' as const, content: userMessage }].slice(-16);
    setError(''); setNotice('');
    try {
      await executeChat(scope, userMessage, nextHistory, caseId ?? null);
      scope.assertCurrent();
    } catch (cause) { handleFailure(scope, cause, 'The local demo guide is unavailable.'); }
    finally { endAction(scope); }
  }

  async function executeChat(scope: RequestScope, userMessage: string, nextHistory: ChatMessage[], selectedCaseId: string | null) {
    scope.assertCurrent();
    if (pendingRef.current) throw new Error('Check the unconfirmed action before asking the guide.');
    const result = await request(scope, '/api/chat', 'POST', {
      message: userMessage, history: chatHistory.slice(-16), order_id: selectedOrder,
      ...(selectedCaseId ? { case_id: selectedCaseId } : {}), issue: 'defective', condition: 'opened',
      accessories_complete: accessoriesComplete, receipt_reviewed: receiptReviewed,
      ...(receiptReviewed ? { delivery_date_override: receiptDateDraft || null } : {}),
    });
    scope.assertCurrent();
    const tool = result.tool_calls?.[0];
    let reply = result.reply ?? 'Choose a sample purchase to get started.';
    if (tool) {
      const args = JSON.parse(JSON.stringify(tool.arguments ?? {}));
      const proposalTool = tool.name === 'prepare_return_proposal';
      const submitTool = tool.name === 'submit_simulated_return';
      if (pendingRef.current) throw new Error('An earlier action is unconfirmed. Check saved progress first.');
      if (proposalTool && (!receiptReviewed || args.order_id !== selectedOrder || args.receipt_reviewed !== true
        || args.accessories_complete !== accessoriesComplete || (args.delivery_date_override ?? null) !== (receiptDateDraft || null))) {
        throw new Error('The proposal does not match the receipt evidence you reviewed.');
      }
      if (submitTool && (!canSubmit || !selectedCaseId || args.case_id !== selectedCaseId || selectedCaseId !== caseId
        || args.approval_id !== approval?.approval_id || activeCase?.order_id !== selectedOrder)) {
        throw new Error('The submission does not match the currently approved case and sample order.');
      }
      if (!submitTool && args.order_id !== selectedOrder) throw new Error('The guide selected a different sample purchase.');
      const pending = proposalTool || submitTool
        ? mutation(proposalTool ? 'proposal' : 'submit', selectedOrder, submitTool ? selectedCaseId : null, args) : null;
      scope.assertCurrent();
      const mcp = await callMcpTool(tool.name, args, {
        signal: scope.signal, timeoutMs: MCP_TIMEOUT_MS, allowMutation: Boolean(pending),
        ...(pending ? { onMutationStart: () => journalMutation(scope, pending) } : {}),
      });
      scope.assertCurrent();
      const facts = mcp.data;
      setToolTrace([{ ...tool, transport: mcp.trace.transport, protocolVersion: mcp.trace.protocolVersion }]);
      setToolResults([{ name: tool.name, result: facts }]);
      if (submitTool && pending) {
        const savedReturn = facts.return ?? facts;
        if (savedReturn.case_id !== selectedCaseId || !savedReturn.return_id || savedReturn.simulation !== true
          || !['AWAITING_DROPOFF', 'DROPPED_OFF', 'RECEIVED', 'REFUNDED'].includes(savedReturn.state)
          || savedReturn.option?.terms_hash !== approval?.terms_hash) {
          throw new Error('The submission response did not confirm the original case. Check saved progress.');
        }
        // The submit tool returns flattened facts. Preserve them before a later read.
        applyCaseRecord({ ...activeCase, ...savedReturn, return: savedReturn });
        clearJournal(scope, pending);
        setNotice('Simulated return request recorded. No retailer was contacted and no refund or postage was issued.');
        reply = 'The simulated return is recorded. A mock label and instructions are saved with your case.';
        setChatReply(reply); setChatHistory([...nextHistory, { role: 'assistant' as const, content: reply }].slice(-16));
        await loadCase(scope, selectedCaseId!, selectedOrder);
        scope.assertCurrent();
        await refresh(scope);
        scope.assertCurrent();
      } else if (proposalTool && pending) {
        const proposal = acceptProposal(scope, facts, pending);
        reply = 'I saved a proposal for ' + (proposal.order_evidence?.product_name ?? 'this synthetic order')
          + '. The policy result is ' + (facts.eligibility?.status ?? 'ready for review')
          + '. Review the exact terms and approve them in the form; I cannot submit a return.';
        await refresh(scope);
        scope.assertCurrent();
      } else if (!reply.startsWith('I cannot approve')) {
        if (tool.name === 'check_return_options') {
          const eligibility = facts.eligibility;
          const reasons = (eligibility.reason_codes ?? []).join(', ');
          const choices = (eligibility.options ?? []).map((item: AnyRecord) => item.option_id + ' (' + item.refund_cents + ' cents, ' + item.fee_cents + ' cent fee)').join(', ');
          reply = eligibility.status === 'eligible'
            ? 'The Northstar policy result is eligible until ' + eligibility.deadline_at + '. Options: ' + choices + '. Review and approve the exact terms in the form; I cannot submit a return.'
            : 'The Northstar policy result is ' + eligibility.status + ': ' + reasons + '. I cannot approve or submit a return.';
        } else {
          reply = 'This is synthetic order ' + facts.order_id + ' for ' + facts.product_name + '. Delivery date: '
            + (facts.delivery_date || 'not provided') + '. Verified receipt fields: ' + (facts.verified_fields ?? []).join(', ') + '.';
        }
      }
    }
    scope.assertCurrent();
    setChatReply(reply);
    if (result.provider !== undefined) setModelProvider(result.provider);
    setAgentStatus(result.agent_status ?? 'fake'); setFallbackReason(result.fallback_reason ?? '');
    setChatHistory([...nextHistory, { role: 'assistant' as const, content: reply }].slice(-16));
  }

  async function advance(status: string) {
    if (!caseId || activeCase?.order_id !== selectedOrder) return;
    const scope = beginAction(true);
    if (!scope) return;
    setError(''); setNotice('');
    const pending = mutation('advance', selectedOrder, caseId, { status });
    try {
      journalMutation(scope, pending);
      const result = await request(scope, '/api/demo/cases/' + encodeURIComponent(caseId) + '/advance', 'POST', pending.args);
      scope.assertCurrent();
      const record = result.case ?? result;
      verifyCase(record, caseId, selectedOrder);
      if (!pendingOutcomeIsRecorded(pending, record)) throw new Error('The status response did not confirm the requested saved progress.');
      applyCaseRecord(record); clearJournal(scope, pending);
      setNotice('Demo status advanced to ' + statusLabel(status) + '.');
      await refresh(scope);
      scope.assertCurrent();
    } catch (cause) { handleFailure(scope, cause, 'Demo status could not be advanced.'); }
    finally { endAction(scope); }
  }

  return (
    <main className="app-shell" data-design={designVariant}>
      <header className="topbar">
        <a className="brand" href="#home" aria-label="Return Companion home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span><strong>return companion</strong><small>Northstar Demo Store</small></span>
        </a>
        <div className="top-meta"><span className="demo-date"><span className="calendar-icon" aria-hidden="true">▦</span> Demo date · Oct 2, 2026</span><span className="simulation-pill"><i /> SIMULATION</span></div>
      </header>

      <fieldset className="design-switcher">
        <legend>Choose a visual version</legend>
        <div className="design-choices">
          {DESIGN_VARIANTS.map((variant) => <label className={`design-choice ${designVariant === variant.id ? 'selected' : ''}`} key={variant.id}>
            <input type="radio" name="design-version" value={variant.id} checked={designVariant === variant.id} onChange={() => setDesignVariant(variant.id)} />
            <span><strong>{variant.name}</strong><small>{variant.subtitle}</small></span>
          </label>)}
        </div>
      </fieldset>

      <section className="simulation-banner" role="note">
        <span className="banner-icon" aria-hidden="true">✳</span>
        <div><strong>Everything here is a simulation.</strong><span>Fictional orders and policy. No retailer contact, real return, refund, or shipping label.</span></div>
        <span className="banner-tag">LOCAL DEMO</span>
      </section>

      <div className="page-heading" id="home">
        <div><p className="eyebrow">YOUR RETURN, MADE CLEAR</p><h1>Let’s sort this out.</h1><p className="intro">Tell us what went wrong. We’ll check the demo policy and lay out a clear next step.</p></div>
        <div className="secure-note"><span aria-hidden="true">⌂</span> Stays on this device</div>
      </div>

      {(error || notice) && <div className={`flash ${error ? 'flash-error' : 'flash-success'}`} role={error ? 'alert' : 'status'}>{error || notice}<button onClick={() => { setError(''); setNotice(''); }} aria-label="Dismiss message">×</button></div>}

      {busy && <div className="request-controls" role="status"><span>A local request is in progress.</span><button className="button button-secondary" onClick={() => cancelRequest()}>Cancel request</button><small>Cancellation cannot undo an action already accepted by the local service.</small></div>}
      {readFailed && !busy && <div className="request-controls"><span>Loading stopped. Your confirmed progress is preserved.</span><button className="button button-secondary" onClick={() => void retryLoading()}>Retry loading</button></div>}
      {recoveryStorageError && <section className="recovery-panel" aria-labelledby="storage-recovery-title"><h2 id="storage-recovery-title">Recovery unavailable</h2><p>{recoveryStorageError}</p><p>Saved actions and guide requests are paused while the session recovery record is unreadable. You can continue reading sample purchases and saved cases.</p><button className="button button-secondary" disabled={busy} onClick={retryRecoveryStorage}>Retry recovery storage</button></section>}
      {pendingMutation && <section className="recovery-panel" aria-labelledby="recovery-title">
        <p className="eyebrow">LOCAL SIMULATION RECOVERY</p><h2 id="recovery-title">Outcome unconfirmed</h2>
        <p>The {pendingMutation.kind === 'offer' ? 'offer refresh' : pendingMutation.kind} request may have been accepted. New saved actions and guide requests are paused until its original outcome is confirmed.</p>
        <dl><div><dt>Sample order</dt><dd>{pendingMutation.orderId}</dd></div><div><dt>Original case</dt><dd>{pendingMutation.caseId ?? 'No case ID confirmed yet'}</dd></div></dl>
        <p>Cancellation cannot undo an accepted action. Checking saved progress only reads the original case; it never approves or submits a return.</p>
        <div className="recovery-actions"><button className="button button-secondary" disabled={busy || !pendingMutation.caseId} onClick={() => void refreshSavedProgress()}>Check saved progress</button>
          {pendingMutation.kind === 'proposal' && <button className="button button-secondary" disabled={busy || Boolean(recoveryStorageError)} onClick={() => void retrySameProposal()}>Retry same reviewed proposal</button>}
        </div>
        {pendingMutation.kind === 'proposal' && <small>Retrying uses the exact original reviewed evidence and the same proposal key. It can retrieve an accepted proposal or save it once; your current purchase selection and edits are not used.</small>}
      </section>}

      <ol className="progress-ribbon" aria-label="Return steps">
        <li className="is-current"><span>01</span> Purchase</li><li className={activeCase ? 'is-current' : ''}><span>02</span> Options</li><li className={canSubmit || currentStatus === 'AWAITING_DROPOFF' ? 'is-current' : ''}><span>03</span> Confirmation</li>
      </ol>

      <div className="workspace-grid">
        <section className="main-column" aria-label="Return workflow">
          <article className="card order-card">
            <div className="card-heading"><div className="step-number">01</div><div><p className="eyebrow">START WITH A PURCHASE</p><h2>Which item needs help?</h2></div><span className="card-icon order-icon" aria-hidden="true">▧</span></div>
            <p className="subtext">Choose a fictional Northstar order to check its return options.</p>
            {loading && orders.length === 0 ? <div className="loading-line">Loading sample orders…</div> : orders.length === 0 ? <div className="empty-state">No sample orders were returned by the local API yet.</div> : <div className="order-list" role="radiogroup" aria-label="Sample purchases">
              {orders.map((order) => {
                const id = order.order_id ?? order.id;
                const selected = selectedOrder === id;
                return <button key={id} type="button" role="radio" tabIndex={selected ? 0 : -1} aria-checked={selected} disabled={busy} onKeyDown={moveRadio} className={`order-option ${selected ? 'selected' : ''}`} onClick={() => selectPurchase(order)}>
                  <span className="product-thumb" aria-hidden="true"><span>♫</span></span><span className="order-details"><strong>{order.product_name ?? order.name ?? 'Sample purchase'}</strong><span>Order {id} <b>·</b> Delivered {displayDate(order.delivery_date)}</span></span><span className="order-price">{money(order.paid_total_cents ?? ((order.item_cents ?? 0) + (order.tax_cents ?? 0)), order.currency)}</span><span className={`radio-dot ${selected ? 'checked' : ''}`} aria-hidden="true" />
                </button>;
              })}
            </div>}
            <div className="order-evidence"><span className="checkmark" aria-hidden="true">OK</span><span><strong>Synthetic receipt loaded</strong><small>Local text fixture; no upload or personal data</small></span><span className="evidence-tag">SAMPLE</span></div>
            {selectedOrderRecord && receiptSamples[selectedOrder] && <details open className="receipt-preview"><summary>Review and edit extracted receipt fields</summary><pre>{receiptSamples[selectedOrder].text}</pre><label className="receipt-date-edit">Delivery date from this synthetic receipt<input type="date" disabled={evidenceLocked} value={receiptDateDraft} onChange={(event) => { setReceiptDateDraft(event.target.value); setReceiptReviewed(false); }} /></label>{!receiptDateDraft && <p className="receipt-missing">No delivery date is present. Leave blank to ask policy for manual review, enter a date only if you can confirm it from this synthetic receipt; otherwise leave it blank.</p>}<small>Extracted from {receiptSamples[selectedOrder].fixture_name}. Verified in fixture: {(receiptSamples[selectedOrder].verified_fields ?? []).join(", ") || "no required fields"}.</small></details>}
            <label className="receipt-review-check"><input type="checkbox" checked={receiptReviewed} disabled={evidenceLocked} onChange={(event) => setReceiptReviewed(event.target.checked)} /><span>I reviewed the synthetic receipt and its extracted fields.</span></label>
            <label className="accessories-check"><input type="checkbox" checked={accessoriesComplete} disabled={evidenceLocked} onChange={(event) => setAccessoriesComplete(event.target.checked)} /><span><strong>All required accessories are included</strong><small>Confirm this from the sample order details. If unchecked, the policy pauses for review.</small></span></label>
            {activeCase && currentStatus !== 'NEEDS_INFO' && <p className="policy-footnote">Reviewed receipt evidence is saved with this proposal.</p>}
            <button className="button button-primary start-button" disabled={!selectedOrder || !receiptReviewed || busy || writesBlocked} onClick={startCase}>{busy ? 'Checking policy.' : receiptReviewed ? 'Check return options' : 'Review the receipt to continue'}<span aria-hidden="true">→</span></button>
          </article>

          {activeCase && <article className="card options-card">
            <div className="card-heading"><div className="step-number">02</div><div><p className="eyebrow">POLICY CHECKED · NORTHSTAR-V1</p><h2>Here are your options</h2></div><span className="card-icon policy-icon" aria-hidden="true">✓</span></div>
            <div className="policy-result"><span className="result-badge">✓</span><div><strong>{activeCase.eligibility_result?.status ? statusLabel(activeCase.eligibility_result.status) : 'Policy result ready'}</strong><span>{(activeCase.eligibility_result?.reason_codes ?? ['DEFECT_WITHIN_WINDOW']).join(' | ')}</span></div></div>
            {currentOffers.length ? <div className="offer-list" role="radiogroup" aria-label="Return options">
              {currentOffers.map((offer: AnyRecord, index: number) => {
                const id = offer.offer_id ?? offer.option_id ?? offer.id ?? `option-${index}`;
                const chosen = selectedOffer === id || (!selectedOffer && index === 0);
                return <button className={`offer-option ${chosen ? 'selected' : ''}`} key={id} role="radio" tabIndex={chosen ? 0 : -1} aria-checked={chosen} disabled={busy || writesBlocked || Boolean(approval) || currentStatus !== 'AWAITING_APPROVAL'} onKeyDown={moveRadio} onClick={() => { setSelectedOffer(id); setApproved(false); }}>
                  <span className={`offer-icon ${index ? 'replacement' : ''}`} aria-hidden="true">{index ? '↻' : '↗'}</span><span className="offer-copy"><strong>{offer.title ?? offer.label ?? (String(offer.option_id ?? '').includes('replace') ? 'Replacement' : 'Refund to original payment')}</strong><small>{offer.method_label ?? (offer.method_id === 'demo_mail' ? 'Free demo mail' : 'Free demo drop-off')}{offer.fee_cents ? ` · ${money(offer.fee_cents, offer.currency)}` : ' · No fee'}</small></span><span className="offer-amount">{typeof amountFor(offer) === 'number' ? money(amountFor(offer), offer.currency) : '—'}<small>estimated</small></span><span className={`radio-dot ${chosen ? 'checked' : ''}`} aria-hidden="true" />
                </button>;
              })}
            </div> : <div className="empty-state">No return option is available. Check the policy result and case details.</div>}
            <div className="terms-grid"><div><small>RETURN BY</small><strong>{displayDate(activeCase.offer?.deadline_at ?? deadlineFor(chosenOffer ?? activeCase))}</strong></div><div><small>OFFER EXPIRES</small><strong>{displayDateTime(activeCase.offer?.expires_at)}</strong></div><div><small>POLICY REFERENCE</small><strong>Northstar-v1: {(chosenOffer?.clause_ids ?? activeCase.eligibility_result?.clause_ids ?? ['R1']).join(', ')}</strong></div><div><small>METHOD</small><strong>{chosenOffer?.method_label ?? (chosenOffer?.method_id === 'demo_mail' ? 'Demo mail' : 'Demo drop-off')}</strong></div><div><small>RETURN FEE</small><strong>{money(chosenOffer?.fee_cents ?? 0, chosenOffer?.currency)}</strong></div></div>
            {currentStatus === 'AWAITING_APPROVAL' && <div className="offer-refresh"><button className="text-button" disabled={busy || writesBlocked} onClick={refreshOffer}>Refresh offer and require new approval</button><small>{approval ? 'To choose a different option, refresh the offer and approve it again.' : 'Refreshing replaces the offer and clears any approval on the previous terms.'}</small></div>}
            <label className="approval-check"><input type="checkbox" checked={approved} disabled={!chosenOffer || busy || writesBlocked || Boolean(approval)} onChange={(event) => setApproved(event.target.checked)} /><span className="custom-check" aria-hidden="true">✓</span><span>I’ve reviewed this estimate and want to approve this exact option.</span></label>
            {!approval ? <button className="button button-secondary" disabled={!approved || !chosenOffer || busy || writesBlocked} onClick={approveOffer}>{busy ? 'Recording approval…' : 'Approve this option'}<span aria-hidden="true">→</span></button> : canSubmit ? <div className="approved-note"><span aria-hidden="true">✓</span> Option approved. Your confirmation is still required below.</div> : null}
            <p className="policy-footnote">This is an estimate from fictional policy text. The simulation does not promise or issue a refund.</p>
          </article>}

          {activeCase && canSubmit && <article className="confirm-panel"><div className="confirm-heading"><span className="confirm-lock" aria-hidden="true">⌑</span><div><p className="eyebrow">FINAL STEP · YOUR CHOICE</p><h2>Ready to submit the simulation?</h2></div></div><p>Confirm here or ask the guide "Please submit the approved return." Your approval above does not submit it.</p><button className="button button-danger" disabled={busy || writesBlocked || !canSubmit} onClick={submitReturn}>{busy ? 'Submitting simulation…' : 'Confirm simulated return'}<span aria-hidden="true">→</span></button><small>No real return, refund, or shipping label will be created.</small></article>}

          {activeCase && (activeCase.return || activeCase.label_text || activeCase.label || currentStatus === 'AWAITING_DROPOFF' || activeCase.return_id) && <article className="card label-card"><div className="label-head"><span className="label-symbol" aria-hidden="true">▤</span><div><p className="eyebrow">MOCK RETURN LABEL</p><h2>Return instructions</h2></div><span className="label-stamp">DEMO ONLY</span></div><div className="invalid-label">DEMO ONLY - NOT VALID FOR SHIPPING</div><div className="return-id">Mock return ID: <code>{activeCase.return?.return_id ?? activeCase.return_id ?? "pending"}</code></div><p>{Array.isArray(currentInstructions) ? currentInstructions.join(' / ') : activeCase.label_text ?? activeCase.label ?? 'Pack the item with its required accessories. In this simulation, mark it dropped off using the demo control.'}</p>{deadlineFor(activeCase) && <div className="label-deadline">Drop-off by <strong>{displayDate(deadlineFor(activeCase))}</strong></div>}<a className="label-download" href={`/api/cases/${encodeURIComponent(caseId)}/label`} download="northstar-demo-invalid-label.txt">Download invalid demo label (text)</a></article>}
        </section>

        <aside className="side-column">
          <section className="card case-card"><div className="side-title"><span className="side-icon" aria-hidden="true">◷</span><div><p className="eyebrow">YOUR CASE</p><h2>Saved progress</h2></div><button className="refresh-button" disabled={busy || loading} onClick={() => void refreshSavedProgress()} aria-label="Refresh saved progress" title="Refresh">↻</button></div>
            {!cases.length && !activeCase ? <div className="case-empty"><div className="empty-illustration" aria-hidden="true">◌</div><strong>No cases yet</strong><span>Start with a sample purchase and your progress will appear here.</span></div> : <>
              {activeCase && <div className="active-case-summary"><div className="case-status-line"><span className="status-dot" /><span>{statusLabel(currentStatus || 'DRAFT')}</span></div><strong>{selectedOrderRecord?.product_name ?? activeCase.product_name ?? 'Northstar headphones'}</strong><span>Case {caseId}</span>{activeCase.next_action && <div className="next-action"><small>NEXT STEP</small><strong>{activeCase.next_action}</strong>{activeCase.next_action_due_at && <span>Due {displayDate(activeCase.next_action_due_at)}</span>}</div>}</div>}
              <div className="saved-case-list">{cases.map((item) => { const id = item.case_id ?? item.id; return <button key={id} className={`saved-case ${caseId === id ? 'active' : ''}`} disabled={busy} onClick={() => void openCase(item)}><span className="saved-case-dot" /><span><strong>{item.product_name ?? item.order_id ?? `Case ${id}`}</strong><small>{statusLabel(item.state ?? item.status ?? 'DRAFT')} · {id}</small></span><span aria-hidden="true">›</span></button>; })}</div>
            </>}
          </section>
          {activeCase && <section className="card timeline-card"><div className="side-title"><span className="side-icon timeline-icon" aria-hidden="true">☷</span><div><p className="eyebrow">CASE HISTORY</p><h2>Activity</h2></div></div>
            {timeline.length ? <ol className="timeline">{timeline.map((event: AnyRecord, index: number) => <li key={event.event_id ?? event.id ?? index}><span className="timeline-node" /><strong>{statusLabel(event.event_type ?? event.type ?? event.status ?? 'Case updated')}</strong><span>{event.message ?? event.description ?? event.actor ?? 'Saved to your local demo case'}</span><time>{event.timestamp ? displayDate(event.timestamp) : 'Oct 2, 2026'}</time></li>)}</ol> : <p className="timeline-empty">Your case updates will appear here.</p>}
            {currentStatus && currentStatus !== 'DRAFT' && <details className="demo-controls"><summary>Demo status controls</summary><p>Developer controls · simulation only</p><div><button disabled={busy || writesBlocked} onClick={() => void advance('DROPPED_OFF')}>Mark dropped off</button><button disabled={busy || writesBlocked} onClick={() => void advance('RECEIVED')}>Mark received</button><button disabled={busy || writesBlocked} onClick={() => void advance('REFUNDED')}>Mark refunded</button></div></details>}
          </section>}
          <section className="card chat-card" aria-label="Alexa+ agent simulation">
            <div className="side-title"><span className="side-icon" aria-hidden="true">?</span><div><p className="eyebrow">ALEXA+ AGENT SIMULATION</p><h2>Ask about this purchase</h2></div></div>
            <div className={`provider-status provider-${agentStatus}`} role="status"><span className="provider-dot" /><span><strong>{agentStatus === 'model' ? 'Local model' : agentStatus === 'fallback' ? 'Fallback response' : 'Deterministic fake model'}</strong><small>{providerDescription(modelProvider)}</small></span></div>
            {fallbackReason && <p className="fallback-reason">Fallback: {fallbackReason}</p>}
            <p className="chat-provider">Local only. Python controls policy and records your approval. After approval, the guide can call the simulation tool when you explicitly confirm.</p>
            <form onSubmit={sendChat} className="chat-form"><label htmlFor="chat-message" className="sr-only">Ask the demo guide</label><input id="chat-message" value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} maxLength={500} /><button type="submit" disabled={busy || writesBlocked || !selectedOrder || !chatMessage.trim()}>{busy ? 'Thinking…' : 'Ask'}</button></form>
            <div className="chat-transcript" aria-live="polite" aria-label="Conversation history">{chatHistory.length ? chatHistory.map((turn, index) => <p className={`chat-turn chat-turn-${turn.role}`} key={`${index}-${turn.role}`}><strong>{turn.role === 'user' ? 'You' : 'Guide'}</strong><span>{turn.content}</span></p>) : <p className="chat-reply">Ask for sample order facts, policy options, or an explicit return proposal. After you approve an option, explicitly confirm the simulation to let the guide record it.</p>}</div>
            {toolTrace.length > 0 && <div className="tool-trace"><strong>MCP Streamable HTTP tool call</strong>{toolTrace.map((tool: AnyRecord, index: number) => <div className="tool-step" key={`${tool.name ?? 'tool'}-${index}`}><code>{tool.name ?? 'Unknown tool'}</code><small>{tool.transport} · protocol {tool.protocolVersion}</small>{tool.arguments && <details className="tool-detail"><summary>Arguments</summary><pre>{JSON.stringify(tool.arguments, null, 2)}</pre></details>}{toolResults[index] && <details className="tool-detail"><summary>Result</summary><pre>{JSON.stringify(toolResults[index], null, 2)}</pre></details>}</div>)}<small>Proposal preparation saves a reviewable local case. Submission requires server-verified approval and remains simulation only.</small></div>}
          </section>
          <section className="help-card"><span className="help-spark" aria-hidden="true">✳</span><div><strong>Clear steps. No surprises.</strong><p>We show the policy, estimate, and next action before anything is confirmed.</p><span>Every action stays in this local simulation.</span></div></section>
        </aside>
      </div>

      <footer className="footer"><span>✳ Return Companion <b>·</b> Local prototype</span><span>All purchases and policies are fictional. This demo is not affiliated with Amazon.</span></footer>
    </main>
  );
}










