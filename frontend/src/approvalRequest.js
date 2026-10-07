export function buildApprovalRequest(caseRecord, selectedOption) {
  const offerId = caseRecord?.offer?.offer_id ?? caseRecord?.offer_id;
  if (!offerId) throw new Error('The active case does not contain an offer ID.');
  if (!selectedOption?.terms_hash) throw new Error('The selected option does not contain a terms hash.');
  return {
    offer_id: offerId,
    terms_hash: selectedOption.terms_hash,
    expected_revision: caseRecord?.revision ?? 1,
  };
}
