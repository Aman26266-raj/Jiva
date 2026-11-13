import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCaseOfferResponse } from './case-offer.js';
import type { TrustedCustomerContext } from '../types/agent-context.js';

const customer: TrustedCustomerContext = {
  phoneNumber: '+15551234567',
  phoneVerified: true,
  caseOffer: {
    status: 'pending',
    cases: [
      { caseNumber: 'CASE-1001', subject: 'Billing' },
      { caseNumber: 'CASE-1002', subject: 'Account access' },
    ],
  },
};

test('does not infer a selection from an ambiguous yes with several cases', () => {
  assert.equal(applyCaseOfferResponse(customer, 'yes')?.caseOffer?.status, 'pending');
});

test('selects an explicitly named offered case', () => {
  const result = applyCaseOfferResponse(customer, 'Continue CASE-1002');
  assert.equal(result?.caseOffer?.status, 'accepted');
  assert.equal(result?.caseOffer?.selectedCaseNumber, 'CASE-1002');
});

test('treats a request to explain the most recent offered case as confirmation', () => {
  const result = applyCaseOfferResponse(customer, 'Can you explain the last case a little more?');
  assert.equal(result?.caseOffer?.status, 'accepted');
  assert.equal(result?.caseOffer?.selectedCaseNumber, 'CASE-1001');
});

test('treats a request for details as confirmation when exactly one case is offered', () => {
  const onlyCase: TrustedCustomerContext = {
    ...customer,
    caseOffer: {
      status: 'pending',
      cases: [{ caseId: 'b58f6f44-1eb8-4cd5-a01e-3c5dcf9634cf', caseNumber: 'CASE-1042', subject: 'Door problem' }],
    },
  };
  const result = applyCaseOfferResponse(onlyCase, 'Can you explain it in more detail?');
  assert.equal(result?.caseOffer?.status, 'accepted');
  assert.equal(result?.caseOffer?.selectedCaseNumber, 'CASE-1042');
});

test('clears case influence when the customer declines', () => {
  assert.equal(applyCaseOfferResponse(customer, 'No, this is a new issue')?.caseOffer?.status, 'declined');
});

test('persists acceptance of a privacy-safe visitor case offer through OTP verification', () => {
  const visitor: TrustedCustomerContext = {
    organizationId: 'org-1',
    agentId: 'agent-1',
    identityVerification: { status: 'unverified' },
    visitorVerification: {
      openCaseAvailable: true,
      openCaseOfferStatus: 'pending',
      phoneNumber: '+916201235605',
    },
  };

  const accepted = applyCaseOfferResponse(visitor, 'yes');
  assert.equal(accepted?.visitorVerification?.openCaseOfferStatus, 'accepted');
  const retained = applyCaseOfferResponse(accepted, '665677');
  assert.equal(retained?.visitorVerification?.openCaseOfferStatus, 'accepted');
});
