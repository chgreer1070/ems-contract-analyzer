"""Shared pattern registry — single source of truth for all regex patterns.

All patterns are defined here as raw strings AND pre-compiled at import time.
The flat PATTERN_ID registry is used by MatchCache to pre-scan text once.
"""

import re

_IC = re.IGNORECASE


# -----------------------------------------------------------------------------
# Clause detection
# -----------------------------------------------------------------------------

CLAUSE_PATTERNS_RAW = {
    "Termination": [
        r"terminat(?:e|ion|ed)",
        r"cancel(?:lation)?",
        r"end\s+(?:of\s+)?(?:this\s+)?agreement",
    ],
    "Indemnification": [
        r"indemnif(?:y|ication|ied)",
        r"hold\s+harmless",
        r"defend\s+and\s+indemnify",
    ],
    "Confidentiality": [
        r"confidential(?:ity)?",
        r"non-disclosure",
        r"proprietary\s+information",
        r"trade\s+secret",
    ],
    "Limitation of Liability": [
        r"limit(?:ation)?\s+(?:of\s+)?liability",
        r"in\s+no\s+event\s+shall.*(?:be\s+)?liable",
        r"aggregate\s+liability",
        r"cap\s+on\s+(?:damages|liability)",
    ],
    "Payment Terms": [
        r"payment\s+(?:terms?|schedule|due)",
        r"invoic(?:e|ing)",
        r"net\s+\d+\s+days?",
        r"(?:payable|due)\s+(?:within|upon|on)",
    ],
    "Intellectual Property": [
        r"intellectual\s+property",
        r"(?:patent|copyright|trademark)s?",
        r"ownership\s+of\s+(?:work|deliverables|ip)",
        r"license\s+grant",
    ],
    "Governing Law": [
        r"governing\s+law",
        r"governed\s+by\s+the\s+laws",
        r"jurisdiction",
        r"venue\s+(?:shall\s+be|for)",
    ],
    "Force Majeure": [
        r"force\s+majeure",
        r"act\s+of\s+god",
        r"unforeseeable\s+(?:event|circumstance)",
    ],
    "Non-Compete": [
        r"non-compet(?:e|ition)",
        r"(?:shall|will)\s+not\s+(?:directly\s+or\s+indirectly\s+)?compete",
        r"restrictive\s+covenant",
    ],
    "Warranty": [
        r"warrant(?:y|ies|s)",
        r"represent(?:s|ation)?\s+and\s+warrant",
        r"as[\s-]is",
        r"merchantability",
    ],
    "Dispute Resolution": [
        r"dispute\s+resolution",
        r"arbitrat(?:ion|e|or)",
        r"mediat(?:ion|e|or)",
        r"(?:shall|will)\s+(?:attempt\s+to\s+)?resolve.*(?:dispute|disagreement)",
    ],
    "Assignment": [
        r"assign(?:ment)?(?:\s+of\s+(?:this\s+)?agreement)?",
        r"(?:shall|may)\s+not\s+(?:be\s+)?assign(?:ed)?",
        r"transfer(?:ability)?\s+of\s+(?:rights|obligations)",
    ],
}

CLAUSE_PATTERNS = {
    name: [re.compile(p, _IC) for p in pats]
    for name, pats in CLAUSE_PATTERNS_RAW.items()
}

CRITICAL_CLAUSES = {
    "Termination",
    "Indemnification",
    "Limitation of Liability",
    "Confidentiality",
    "Governing Law",
}


# -----------------------------------------------------------------------------
# Risk indicators
# -----------------------------------------------------------------------------

