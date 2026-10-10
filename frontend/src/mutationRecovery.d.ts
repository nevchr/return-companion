export type PendingMutation = { version: 1; kind: 'proposal' | 'submit' | 'approve' | 'offer' | 'advance'; orderId: string; caseId: string | null; args: Record<string, any>; beforeOfferId?: string; startedAt: string };
export function readPendingMutation(storage?: Storage): PendingMutation | null;
export function savePendingMutation(value: PendingMutation, storage?: Storage): void;
export function clearPendingMutation(storage?: Storage): void;
export function pendingOutcomeIsRecorded(pending: PendingMutation | null, record: Record<string, any>): boolean;
