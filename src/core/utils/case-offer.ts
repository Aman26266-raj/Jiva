import type { TrustedCustomerContext } from '../types/agent-context.js';

const AFFIRMATIVE = /^(yes|yeah|yep|sure|okay|ok|please|continue|resume|that one|let'?s do it)(\b|[.!?])/i;
const NEGATIVE = /^(no|nope|not now|new issue|different issue|something else|don'?t|do not)(\b|[.!?])/i;
const CASE_DETAILS_REQUEST = /\b(explain|details?|more (?:about|details?)|tell me|what (?:is|was)|status|update|relevance|case|issue)\b/i;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
}

export function applyCaseOfferResponse(
  customer: TrustedCustomerContext | undefined,
  message: string,
): TrustedCustomerContext | undefined {
  const offer = customer?.caseOffer;
  if (!customer || !offer || offer.status !== 'pending') return customer;

  const text = normalize(message);
  if (NEGATIVE.test(text)) {
    return { ...customer, caseOffer: { ...offer, status: 'declined' } };
  }
  let selected = offer.cases.find((item) => {
    const compact = item.caseNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    return text.includes(item.caseNumber.toLowerCase()) || text.replace(/[^a-z0-9]/g, '').includes(compact);
  });
  if (!selected) {
    const ordinal = text.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/)?.[1];
    const ordinalIndex = ordinal
      ? ['first', '1st', 'second', '2nd', 'third', '3rd', 'fourth', '4th', 'fifth', '5th'].indexOf(ordinal)
      : -1;
    if (ordinalIndex >= 0) selected = offer.cases[Math.floor(ordinalIndex / 2)];
  }
  if (!selected && /\b(last|latest|most recent)\b/i.test(text)) {
    // Kai supplies offers in most-recent-first order. In a conversational
    // support flow, "the last/latest case" should therefore resolve to the
    // most recently offered case, rather than the oldest case in the list.
    selected = offer.cases[0];
  }
  // A request to explain the only offered case is an unambiguous acceptance.
  // Do not make the customer repeat a bare "yes" before retrieving details.
  if (!selected && offer.cases.length === 1 && CASE_DETAILS_REQUEST.test(text)) {
    selected = offer.cases[0];
  }
  if (!selected && offer.cases.length === 1 && AFFIRMATIVE.test(text)) selected = offer.cases[0];

  if (selected) {
    return {
      ...customer,
      caseOffer: { ...offer, status: 'accepted', selectedCaseNumber: selected.caseNumber },
    };
  }
  return customer;
}