RISK_INDICATORS_RAW = {
    "high": [
        (r"unlimited\s+liability", "Unlimited liability exposure"),
        (r"waiv(?:e|er)\s+(?:all|any)\s+(?:right|claim)", "Broad waiver of rights"),
        (r"sole\s+(?:discretion|judgment)", "Sole discretion clause favoring one party"),
        (r"irrevocabl[ey]", "Irrevocable commitment"),
        (r"perpetual(?:ly)?(?:\s+and\s+irrevocabl[ey])?", "Perpetual obligation"),
        (r"(?:shall|will)\s+not\s+(?:be\s+)?(?:liable|responsible)\s+(?:for\s+)?(?:any|all)",
         "Broad liability exclusion"),
        (r"automatic(?:ally)?\s+renew", "Auto-renewal clause"),
        (r"(?:penalty|penalt?ies)\s+(?:for|of|in)", "Penalty clause detected"),
    ],
    "medium": [
        (r"(?:may|shall)\s+(?:be\s+)?(?:amended|modified)\s+(?:at\s+)?(?:any\s+time|unilaterally)",
         "Unilateral modification rights"),
        (r"(?:reasonable\s+)?(?:best|commercial(?:ly)?)\s+efforts?",
         "Best/commercial efforts standard (vague)"),
        (r"(?:liquidated\s+)?damages", "Damages clause present"),
        (r"non-solicitat(?:ion|e)", "Non-solicitation restriction"),
        (r"(?:3|three|five|5)\s+year", "Long-term commitment period"),
        (r"(?:exclusive|exclusivity)", "Exclusivity requirement"),
    ],
    "low": [
        (r"(?:30|thirty)\s+days?\s+(?:written\s+)?notice", "Standard notice period"),
        (r"mutual(?:ly)?\s+(?:agree|consent)", "Mutual agreement required"),
        (r"(?:pro[\s-]?rata|proportional)", "Pro-rata provisions"),
    ],
}

RISK_INDICATORS = {
    severity: [(re.compile(p, _IC), desc) for p, desc in entries]
    for severity, entries in RISK_INDICATORS_RAW.items()
}


# -----------------------------------------------------------------------------
# Risk dimensions (for scoring by category)
# -----------------------------------------------------------------------------

RISK_DIMENSIONS_RAW = {
    "liability": [
        r"(?:un)?limited\s+liability",
        r"(?:shall|will)\s+not\s+(?:be\s+)?(?:liable|responsible)",
        r"aggregate\s+liability",
        r"cap\s+on\s+(?:damages|liability)",
    ],
    "commitment": [
        r"perpetual",
        r"irrevocabl[ey]",
        r"automatic(?:ally)?\s+renew",
        r"(?:3|three|five|5|10|ten)\s+year",
    ],
    "control": [
        r"sole\s+(?:discretion|judgment)",
        r"unilateral(?:ly)?",
        r"without\s+(?:prior\s+)?(?:consent|approval)",
    ],
    "flexibility": [
        r"(?:may|shall)\s+(?:be\s+)?(?:amended|modified)",
        r"(?:exclusive|exclusivity)",
        r"non-compet(?:e|ition)",
        r"restrictive\s+covenant",
    ],
}

RISK_DIMENSIONS = {
    dim: [re.compile(p, _IC) for p in pats]
    for dim, pats in RISK_DIMENSIONS_RAW.items()
}


# -----------------------------------------------------------------------------
# Obligations, prohibitions, conditions
# -----------------------------------------------------------------------------

OBLIGATION_PATTERNS_RAW = [
    (r"(?:party|company|contractor|vendor|client|customer)\s+(?:shall|must|will|agrees?\s+to)\s+([^.;]{10,120})",
     "Obligation"),
    (r"(?:is|are)\s+(?:required|obligated)\s+to\s+([^.;]{10,120})", "Requirement"),
    (r"(?:shall|must)\s+(?:provide|deliver|submit|maintain|ensure|comply)\s+([^.;]{10,80})", "Duty"),
]

OBLIGATION_PATTERNS = [(re.compile(p, _IC), label) for p, label in OBLIGATION_PATTERNS_RAW]

PROHIBITION_PATTERNS_RAW = [
    (r"(?:shall|must|will)\s+not\s+([^.;]{10,100})", "Prohibition"),
    (r"(?:is|are)\s+(?:prohibited|forbidden)\s+(?:from\s+)?([^.;]{10,100})", "Prohibition"),
]

PROHIBITION_PATTERNS = [(re.compile(p, _IC), label) for p, label in PROHIBITION_PATTERNS_RAW]

CONDITION_PATTERNS_RAW = [
    (r"(?:provided\s+that|on\s+condition\s+that|subject\s+to)\s+([^.;]{10,120})", "Condition"),
    (r"(?:unless|except\s+(?:where|when|if))\s+([^.;]{10,100})", "Exception"),
]

CONDITION_PATTERNS = [(re.compile(p, _IC), label) for p, label in CONDITION_PATTERNS_RAW]


# -----------------------------------------------------------------------------
# Temporal (dates, durations, renewals)
# -----------------------------------------------------------------------------

