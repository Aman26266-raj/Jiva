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

test('clears case influence when the customer declines', () => {
  assert.equal(applyCaseOfferResponse(customer, 'No, this is a new issue')?.caseOffer?.status, 'declined');
});
