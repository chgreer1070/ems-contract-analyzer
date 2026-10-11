import { fixture } from './playbook-fixtures.mjs';

// Illustrative drafting material authored for this trial. These are not Flex's
// approved positions, source quotations, or jurisdiction-vetted legal advice.
const drafts = {
  pricing: [
    ['preferred', 'Prices assume the agreed bill of materials, volumes, production location, and cost inputs. Flex may adjust prices prospectively to reflect documented changes in customer-directed materials, duties, tariffs, labor, exchange rates, or other agreed cost inputs, following the notice mechanism in the applicable statement of work. The parties shall identify the effective date and any fixed-price exceptions in writing.', 'Protect margin when agreed cost assumptions change; notice and fixed-price exceptions still need to be settled.'],
    ['fallback', 'If an agreed cost input changes materially, the parties shall promptly review the affected prices in good faith. Any adjustment shall be supported by reasonable documentation and confirmed in writing, including its effective date. Pending agreement, neither party is required to accept a change to price or production commitments.', 'A joint review may be acceptable, but it leaves Flex exposed until the parties agree and requires a workable supply-continuity provision.'],
    ['exception', 'Prices remain fixed for the expressly identified period and scope in the statement of work. Any extension or expansion requires written agreement. Customer-directed engineering changes and new taxes, duties, or tariffs are subject to separate written pricing agreement before implementation.', 'A fixed-price commitment requires cost protection, a defined duration, and business approval of the remaining exposure.']
  ],
  ncnr: [
    ['preferred', 'Customer shall reimburse Flex for documented, authorized noncancelable and nonreturnable material purchases and supplier commitments resulting from an agreed purchase order, binding forecast window, or written long-lead authorization, to the extent affected by Customer cancellation or reduction. Recoverable amounts shall exclude duplicate charges and shall be reduced by actual supplier credits and net proceeds from commercially reasonable mitigation. The parties shall document the applicable quantities, costs, and disposition.', 'Tie recovery to authorized procurement and evidence while preventing double billing.'],
    ['fallback', 'Flex shall obtain Customer written approval before placing noncancelable and nonreturnable commitments outside the agreed binding forecast window. Customer shall reimburse approved commitments affected by cancellation or reduction, less actual credits and net mitigation proceeds. Flex shall provide supporting records and propose commercially reasonable disposition options.', 'Explicit approval strengthens recovery evidence but requires a fast approval process to avoid supply delays.'],
    ['exception', 'Flex shall not place noncancelable and nonreturnable commitments unless Customer has expressly authorized the affected part, quantity, supplier, cost, and commitment period in writing. Production timing remains subject to the resulting material availability.', 'A narrow authorization model reduces disputed commitments but can impair lead times and continuity.']
  ],
  eo: [
    ['preferred', 'Customer shall purchase documented excess and obsolete materials acquired within agreed procurement authority and rendered excess or obsolete by Customer forecast reductions, cancellations, engineering changes, or discontinuance. Amounts shall reflect agreed acquisition costs and expressly agreed charges, less actual credits and net mitigation proceeds, without duplication of NCNR or other recovery. Customer-owned materials shall be separately identified and handled under the agreed custody and disposition terms.', 'Define the recovery trigger and prevent overlap with NCNR and customer-owned inventory.'],
    ['fallback', 'The parties shall review excess and obsolete materials at the agreed interval. Flex shall provide a reconciled inventory list showing procurement authority, cause, quantity, age, cost, ownership, and mitigation. Customer shall purchase the items for which its responsibility is agreed in writing, on the agreed timetable.', 'Periodic reconciliation helps settle facts but disputed responsibility and payment timing need a resolution mechanism.'],
    ['exception', 'Customer responsibility for excess and obsolete materials is limited to the specifically approved items and quantities identified in writing. Flex shall suspend additional procurement of affected items pending Customer disposition instructions, subject to agreed supply obligations.', 'The limit may leave inventory exposure with Flex and requires business approval plus a practical procurement stop.']
  ],
  notices: [
    ['preferred', 'Each notice shall identify the contractual provision, triggering event, requested action, and applicable effective date. The agreement or statement of work shall specify the authorized sender and recipient, addresses, permitted service methods, when service is effective, time zone, counting convention, and any weekend or holiday adjustment. A proposed commercial effective date shall not override an applicable notice period.', 'Make notices executable and keep commercial dates consistent with contractual requirements.'],
    ['fallback', 'Formal notices shall be delivered to the designated legal and business contacts by the agreed service method. Receipt and the effective date shall be determined under the express notice provision. The parties may agree in writing to an alternative method or shortened period for a specific event.', 'Permit practical exceptions while requiring evidence that the proper parties agreed to them.'],
    ['exception', 'Operational communications do not amend contractual notice requirements. Any waiver of a notice period or service requirement must identify the specific event and be confirmed in writing by authorized representatives.', 'Avoid treating an operational email as a waiver; determine who has authority and what evidence is required.']
  ]
};

export function starterDraft() {
  const f = fixture();
  f.book.id = 'illustrative-ems-negotiation-drafts';
  f.book.options = f.book.options.flatMap(base => drafts[base.family].map(([position, legalText, businessReason]) => ({
    ...base, id: `${base.family}-${position}`, position, legalText, businessReason, reviewStatus: 'draft',
    missingFacts: ['Confirm Flex approved position and fallback authority.', 'Confirm applicable law, document precedence, scope, and commercial facts.'],
    dependencies: base.family === 'pricing' ? ['notices-preferred'] : [],
  })));
  f.reviewRecords = [];
  return f;
}