KEY_DATE_PATTERNS_RAW = [
    (r"(?:effective\s+date|commenc(?:e|ement)\s+date)[:\s]+([^.;,]{5,60})", "Effective Date"),
    (r"(?:expir(?:ation|y)|termination)\s+date[:\s]+([^.;,]{5,60})", "Expiration Date"),
    (r"(?:renew(?:al)?)\s+(?:date|deadline)[:\s]+([^.;,]{5,60})", "Renewal Date"),
    (r"(?:within|no\s+later\s+than)\s+(\d+\s+(?:days?|months?|years?|business\s+days?))", "Deadline"),
]

KEY_DATE_PATTERNS = [(re.compile(p, _IC), label) for p, label in KEY_DATE_PATTERNS_RAW]

DURATION_PATTERNS_RAW = [
    (r"(?:term|duration|period)\s+(?:of|is)\s+([^.;]{5,60})", "Contract Duration"),
    (r"(\d+)\s*[-–]\s*(?:year|month|day)\s+(?:term|period|agreement)", "Fixed Term"),
    (r"(?:initial\s+term)\s+(?:of|is)\s+([^.;]{5,60})", "Initial Term"),
]

DURATION_PATTERNS = [(re.compile(p, _IC), label) for p, label in DURATION_PATTERNS_RAW]

RENEWAL_PATTERNS_RAW = [
    (r"(?:automatic(?:ally)?\s+renew(?:al|ed|s)?)\s*([^.;]{0,80})", "Auto-Renewal"),
    (r"(?:option\s+to\s+renew)\s*([^.;]{0,60})", "Renewal Option"),
    (r"(?:renew(?:al|ed|s)?)\s+(?:for|upon)\s+([^.;]{5,60})", "Renewal Terms"),
]

RENEWAL_PATTERNS = [(re.compile(p, _IC), label) for p, label in RENEWAL_PATTERNS_RAW]


# -----------------------------------------------------------------------------
# Financials
# -----------------------------------------------------------------------------

FINANCIAL_PATTERNS_RAW = [
    (r"\$[\d,]+(?:\.\d{2})?(?:\s*(?:per|/)\s*\w+)?", "Monetary Amount"),
    (r"(\d+(?:\.\d+)?)\s*%", "Percentage"),
    (r"(?:fee|cost|price|rate|compensation|salary|payment)[:\s]+([^.;]{5,80})", "Financial Term"),
]

FINANCIAL_PATTERNS = [(re.compile(p, _IC), label) for p, label in FINANCIAL_PATTERNS_RAW]

PAYMENT_STRUCTURE_PATTERNS_RAW = [
    (r"net\s+(\d+)\s+days?", "Payment Window"),
    (r"(?:payable|due)\s+(?:within|upon|on)\s+([^.;]{5,60})", "Payment Timing"),
    (r"(?:monthly|quarterly|annual(?:ly)?|weekly|bi-weekly)\s+(?:payment|installment|fee)",
     "Recurring Payment"),
    (r"(?:late\s+(?:fee|charge|payment|penalty))[:\s]*([^.;]{3,80})", "Late Fee"),
    (r"(?:interest\s+(?:rate|at|of))[:\s]*([^.;]{3,60})", "Interest Rate"),
]

PAYMENT_STRUCTURE_PATTERNS = [
    (re.compile(p, _IC), label) for p, label in PAYMENT_STRUCTURE_PATTERNS_RAW
]

FINANCIAL_RISK_PATTERNS_RAW = [
    (r"(?:penalty|penalt?ies)\s+(?:for|of)\s+([^.;]{5,80})", "Penalty Clause"),
    (r"(?:liquidated\s+damages)[:\s]*([^.;]{5,80})", "Liquidated Damages"),
    (r"(?:price\s+(?:increase|adjustment|escalation))", "Price Escalation"),
    (r"(?:cost\s+(?:plus|overrun))", "Cost Overrun Risk"),
]

FINANCIAL_RISK_PATTERNS = [
    (re.compile(p, _IC), label) for p, label in FINANCIAL_RISK_PATTERNS_RAW
]


# -----------------------------------------------------------------------------
# Parties & roles
# -----------------------------------------------------------------------------

PARTY_PATTERNS_RAW = [
    r"(?:between|by\s+and\s+between)\s+([A-Z][A-Za-z\s,.'&]+?)(?:\s*\(.*?\))?\s+(?:and|&)\s+([A-Z][A-Za-z\s,.'&]+?)(?:\s*\(.*?\))?(?:\s*[.,;])",
    r"(?:\"([^\"]{2,60})\"|'([^']{2,60})')\s*\((?:hereinafter\s+)?(?:referred\s+to\s+as\s+)?[\"']?(Party|Company|Client|Contractor|Vendor|Seller|Buyer|Licensor|Licensee)",
]

# PARTY_PATTERNS are case-sensitive (match proper-noun capitalization)
PARTY_PATTERNS = [re.compile(p) for p in PARTY_PATTERNS_RAW]

ROLE_PATTERNS_RAW = [
    (r"(?:hereinafter|referred\s+to\s+as)\s+[\"']?(?:the\s+)?(Client|Customer|Buyer|Purchaser)", "Client"),
    (r"(?:hereinafter|referred\s+to\s+as)\s+[\"']?(?:the\s+)?(Contractor|Vendor|Seller|Provider|Supplier|Consultant)",
     "Service Provider"),
    (r"(?:hereinafter|referred\s+to\s+as)\s+[\"']?(?:the\s+)?(Licensor|Franchisor)", "Licensor"),
    (r"(?:hereinafter|referred\s+to\s+as)\s+[\"']?(?:the\s+)?(Licensee|Franchisee)", "Licensee"),
]

ROLE_PATTERNS = [(re.compile(p, _IC), role) for p, role in ROLE_PATTERNS_RAW]


# -----------------------------------------------------------------------------
# Flat PATTERN_ID registry — used by MatchCache to pre-scan text once.
#
# Key format: "<category>:<subcategory>:<index_or_name>"
# Each value is a compiled re.Pattern. Agents look up patterns by id to read
# cached matches without re-running regex.
# -----------------------------------------------------------------------------

PATTERN_ID: dict = {}

for clause_name, compiled_list in CLAUSE_PATTERNS.items():
    for i, pat in enumerate(compiled_list):
        PATTERN_ID[f"clause:{clause_name}:{i}"] = pat

for severity, entries in RISK_INDICATORS.items():
    for i, (pat, _desc) in enumerate(entries):
        PATTERN_ID[f"risk:{severity}:{i}"] = pat

for dim, compiled_list in RISK_DIMENSIONS.items():
    for i, pat in enumerate(compiled_list):
        PATTERN_ID[f"risk_dim:{dim}:{i}"] = pat

for i, (pat, _label) in enumerate(OBLIGATION_PATTERNS):
    PATTERN_ID[f"obligation:{i}"] = pat

for i, (pat, _label) in enumerate(PROHIBITION_PATTERNS):
    PATTERN_ID[f"prohibition:{i}"] = pat

for i, (pat, _label) in enumerate(CONDITION_PATTERNS):
    PATTERN_ID[f"condition:{i}"] = pat

for i, (pat, _label) in enumerate(KEY_DATE_PATTERNS):
    PATTERN_ID[f"date:{i}"] = pat

for i, (pat, _label) in enumerate(DURATION_PATTERNS):
    PATTERN_ID[f"duration:{i}"] = pat

for i, (pat, _label) in enumerate(RENEWAL_PATTERNS):
    PATTERN_ID[f"renewal:{i}"] = pat

for i, (pat, _label) in enumerate(FINANCIAL_PATTERNS):
    PATTERN_ID[f"financial:{i}"] = pat

for i, (pat, _label) in enumerate(PAYMENT_STRUCTURE_PATTERNS):
    PATTERN_ID[f"payment:{i}"] = pat

for i, (pat, _label) in enumerate(FINANCIAL_RISK_PATTERNS):
    PATTERN_ID[f"fin_risk:{i}"] = pat

for i, pat in enumerate(PARTY_PATTERNS):
    PATTERN_ID[f"party:{i}"] = pat

for i, (pat, _role) in enumerate(ROLE_PATTERNS):
    PATTERN_ID[f"role:{i}"] = pat


def iter_matches(cache, pattern_id: str, compiled_pattern, text: str):
    """Read matches from cache if available, otherwise run regex directly.

    Returns list of tuples (start, end, group0, groups_tuple).
    """
    if cache is not None:
        return cache.get(pattern_id)
    return [
        (m.start(), m.end(), m.group(0), m.groups())
        for m in compiled_pattern.finditer(text)
    ]
