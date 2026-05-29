import re
import os


class ContractAnalyzer:
    """Analyzes contract text for clauses, risks, key terms, and obligations."""

    ABBREVIATIONS = [
        "Inc", "Ltd", "Corp", "Co", "LLC", "LLP", "Dr", "Mr", "Mrs", "Ms",
        "Jr", "Sr", "Prof", "No", "Vol", "Dept", "Est", "Assn", "Intl", "Natl",
        "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        "Art", "Sec", "Para", "Cl", "Ex", "App", "Amend", "Approx", "Ref",
    ]

    CLAUSE_PATTERNS = {
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
        # EMS Manufacturing clause types
        "Quality Standards": [
            r"IPC[\s-]?A[\s-]?610",
            r"ISO\s*900[01]",
            r"ISO\s*13485",
            r"quality\s+management",
            r"acceptance\s+criteria",
            r"defect\s+rate",
            r"yield\s+(?:requirement|rate|threshold)",
            r"first\s+article\s+inspection",
            r"quality\s+(?:control|assurance|standard)",
        ],
        "Component Sourcing": [
            r"approved\s+vendor\s+list|AVL",
            r"component\s+(?:sourcing|procurement)",
            r"lead\s+time",
            r"(?:component\s+)?allocation",
            r"last[\s-]time[\s-]buy",
            r"end[\s-]of[\s-]life|EOL",
            r"bill\s+of\s+materials?|BOM",
        ],
        "Inventory/E&O Liability": [
            r"excess\s+and\s+obsolete|E\s*&\s*O",
            r"inventory\s+liability",
            r"safety\s+stock",
            r"buffer\s+stock",
            r"inventory\s+carrying",
            r"scrap(?:ping)?(?:\s+cost)?",
        ],
        "Forecast & Demand": [
            r"(?:rolling\s+)?forecast",
            r"demand\s+plan(?:ning)?",
            r"upside\s+(?:flexibility|capacity)",
            r"capacity\s+reservation",
            r"minimum\s+order\s+quantit(?:y|ies)|MOQ",
        ],
        "NPI/ECO Process": [
            r"new\s+product\s+introduction|NPI",
            r"engineering\s+change(?:\s+order)?|ECO",
            r"prototype",
            r"pilot\s+(?:run|production|build)",
            r"first\s+article",
        ],
        "Tooling & Equipment": [
            r"tooling(?:\s+(?:ownership|cost|maintenance))?",
            r"(?:test\s+)?fixtures?",
            r"test\s+equipment",
            r"mou?lds?(?:\s+ownership)?",
            r"(?:tooling|equipment)\s+(?:shall|will)\s+(?:remain|be)",
        ],
        "Regulatory Compliance": [
            r"RoHS",
            r"REACH",
            r"conflict\s+minerals?",
            r"UL\s+certification",
            r"(?:FCC|CE)\s+(?:mark(?:ing)?|compliance|certification)",
            r"regulatory\s+compliance",
        ],
        "Supply Chain Risk": [
            r"single\s+source",
            r"sole\s+source",
            r"supply\s+chain(?:\s+(?:risk|disruption|management))?",
            r"supply\s+disruption",
            r"dual\s+sourc(?:e|ing)",
        ],
    }

    RISK_INDICATORS = {
        "high": [
            (r"unlimited\s+liability", "Unlimited liability exposure", "financial"),
            (r"waiv(?:e|er)\s+(?:all|any)\s+(?:right|claim)", "Broad waiver of rights", "legal"),
            (r"sole\s+(?:discretion|judgment)", "Sole discretion clause favoring one party", "legal"),
            (r"irrevocabl[ey]", "Irrevocable commitment", "legal"),
            (r"perpetual(?:ly)?(?:\s+and\s+irrevocabl[ey])?", "Perpetual obligation", "legal"),
            (r"(?:shall|will)\s+not\s+(?:be\s+)?(?:liable|responsible)\s+(?:for\s+)?(?:any|all)", "Broad liability exclusion", "financial"),
            (r"automatic(?:ally)?\s+renew", "Auto-renewal clause", "financial"),
            (r"(?:penalty|penalt?ies)\s+(?:for|of|in)", "Penalty clause detected", "financial"),
            # EMS-specific high risks
            (r"unlimited\s+(?:E\s*&\s*O|inventory)\s+liability", "Unlimited E&O/inventory liability", "supply_chain"),
            (r"(?:no|without)\s+forecast\s+commitment", "No forecast commitment from customer", "supply_chain"),
            (r"single\s+source\s+component.*(?:no|without)\s+alternative", "Single source component with no alternative", "supply_chain"),
            (r"100\s*%\s*inventory\s+liability\s+on\s+cancellation", "100% inventory liability on cancellation", "supply_chain"),
            (r"(?:no|without)\s+(?:quality\s+)?rejection\s+right", "No quality rejection right", "supply_chain"),
            (r"uncapped\s+rework\s+costs?", "Uncapped rework costs", "financial"),
        ],
        "medium": [
            (r"(?:may|shall)\s+(?:be\s+)?(?:amended|modified)\s+(?:at\s+)?(?:any\s+time|unilaterally)", "Unilateral modification rights", "legal"),
            (r"(?:reasonable\s+)?(?:best|commercial(?:ly)?)\s+efforts?", "Best/commercial efforts standard (vague)", "operational"),
            (r"(?:liquidated\s+)?damages", "Damages clause present", "financial"),
            (r"non-solicitat(?:ion|e)", "Non-solicitation restriction", "operational"),
            (r"(?:3|three|five|5)\s+year", "Long-term commitment period", "operational"),
            (r"(?:exclusive|exclusivity)", "Exclusivity requirement", "operational"),
            # EMS-specific medium risks
            (r"rolling\s+forecast.*non[\s-]binding", "Non-binding rolling forecast", "supply_chain"),
            (r"tooling\s+ownership.*manufacturer", "Tooling ownership retained by manufacturer", "operational"),
            (r"(?:broad|full)\s+regulatory\s+liability", "Broad regulatory liability shift", "legal"),
            (r"(?:no|without)\s+last[\s-]time[\s-]buy\s+notif", "No last-time-buy notification requirement", "supply_chain"),
        ],
        "low": [
            (r"(?:30|thirty)\s+days?\s+(?:written\s+)?notice", "Standard notice period", "operational"),
            (r"mutual(?:ly)?\s+(?:agree|consent)", "Mutual agreement required", "operational"),
            (r"(?:pro[\s-]?rata|proportional)", "Pro-rata provisions", "financial"),
            # EMS-specific low risks
            (r"annual\s+price\s+review", "Annual price review clause", "financial"),
            (r"minimum\s+order\s+quantit(?:y|ies)", "Minimum order quantity requirement", "operational"),
            (r"consignment\s+inventory", "Consignment inventory arrangement", "supply_chain"),
        ],
    }

    RISK_CATEGORIES = {
        "financial": {"weight": 1.3},
        "legal": {"weight": 1.2},
        "operational": {"weight": 1.0},
        "supply_chain": {"weight": 1.4},
    }

    OBLIGATION_PATTERNS = [
        (r"(?:party|company|contractor|vendor|client|customer|manufacturer|OEM)\s+(?:shall|must|will|agrees?\s+to)\s+([^.;]{10,120})", "Obligation"),
        (r"(?:is|are)\s+(?:required|obligated)\s+to\s+([^.;]{10,120})", "Requirement"),
        (r"(?:shall|must)\s+(?:provide|deliver|submit|maintain|ensure|comply)\s+([^.;]{10,80})", "Duty"),
    ]

    KEY_DATE_PATTERNS = [
        (r"(?:effective\s+date|commenc(?:e|ement)\s+date)[:\s]+([^.;,]{5,60})", "Effective Date"),
        (r"(?:expir(?:ation|y)|termination)\s+date[:\s]+([^.;,]{5,60})", "Expiration Date"),
        (r"(?:renew(?:al)?)\s+(?:date|deadline)[:\s]+([^.;,]{5,60})", "Renewal Date"),
        (r"(?:within|no\s+later\s+than)\s+(\d+\s+(?:days?|months?|years?|business\s+days?))", "Deadline"),
    ]

    FINANCIAL_PATTERNS = [
        (r"\$[\d,]+(?:\.\d{2})?(?:\s*(?:per|/)\s*\w+)?", "Monetary Amount"),
        (r"(\d+(?:\.\d+)?)\s*%", "Percentage"),
        (r"(?:fee|cost|price|rate|compensation|salary|payment|NRE)[:\s]+([^.;]{5,80})", "Financial Term"),
    ]

    DEFINITION_PATTERNS = [
        (r'"([^"]{2,80})"\s+(?:shall\s+)?means?\b', "means"),
        (r'"([^"]{2,80})"\s+(?:is|are)\s+defined\s+as', "defined_as"),
        (r'(?:hereinafter\s+(?:referred\s+to\s+as|called))\s+"([^"]{2,80})"', "hereinafter"),
        (r'"([^"]{2,80})"\s+refers?\s+to', "refers_to"),
        (r'\("([^"]{2,60})"\)', "parenthetical"),
    ]

    CONTRACT_TYPE_KEYWORDS = {
        "EMS Manufacturing": [
            (r"contract\s+manufactur|EMS\b", 5),
            (r"PCB|PCBA|printed\s+circuit", 4),
            (r"bill\s+of\s+materials?|BOM\b", 4),
            (r"component\s+(?:sourcing|procurement)", 3),
            (r"(?:yield|defect)\s+(?:rate|threshold)|IPC[\s-]?A|ISO\s*900", 3),
            (r"new\s+product\s+introduction|NPI\b", 3),
            (r"engineering\s+change|ECO\b", 3),
            (r"tooling|fixtures?|test\s+equipment", 2),
            (r"forecast|demand\s+plan", 2),
            (r"excess\s+and\s+obsolete|E\s*&\s*O", 3),
            (r"RoHS|REACH|conflict\s+minerals?", 2),
            (r"capacity\s+(?:reservation|line|production)", 2),
            (r"OEM|original\s+equipment\s+manufactur", 3),
            (r"consignment|VMI|vendor\s+managed", 2),
        ],
        "Employment": [
            (r"employee|employer|employment", 3),
            (r"salary|wages|compensation|benefits", 2),
            (r"hire|hiring|termination\s+of\s+employment", 2),
            (r"work\s+hours|vacation|leave|overtime", 1),
            (r"at[\s-]will|probation", 1),
        ],
        "NDA/Confidentiality": [
            (r"non-disclosure|nda\b", 5),
            (r"confidential\s+information|proprietary\s+information", 3),
            (r"disclosing\s+party|receiving\s+party", 3),
            (r"trade\s+secret", 2),
        ],
        "Service Agreement": [
            (r"services?|scope\s+of\s+work|deliverables?", 3),
            (r"contractor|consultant|vendor|provider", 2),
            (r"milestone|project|acceptance", 1),
            (r"statement\s+of\s+work|sow\b", 2),
        ],
        "Lease/Rental": [
            (r"lease|leased\s+premises|landlord|tenant", 4),
            (r"rent(?:al)?|monthly\s+payment", 3),
            (r"premises|property|square\s+feet", 2),
            (r"security\s+deposit|move[\s-]in", 2),
        ],
        "Sales/Purchase": [
            (r"sale|purchase|buyer|seller", 3),
            (r"goods|merchandise|delivery\s+of\s+goods", 2),
            (r"purchase\s+order|bill\s+of\s+sale|invoice", 2),
            (r"shipping|freight|fob\b", 1),
        ],
        "Partnership": [
            (r"partner(?:ship)?", 4),
            (r"profit\s+sharing|capital\s+contribution", 3),
            (r"joint\s+venture|joint\s+and\s+several", 2),
            (r"dissolution|winding\s+up", 1),
        ],
        "License": [
            (r"licensor|licensee|license\s+grant", 4),
            (r"royalt(?:y|ies)", 3),
            (r"sublicense|exclusive\s+license|non-exclusive", 2),
            (r"intellectual\s+property\s+rights", 1),
        ],
        "Loan/Credit": [
            (r"lender|borrower|loan\b", 4),
            (r"principal|interest\s+rate|repayment", 3),
            (r"collateral|security\s+interest|default", 2),
            (r"amortization|maturity\s+date", 2),
        ],
    }

    EXPECTED_CLAUSES_BY_TYPE = {
        "EMS Manufacturing": [
            ("Quality Standards", "critical", "EMS agreements must define IPC class, defect rates, and acceptance criteria"),
            ("Inventory/E&O Liability", "critical", "Unclear E&O liability is the #1 source of EMS disputes"),
            ("Payment Terms", "critical", "Payment terms and pricing structure must be clearly defined"),
            ("Component Sourcing", "critical", "Must define AVL process and sourcing responsibilities"),
            ("Forecast & Demand", "important", "Forecast accuracy drives inventory risk allocation"),
            ("NPI/ECO Process", "important", "Change management is essential for manufacturing"),
            ("Tooling & Equipment", "important", "Tooling ownership must be explicit"),
            ("Regulatory Compliance", "important", "Manufacturing compliance responsibilities must be assigned"),
            ("Indemnification", "important", "Liability for defective products must be addressed"),
            ("Limitation of Liability", "important", "Cap on damages is essential for both parties"),
            ("Termination", "important", "Termination triggers and obligations must be defined"),
            ("Force Majeure", "recommended", "Address supply chain disruptions and unforeseeable events"),
            ("Supply Chain Risk", "recommended", "Address component shortages and allocation scenarios"),
            ("Confidentiality", "recommended", "Protect proprietary designs and process information"),
            ("Intellectual Property", "recommended", "Clarify ownership of designs, tooling, and process IP"),
            ("Dispute Resolution", "recommended", "Define dispute resolution process"),
            ("Governing Law", "recommended", "Specify applicable jurisdiction"),
        ],
        "Employment": [
            ("Termination", "critical", "Employment contracts should define termination conditions"),
            ("Confidentiality", "important", "Protect company trade secrets and proprietary information"),
            ("Non-Compete", "recommended", "Consider restricting competitive activities post-employment"),
            ("Intellectual Property", "critical", "IP assignment is essential for work product ownership"),
            ("Payment Terms", "critical", "Compensation terms must be clearly defined"),
            ("Governing Law", "recommended", "Specify applicable jurisdiction"),
            ("Dispute Resolution", "recommended", "Define how employment disputes are handled"),
        ],
        "NDA/Confidentiality": [
            ("Confidentiality", "critical", "Core clause for an NDA"),
            ("Termination", "important", "Define when confidentiality obligations end"),
            ("Governing Law", "recommended", "Specify jurisdiction"),
            ("Dispute Resolution", "recommended", "Define dispute process"),
            ("Indemnification", "recommended", "Address breach consequences"),
        ],
        "Service Agreement": [
            ("Payment Terms", "critical", "Service compensation must be defined"),
            ("Termination", "critical", "Define how to end the engagement"),
            ("Intellectual Property", "important", "Clarify ownership of deliverables"),
            ("Confidentiality", "important", "Protect shared information"),
            ("Indemnification", "important", "Address liability for service failures"),
            ("Limitation of Liability", "important", "Cap potential damages"),
            ("Warranty", "important", "Define service quality guarantees"),
            ("Force Majeure", "recommended", "Address unforeseeable disruptions"),
            ("Governing Law", "recommended", "Specify jurisdiction"),
            ("Dispute Resolution", "recommended", "Define dispute process"),
        ],
        "Lease/Rental": [
            ("Payment Terms", "critical", "Rent and payment schedule must be defined"),
            ("Termination", "critical", "Define lease termination conditions"),
            ("Governing Law", "recommended", "Specify applicable law"),
        ],
        "Sales/Purchase": [
            ("Payment Terms", "critical", "Payment terms for goods must be defined"),
            ("Warranty", "important", "Define warranty on goods sold"),
            ("Limitation of Liability", "important", "Cap liability for defective goods"),
            ("Termination", "recommended", "Define agreement termination"),
        ],
        "Partnership": [
            ("Termination", "critical", "Define dissolution and exit conditions"),
            ("Governing Law", "recommended", "Specify applicable law"),
            ("Dispute Resolution", "important", "Partners must have a dispute mechanism"),
        ],
        "License": [
            ("Intellectual Property", "critical", "IP rights are core to a license agreement"),
            ("Payment Terms", "critical", "Royalties and fees must be defined"),
            ("Termination", "important", "Define license termination conditions"),
            ("Limitation of Liability", "recommended", "Cap liability exposure"),
        ],
        "Loan/Credit": [
            ("Payment Terms", "critical", "Repayment terms must be defined"),
            ("Termination", "important", "Define default and acceleration conditions"),
            ("Governing Law", "recommended", "Specify applicable law"),
        ],
        "General": [
            ("Termination", "important", "Define how the agreement can be ended"),
            ("Governing Law", "recommended", "Specify applicable law"),
            ("Limitation of Liability", "recommended", "Consider capping liability"),
        ],
    }

    CLAUSE_DEPENDENCIES = {
        # General clauses
        "Indemnification": ["Limitation of Liability", "Governing Law"],
        "Non-Compete": ["Termination", "Governing Law"],
        "Payment Terms": ["Termination", "Force Majeure"],
        "Warranty": ["Limitation of Liability", "Dispute Resolution"],
        "Intellectual Property": ["Confidentiality", "Termination"],
        "Force Majeure": ["Termination", "Payment Terms"],
        "Assignment": ["Termination"],
        "Dispute Resolution": ["Governing Law"],
        # EMS manufacturing chains
        "Inventory/E&O Liability": ["Forecast & Demand", "Component Sourcing", "Termination"],
        "Component Sourcing": ["Quality Standards", "Regulatory Compliance"],
        "Quality Standards": ["Warranty", "Indemnification"],
        "Forecast & Demand": ["Payment Terms", "Inventory/E&O Liability"],
        "NPI/ECO Process": ["Quality Standards", "Component Sourcing", "Payment Terms"],
        "Tooling & Equipment": ["Intellectual Property", "Termination"],
        "Supply Chain Risk": ["Force Majeure", "Component Sourcing"],
        "Regulatory Compliance": ["Indemnification", "Quality Standards"],
    }

    CLAUSE_CONFLICTS = [
        {
            "clause_a": "Indemnification",
            "clause_b": "Limitation of Liability",
            "condition": "broad_indemnification_narrow_liability",
            "description": "Broad indemnification clause may conflict with limitation of liability cap",
            "severity": "high",
            "broad_patterns": [r"any\s+and\s+all", r"all\s+claims", r"without\s+limitation"],
            "narrow_patterns": [r"shall\s+not\s+exceed", r"aggregate\s+liability", r"cap\s+on"],
        },
        {
            "clause_a": "Termination",
            "clause_b": "Non-Compete",
            "condition": "termination_noncompete_scope",
            "description": "Non-compete survives termination -- verify scope and duration are reasonable",
            "severity": "medium",
        },
        {
            "clause_a": "Confidentiality",
            "clause_b": "Termination",
            "condition": "confidentiality_survival",
            "description": "Verify confidentiality obligations have a defined survival period after termination",
            "severity": "medium",
        },
        {
            "clause_a": "Warranty",
            "clause_b": "Limitation of Liability",
            "condition": "warranty_liability_gap",
            "description": "Warranty promises may be undermined by broad liability limitations",
            "severity": "medium",
        },
        {
            "clause_a": "Intellectual Property",
            "clause_b": "Confidentiality",
            "condition": "ip_confidentiality_overlap",
            "description": "IP ownership and confidentiality clauses should be aligned on what constitutes protected information",
            "severity": "low",
        },
        {
            "clause_a": "Force Majeure",
            "clause_b": "Payment Terms",
            "condition": "force_majeure_payment",
            "description": "Verify whether force majeure excuses payment obligations",
            "severity": "medium",
        },
        {
            "clause_a": "Assignment",
            "clause_b": "Termination",
            "condition": "assignment_termination",
            "description": "Assignment restrictions may be bypassed through termination and re-engagement",
            "severity": "low",
        },
        # EMS-specific conflicts
        {
            "clause_a": "Inventory/E&O Liability",
            "clause_b": "Forecast & Demand",
            "condition": "eo_forecast_mismatch",
            "description": "E&O liability allocation should be tied to forecast accuracy and commitment levels",
            "severity": "high",
        },
        {
            "clause_a": "Quality Standards",
            "clause_b": "Limitation of Liability",
            "condition": "quality_liability_gap",
            "description": "Quality guarantees may be undermined if liability for defective products is capped too low",
            "severity": "medium",
        },
    ]

    AMBIGUITY_PATTERNS = [
        (r"\breasonable\b(?!\s+(?:efforts?|time|notice))", "Undefined 'reasonable' standard"),
        (r"\bmaterial(?:ly)?\s+(?:adverse|breach)\b", "Undefined 'material' threshold"),
        (r"\bpromptly\b|\btimely\b|\bas\s+soon\s+as\s+practicable\b", "Vague timing requirement without specific timeframe"),
        (r"\bbest\s+efforts?\b", "'Best efforts' without defined scope"),
        (r"\bindustry[\s-]standard\b", "Undefined 'industry standard' reference"),
    ]

    NEGOTIATION_RULES = [
        # General risk-triggered rules
        {"trigger_type": "risk", "trigger_match": "Unlimited liability", "suggestion": "Negotiate a cap on liability, typically 1-2x the contract value", "priority": "high"},
        {"trigger_type": "risk", "trigger_match": "Auto-renewal", "suggestion": "Add a required advance notice period before auto-renewal and cap the number of renewals", "priority": "medium"},
        {"trigger_type": "risk", "trigger_match": "Sole discretion", "suggestion": "Replace 'sole discretion' with 'reasonable discretion' to prevent arbitrary decisions", "priority": "high"},
        {"trigger_type": "risk", "trigger_match": "Irrevocable", "suggestion": "Consider adding conditions under which irrevocable commitments can be revisited", "priority": "medium"},
        {"trigger_type": "risk", "trigger_match": "Perpetual obligation", "suggestion": "Negotiate a time limit on perpetual obligations, or add sunset clauses", "priority": "high"},
        {"trigger_type": "risk", "trigger_match": "Broad waiver", "suggestion": "Narrow the scope of rights being waived to specific, enumerated rights", "priority": "high"},
        {"trigger_type": "risk", "trigger_match": "Unilateral modification", "suggestion": "Require mutual written consent for any modifications to the agreement", "priority": "high"},
        {"trigger_type": "risk", "trigger_match": "Broad liability exclusion", "suggestion": "Ensure liability exclusions do not cover willful misconduct or gross negligence", "priority": "high"},
        # Missing clause-triggered rules
        {"trigger_type": "missing_clause", "trigger_match": "Limitation of Liability", "suggestion": "Add a limitation of liability clause to cap potential damages exposure", "priority": "high"},
        {"trigger_type": "missing_clause", "trigger_match": "Dispute Resolution", "suggestion": "Add a dispute resolution clause specifying mediation or arbitration before litigation", "priority": "medium"},
        {"trigger_type": "missing_clause", "trigger_match": "Force Majeure", "suggestion": "Add a force majeure clause to address unforeseeable events and supply disruptions", "priority": "medium"},
        {"trigger_type": "missing_clause", "trigger_match": "Termination", "suggestion": "Add clear termination provisions including notice periods and post-termination obligations", "priority": "high"},
        # Clause conflict-triggered rules
        {"trigger_type": "clause_conflict", "trigger_match": "broad_indemnification_narrow_liability", "suggestion": "Align the indemnification scope with the limitation of liability cap to avoid contradictions", "priority": "high"},
        # Pattern-triggered rules
        {"trigger_type": "pattern", "trigger_match": r"non-compet.*?(\d+)\s*year", "suggestion_template": "The non-compete period of {0} year(s) may be excessive; consider negotiating to 1 year or less", "priority": "medium"},
        {"trigger_type": "pattern", "trigger_match": r"confidentiality.*?survive.*?(\d+)\s*year", "suggestion_template": "The confidentiality survival period of {0} year(s) should be reviewed for reasonableness", "priority": "low"},
        # EMS-specific negotiation rules
        {"trigger_type": "risk", "trigger_match": "Unlimited E&O", "suggestion": "Negotiate E&O liability caps tied to forecast accuracy -- OEM bears liability for components ordered within forecast window", "priority": "high"},
        {"trigger_type": "risk", "trigger_match": "No forecast commitment", "suggestion": "Require binding forecast commitment for at least the component lead time window", "priority": "high"},
        {"trigger_type": "risk", "trigger_match": "Single source component", "suggestion": "Require AVL with minimum 2 approved sources for critical components to mitigate allocation risk", "priority": "high"},
        {"trigger_type": "risk", "trigger_match": "No last-time-buy", "suggestion": "Add last-time-buy notification requirement (minimum 6 months) for EOL components", "priority": "medium"},
        {"trigger_type": "missing_clause", "trigger_match": "Quality Standards", "suggestion": "Define specific IPC class requirements rather than generic 'industry standard' quality language", "priority": "high"},
        {"trigger_type": "missing_clause", "trigger_match": "Inventory/E&O Liability", "suggestion": "Cap inventory liability at specified weeks of forecast and require OEM purchase of excess upon termination", "priority": "high"},
        {"trigger_type": "missing_clause", "trigger_match": "Tooling & Equipment", "suggestion": "Specify tooling ownership explicitly -- OEM-funded tooling should remain OEM property", "priority": "medium"},
        {"trigger_type": "missing_clause", "trigger_match": "NPI/ECO Process", "suggestion": "Define NPI milestone payments and acceptance criteria before production commitment", "priority": "medium"},
        {"trigger_type": "missing_clause", "trigger_match": "Supply Chain Risk", "suggestion": "Add supply chain disruption clause beyond generic force majeure for component shortages", "priority": "medium"},
        {"trigger_type": "clause_conflict", "trigger_match": "eo_forecast_mismatch", "suggestion": "Align E&O liability with forecast commitment levels -- forecast variance tolerance should determine inventory risk allocation", "priority": "high"},
    ]

    def extract_text(self, filepath):
        """Extract text from .txt, .pdf, or .docx files."""
        ext = os.path.splitext(filepath)[1].lower()
        if ext == ".txt":
            return self._read_txt(filepath)
        elif ext == ".pdf":
            return self._read_pdf(filepath)
        elif ext == ".docx":
            return self._read_docx(filepath)
        return ""

    def _read_txt(self, filepath):
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    def _read_pdf(self, filepath):
        from pypdf import PdfReader

        reader = PdfReader(filepath)
        text_parts = []
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
        return "\n".join(text_parts)

    def _read_docx(self, filepath):
        from docx import Document

        doc = Document(filepath)
        return "\n".join(para.text for para in doc.paragraphs)

    def analyze(self, text):
        """Run full contract analysis and return structured results."""
        clauses = self._detect_clauses(text)
        risks = self._assess_risks(text)
        obligations = self._extract_obligations(text)
        dates = self._extract_dates(text)
        financials = self._extract_financials(text)
        parties = self._extract_parties(text)

        # New analysis features
        definitions = self._extract_definitions(text)
        contract_type = self._detect_contract_type(text)
        found_names = [c["name"] for c in clauses["found"]]
        missing_warnings = self._check_missing_clauses(contract_type["type"], found_names)
        clause_relations = self._analyze_clause_relationships(text, clauses["found"])
        party_balance = self._analyze_party_balance(text, parties)

        # Enhanced risk score
        score = self._compute_risk_score(risks, missing_warnings, clause_relations)

        # Negotiation suggestions
        suggestions = self._generate_negotiation_suggestions(
            text, risks, missing_warnings, clause_relations, party_balance
        )

        summary = self._generate_summary(text, clauses, risks, contract_type, missing_warnings)

        return {
            # Existing fields (backward compatible)
            "summary": summary,
            "risk_score": score,
            "clauses": clauses,
            "risks": risks,
            "obligations": obligations,
            "key_dates": dates,
            "financial_terms": financials,
            "parties": parties,
            "word_count": len(text.split()),
            "section_count": len(clauses["found"]),
            # New fields
            "contract_type": contract_type,
            "missing_clause_warnings": missing_warnings,
            "clause_relationships": clause_relations,
            "party_balance": party_balance,
            "negotiation_suggestions": suggestions,
            "definitions": definitions,
        }

    def _split_sentences(self, text):
        """Split text into sentences, protecting abbreviation dots."""
        placeholder = "\x07"  # BEL character, unlikely in contract text
        protected = text
        # Protect abbreviation dots
        abbr_pattern = r'\b(' + '|'.join(re.escape(a) for a in self.ABBREVIATIONS) + r')\.'
        protected = re.sub(abbr_pattern, lambda m: m.group(1) + placeholder, protected)
        # Protect single-letter abbreviations like U.S.A.
        protected = re.sub(r'(?<=[A-Z])\.(?=[A-Z])', placeholder, protected)
        # Protect decimal numbers and section references like "4.2"
        protected = re.sub(r'(\d)\.(\d)', lambda m: m.group(1) + placeholder + m.group(2), protected)

        sentences = re.split(r"(?<=[.!?])\s+", protected)
        return [s.replace(placeholder, '.') for s in sentences]

    def _detect_clauses(self, text):
        """Identify which standard clauses are present and extract relevant excerpts."""
        found = []
        sentences = self._split_sentences(text)
        for clause_name, patterns in self.CLAUSE_PATTERNS.items():
            matching_sentences = []
            for pattern in patterns:
                for sentence in sentences:
                    if re.search(pattern, sentence, re.IGNORECASE):
                        clean = sentence.strip()[:300]
                        if clean not in matching_sentences:
                            matching_sentences.append(clean)
            if matching_sentences:
                found.append({
                    "name": clause_name,
                    "present": True,
                    "excerpts": matching_sentences[:3],
                })
        missing = [
            name for name in self.CLAUSE_PATTERNS
            if name not in [c["name"] for c in found]
        ]
        return {"found": found, "missing": missing}

    def _assess_risks(self, text):
        """Score and categorize risk indicators found in the text."""
        risks = {"high": [], "medium": [], "low": []}
        for severity, patterns in self.RISK_INDICATORS.items():
            for entry in patterns:
                pattern, description = entry[0], entry[1]
                category = entry[2] if len(entry) > 2 else "operational"
                matches = re.finditer(pattern, text, re.IGNORECASE)
                for match in matches:
                    start = max(0, match.start() - 50)
                    end = min(len(text), match.end() + 100)
                    context = text[start:end].strip()
                    risk_entry = {
                        "description": description,
                        "context": context,
                        "matched": match.group(),
                        "category": category,
                    }
                    if risk_entry["description"] not in [r["description"] for r in risks[severity]]:
                        risks[severity].append(risk_entry)
        return risks

    def _extract_obligations(self, text):
        """Extract obligations and duties from the contract text."""
        obligations = []
        seen = set()
        for pattern, label in self.OBLIGATION_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                full = match.group().strip()[:200]
                if full not in seen:
                    seen.add(full)
                    obligations.append({"type": label, "text": full})
        return obligations[:20]

    def _extract_dates(self, text):
        """Find key dates and deadlines mentioned in the contract."""
        dates = []
        seen = set()
        for pattern, label in self.KEY_DATE_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group(1).strip() if match.lastindex else match.group().strip()
                if value not in seen:
                    seen.add(value)
                    dates.append({"type": label, "value": value})
        return dates

    def _extract_financials(self, text):
        """Extract monetary amounts, percentages, and financial terms."""
        financials = []
        seen = set()
        for pattern, label in self.FINANCIAL_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                value = match.group().strip()[:150]
                if value not in seen:
                    seen.add(value)
                    financials.append({"type": label, "value": value})
        return financials[:25]

    def _extract_parties(self, text):
        """Attempt to identify the contracting parties."""
        parties = []
        party_patterns = [
            r"(?:between|by\s+and\s+between)\s+([A-Z][A-Za-z\s,.'&]+?)(?:\s*\(.*?\))?\s+(?:and|&)\s+([A-Z][A-Za-z\s,.'&]+?)(?:\s*\(.*?\))?(?:\s*[.,;])",
            r"(?:\"([^\"]{2,60})\"|'([^']{2,60})')\s*\((?:hereinafter\s+)?(?:referred\s+to\s+as\s+)?[\"']?(Party|Company|Client|Contractor|Vendor|Seller|Buyer|Licensor|Licensee|Manufacturer|OEM)",
        ]
        for pattern in party_patterns:
            for match in re.finditer(pattern, text):
                for group in match.groups():
                    if group and group.strip() and len(group.strip()) > 1:
                        clean = group.strip().rstrip(",.")
                        if clean not in parties and len(clean) < 100:
                            parties.append(clean)
        return parties[:4]

    def _extract_definitions(self, text):
        """Extract defined terms from the contract text."""
        definitions = []
        seen_terms = set()
        for pattern, pattern_type in self.DEFINITION_PATTERNS:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                term = match.group(1).strip()
                term_lower = term.lower()
                if term_lower in seen_terms or len(term) < 2:
                    continue
                seen_terms.add(term_lower)
                # Extract context as definition
                start = match.start()
                end = min(len(text), match.end() + 200)
                context = text[start:end]
                # Find the end of the definition sentence
                period_pos = context.find('.', len(match.group()))
                if period_pos > 0:
                    definition_text = context[:period_pos + 1].strip()
                else:
                    definition_text = context.strip()
                definitions.append({
                    "term": term,
                    "definition": definition_text[:300],
                })
        return definitions[:30]

    def _detect_contract_type(self, text):
        """Detect the contract type using weighted keyword analysis."""
        text_lower = text.lower()
        first_500 = text[:500].upper()
        scores = {}

        for contract_type, keyword_groups in self.CONTRACT_TYPE_KEYWORDS.items():
            type_score = 0
            for pattern, weight in keyword_groups:
                match_count = len(re.findall(pattern, text_lower, re.IGNORECASE))
                type_score += match_count * weight
            # Structural hint bonus from title/header
            type_upper = contract_type.upper()
            if type_upper in first_500:
                type_score += 20
            # Check common title patterns
            title_variants = {
                "EMS Manufacturing": ["MANUFACTURING AGREEMENT", "MANUFACTURING SERVICES", "CONTRACT MANUFACTURING", "EMS AGREEMENT"],
                "Employment": ["EMPLOYMENT AGREEMENT", "EMPLOYMENT CONTRACT"],
                "NDA/Confidentiality": ["NON-DISCLOSURE AGREEMENT", "NDA", "CONFIDENTIALITY AGREEMENT"],
                "Service Agreement": ["SERVICE AGREEMENT", "SERVICES AGREEMENT", "CONSULTING AGREEMENT"],
                "Lease/Rental": ["LEASE AGREEMENT", "RENTAL AGREEMENT"],
                "Sales/Purchase": ["SALES AGREEMENT", "PURCHASE AGREEMENT"],
                "Partnership": ["PARTNERSHIP AGREEMENT"],
                "License": ["LICENSE AGREEMENT", "LICENSING AGREEMENT"],
                "Loan/Credit": ["LOAN AGREEMENT", "CREDIT AGREEMENT"],
            }
            for variant in title_variants.get(contract_type, []):
                if variant in first_500:
                    type_score += 20
            scores[contract_type] = type_score

        if not scores:
            return {"type": "General", "confidence": "low", "scores": {}}

        sorted_types = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        best_type, best_score = sorted_types[0]
        runner_up_score = sorted_types[1][1] if len(sorted_types) > 1 else 0

        if best_score < 5:
            return {"type": "General", "confidence": "low", "scores": scores}

        if runner_up_score == 0 or best_score >= 2 * runner_up_score:
            confidence = "high"
        elif best_score >= 1.5 * runner_up_score:
            confidence = "medium"
        else:
            confidence = "low"

        return {"type": best_type, "confidence": confidence, "scores": scores}

    def _check_missing_clauses(self, contract_type, found_clause_names):
        """Check for expected but missing clauses based on contract type."""
        expected = self.EXPECTED_CLAUSES_BY_TYPE.get(contract_type,
                    self.EXPECTED_CLAUSES_BY_TYPE.get("General", []))
        warnings = []
        for clause_name, severity, reason in expected:
            if clause_name not in found_clause_names:
                warnings.append({
                    "clause": clause_name,
                    "severity": severity,
                    "reason": reason,
                })
        # Sort: critical first, then important, then recommended
        severity_order = {"critical": 0, "important": 1, "recommended": 2}
        warnings.sort(key=lambda w: severity_order.get(w["severity"], 3))
        return warnings

    def _resolve_dependency_chain(self, clause_name, found_names, visited=None, depth=0):
        """Recursively resolve clause dependency chain with cycle detection."""
        if visited is None:
            visited = set()
        if depth >= 5:
            return {"satisfied": [], "missing": [], "circular": []}

        result = {"satisfied": [], "missing": [], "circular": []}
        deps = self.CLAUSE_DEPENDENCIES.get(clause_name, [])

        for dep in deps:
            if dep in visited:
                result["circular"].append(dep)
                continue

            visited.add(dep)
            if dep in found_names:
                result["satisfied"].append(dep)
            else:
                result["missing"].append(dep)

            # Recurse into sub-dependencies
            sub_result = self._resolve_dependency_chain(dep, found_names, visited.copy(), depth + 1)
            for sub_dep in sub_result["satisfied"]:
                if sub_dep not in result["satisfied"]:
                    result["satisfied"].append(sub_dep)
            for sub_dep in sub_result["missing"]:
                if sub_dep not in result["missing"]:
                    result["missing"].append(sub_dep)
            for sub_dep in sub_result["circular"]:
                if sub_dep not in result["circular"]:
                    result["circular"].append(sub_dep)

        return result

    def _analyze_clause_relationships(self, text, found_clauses):
        """Analyze inter-clause conflicts, dependencies, and ambiguities."""
        found_names = set(c["name"] for c in found_clauses)
        text_lower = text.lower()

        # Build dependency tree
        dependency_tree = {}
        all_circular = []
        for clause in found_clauses:
            deps = self._resolve_dependency_chain(clause["name"], found_names)
            dependency_tree[clause["name"]] = deps
            for circ in deps["circular"]:
                pair = tuple(sorted([clause["name"], circ]))
                if pair not in all_circular:
                    all_circular.append(pair)

        # Check conflicts
        conflicts = []
        for conflict_def in self.CLAUSE_CONFLICTS:
            a, b = conflict_def["clause_a"], conflict_def["clause_b"]
            if a in found_names and b in found_names:
                # For the broad_indemnification_narrow_liability check, verify patterns
                if "broad_patterns" in conflict_def and "narrow_patterns" in conflict_def:
                    has_broad = any(re.search(p, text_lower) for p in conflict_def["broad_patterns"])
                    has_narrow = any(re.search(p, text_lower) for p in conflict_def["narrow_patterns"])
                    if not (has_broad and has_narrow):
                        continue
                conflicts.append({
                    "clauses": [a, b],
                    "condition": conflict_def["condition"],
                    "description": conflict_def["description"],
                    "severity": conflict_def["severity"],
                })

        # Detect ambiguities within clause contexts
        ambiguities = []
        clause_excerpts = " ".join(
            " ".join(c.get("excerpts", [])) for c in found_clauses
        )
        for pattern, description in self.AMBIGUITY_PATTERNS:
            matches = re.finditer(pattern, clause_excerpts, re.IGNORECASE)
            for match in matches:
                start = max(0, match.start() - 30)
                end = min(len(clause_excerpts), match.end() + 60)
                context = clause_excerpts[start:end].strip()
                ambiguities.append({
                    "issue": description,
                    "matched": match.group(),
                    "context": context,
                })
        # Deduplicate ambiguities by issue
        seen_issues = set()
        unique_ambiguities = []
        for a in ambiguities:
            if a["issue"] not in seen_issues:
                seen_issues.add(a["issue"])
                unique_ambiguities.append(a)

        return {
            "conflicts": conflicts,
            "dependencies": dependency_tree,
            "circular_dependencies": [{"clauses": list(pair)} for pair in all_circular],
            "ambiguities": unique_ambiguities,
        }

    def _analyze_party_balance(self, text, parties):
        """Analyze the balance of obligations, protections, and powers between parties."""
        if len(parties) < 2:
            return {
                "parties": [{"name": p, "aliases": [], "role": "Unknown"} for p in parties],
                "balance_score": 0,
                "balance_label": "Insufficient party information",
                "party_analysis": [],
                "asymmetries": [],
            }

        # Extract aliases from parenthetical patterns near party names
        role_map = {
            "Client": "stronger", "Company": "stronger", "Employer": "stronger",
            "Landlord": "stronger", "Seller": "stronger", "Licensor": "stronger",
            "Lender": "stronger", "OEM": "stronger",
            "Contractor": "weaker", "Employee": "weaker", "Tenant": "weaker",
            "Buyer": "weaker", "Licensee": "weaker", "Borrower": "weaker",
            "Manufacturer": "weaker", "Vendor": "weaker", "Provider": "weaker",
        }

        party_info = []
        for party in parties[:2]:
            aliases = []
            role = "Unknown"
            # Look for parenthetical alias near party name
            alias_pattern = re.escape(party) + r'[^.]*?\("([^"]{2,30})"\)'
            alias_match = re.search(alias_pattern, text)
            if alias_match:
                alias = alias_match.group(1)
                aliases.append(alias)
                if alias in role_map:
                    role = alias
            party_info.append({"name": party, "aliases": aliases, "role": role})

        # Define directional analysis patterns
        obligation_patterns = [
            (r"{PARTY}\s+(?:shall|must|will|agrees?\s+to)\s+(?:indemnify|defend|hold\s+harmless)", "indemnification_obligation"),
            (r"{PARTY}\s+(?:shall|must|agrees?\s+to)\s+(?:pay|compensate|reimburse)", "payment_obligation"),
            (r"{PARTY}\s+(?:warrants?|represents?)", "warranty_obligation"),
            (r"{PARTY}\s+(?:shall|will)\s+not\s+(?:compete|solicit)", "restriction"),
        ]
        protection_patterns = [
            (r"{PARTY}\s+(?:shall|will)\s+not\s+(?:be\s+)?liable", "liability_protection"),
            (r"(?:at\s+)?{PARTY}(?:'s)?\s+(?:sole\s+)?(?:discretion|option|election)", "discretion_power"),
            (r"{PARTY}\s+(?:may|shall\s+have\s+the\s+right\s+to)\s+terminate", "termination_power"),
        ]

        party_analysis = []
        for info in party_info:
            search_terms = [re.escape(info["name"])] + [re.escape(a) for a in info["aliases"]]
            search_pattern = "|".join(search_terms)

            obligations = 0
            protections = 0
            powers = 0
            restrictions = 0

            for pat_template, pat_type in obligation_patterns:
                pattern = pat_template.replace("{PARTY}", "(?:" + search_pattern + ")")
                count = len(re.findall(pattern, text, re.IGNORECASE))
                if pat_type == "restriction":
                    restrictions += count
                else:
                    obligations += count

            for pat_template, pat_type in protection_patterns:
                pattern = pat_template.replace("{PARTY}", "(?:" + search_pattern + ")")
                count = len(re.findall(pattern, text, re.IGNORECASE))
                if pat_type in ("discretion_power", "termination_power"):
                    powers += count
                else:
                    protections += count

            party_analysis.append({
                "party": info["name"],
                "obligations": obligations,
                "protections": protections,
                "powers": powers,
                "restrictions": restrictions,
            })

        # Compute balance score
        p1, p2 = party_analysis[0], party_analysis[1]
        p1_burden = p1["obligations"] + p1["restrictions"] - p1["protections"] - p1["powers"]
        p2_burden = p2["obligations"] + p2["restrictions"] - p2["protections"] - p2["powers"]

        total = abs(p1_burden) + abs(p2_burden)
        if total > 0:
            balance_score = int(((p2_burden - p1_burden) / total) * 100)
        else:
            balance_score = 0
        balance_score = max(-100, min(100, balance_score))

        if abs(balance_score) < 15:
            balance_label = "Relatively balanced"
        elif balance_score < -40:
            balance_label = f"Significantly favors {party_info[0]['name']}"
        elif balance_score < 0:
            balance_label = f"Slightly favors {party_info[0]['name']}"
        elif balance_score > 40:
            balance_label = f"Significantly favors {party_info[1]['name']}"
        else:
            balance_label = f"Slightly favors {party_info[1]['name']}"

        # Detect asymmetries
        asymmetries = []
        if p1["obligations"] > 0 and p2["obligations"] == 0:
            asymmetries.append({
                "area": "Obligations",
                "description": f"Only {p1['party']} has explicit obligations",
                "severity": "high",
            })
        elif p2["obligations"] > 0 and p1["obligations"] == 0:
            asymmetries.append({
                "area": "Obligations",
                "description": f"Only {p2['party']} has explicit obligations",
                "severity": "high",
            })
        if p1["restrictions"] > 0 and p2["restrictions"] == 0:
            asymmetries.append({
                "area": "Restrictions",
                "description": f"Only {p1['party']} faces competitive restrictions",
                "severity": "medium",
            })
        elif p2["restrictions"] > 0 and p1["restrictions"] == 0:
            asymmetries.append({
                "area": "Restrictions",
                "description": f"Only {p2['party']} faces competitive restrictions",
                "severity": "medium",
            })

        return {
            "parties": party_info,
            "balance_score": balance_score,
            "balance_label": balance_label,
            "party_analysis": party_analysis,
            "asymmetries": asymmetries,
        }

    def _generate_summary(self, text, clauses, risks, contract_type=None, missing_warnings=None):
        """Generate a brief textual summary of the contract analysis."""
        parts = []

        if contract_type and contract_type.get("type") != "General":
            parts.append(
                f"This appears to be a {contract_type['type']} contract "
                f"(confidence: {contract_type.get('confidence', 'unknown')})."
            )

        word_count = len(text.split())
        parts.append(f"The document contains approximately {word_count} words.")

        found_count = len(clauses["found"])
        missing_count = len(clauses["missing"])
        parts.append(
            f"Detected {found_count} standard clause type(s) "
            f"with {missing_count} common clause type(s) not found."
        )

        high_count = len(risks["high"])
        medium_count = len(risks["medium"])
        if high_count > 0:
            parts.append(f"WARNING: {high_count} high-risk indicator(s) detected.")
        if medium_count > 0:
            parts.append(f"{medium_count} medium-risk indicator(s) found.")
        if high_count == 0 and medium_count == 0:
            parts.append("No significant risk indicators detected.")

        # Critical missing clause warnings
        if missing_warnings:
            critical = [w for w in missing_warnings if w["severity"] == "critical"]
            if critical:
                names = ", ".join(w["clause"] for w in critical[:3])
                parts.append(f"CRITICAL: Missing essential clauses: {names}.")

        if clauses["missing"]:
            parts.append(
                "Missing clauses that are commonly expected: "
                + ", ".join(clauses["missing"][:5])
                + "."
            )
        return " ".join(parts)

    def _compute_risk_score(self, risks, missing_warnings=None, clause_relations=None):
        """Compute a 0-100 risk score with category weighting and breakdown."""
        # Base risk scoring with category weights
        category_scores = {"financial": 0, "legal": 0, "operational": 0, "supply_chain": 0}
        base_points = {"high": 20, "medium": 10, "low": 3}

        base_score = 0
        for severity in ("high", "medium", "low"):
            for risk in risks.get(severity, []):
                points = base_points[severity]
                category = risk.get("category", "operational")
                weight = self.RISK_CATEGORIES.get(category, {}).get("weight", 1.0)
                weighted_points = int(points * weight)
                base_score += weighted_points
                if category in category_scores:
                    category_scores[category] += weighted_points

        # Missing clause penalty (capped at 25)
        missing_penalty = 0
        if missing_warnings:
            severity_points = {"critical": 15, "important": 8, "recommended": 3}
            for warning in missing_warnings:
                missing_penalty += severity_points.get(warning["severity"], 0)
            missing_penalty = min(missing_penalty, 25)

        # Clause conflict penalty (capped at 15)
        conflict_penalty = 0
        if clause_relations:
            severity_points = {"high": 12, "medium": 6, "low": 2}
            for conflict in clause_relations.get("conflicts", []):
                conflict_penalty += severity_points.get(conflict.get("severity", "low"), 0)
            conflict_penalty = min(conflict_penalty, 15)

        # Broken dependency chain penalty (capped at 10)
        dependency_penalty = 0
        if clause_relations:
            for clause_name, deps in clause_relations.get("dependencies", {}).items():
                dependency_penalty += len(deps.get("missing", [])) * 2
            dependency_penalty = min(dependency_penalty, 10)

        score = base_score + missing_penalty + conflict_penalty + dependency_penalty
        score = min(score, 100)

        if score <= 25:
            label = "Low Risk"
        elif score <= 50:
            label = "Moderate Risk"
        elif score <= 75:
            label = "High Risk"
        else:
            label = "Critical Risk"

        return {
            "score": score,
            "label": label,
            "breakdown": {
                "base_risk_score": min(base_score, 100),
                "missing_clause_penalty": missing_penalty,
                "clause_conflict_penalty": conflict_penalty,
                "dependency_penalty": dependency_penalty,
                "category_scores": category_scores,
            },
        }

    def _generate_negotiation_suggestions(self, text, risks, missing_warnings, clause_relations, party_balance):
        """Generate actionable negotiation suggestions based on analysis results."""
        suggestions = []
        seen = set()

        # Collect all risk descriptions for matching
        all_risk_descs = []
        for severity in ("high", "medium", "low"):
            for risk in risks.get(severity, []):
                all_risk_descs.append(risk["description"])

        missing_clause_names = [w["clause"] for w in (missing_warnings or [])]
        conflict_conditions = [c["condition"] for c in clause_relations.get("conflicts", [])] if clause_relations else []

        for rule in self.NEGOTIATION_RULES:
            trigger = rule["trigger_type"]
            match_str = rule["trigger_match"]

            if trigger == "risk":
                if not any(match_str.lower() in desc.lower() for desc in all_risk_descs):
                    continue
            elif trigger == "missing_clause":
                if match_str not in missing_clause_names:
                    continue
            elif trigger == "clause_conflict":
                if match_str not in conflict_conditions:
                    continue
            elif trigger == "pattern":
                m = re.search(match_str, text, re.IGNORECASE)
                if not m:
                    continue
                template = rule.get("suggestion_template", "")
                if template and m.groups():
                    suggestion_text = template.format(*m.groups())
                else:
                    continue
                if suggestion_text not in seen:
                    seen.add(suggestion_text)
                    suggestions.append({
                        "suggestion": suggestion_text,
                        "priority": rule["priority"],
                        "basis": f"Pattern detected: {m.group()[:60]}",
                    })
                continue
            else:
                continue

            suggestion_text = rule.get("suggestion", "")
            if suggestion_text and suggestion_text not in seen:
                seen.add(suggestion_text)
                basis = f"{trigger.replace('_', ' ').title()}: {match_str}"
                suggestions.append({
                    "suggestion": suggestion_text,
                    "priority": rule["priority"],
                    "basis": basis,
                })

        # Party balance-driven suggestions
        if party_balance and abs(party_balance.get("balance_score", 0)) > 40:
            label = party_balance.get("balance_label", "")
            suggestion_text = f"This contract {label.lower()}. Consider negotiating more balanced terms."
            if suggestion_text not in seen:
                seen.add(suggestion_text)
                suggestions.append({
                    "suggestion": suggestion_text,
                    "priority": "medium",
                    "basis": f"Party balance score: {party_balance['balance_score']}",
                })

        for asym in (party_balance or {}).get("asymmetries", []):
            if asym.get("severity") == "high":
                suggestion_text = f"Address asymmetry: {asym['description']}"
                if suggestion_text not in seen:
                    seen.add(suggestion_text)
                    suggestions.append({
                        "suggestion": suggestion_text,
                        "priority": "high",
                        "basis": f"Asymmetry: {asym['area']}",
                    })

        # Sort by priority
        priority_order = {"high": 0, "medium": 1, "low": 2}
        suggestions.sort(key=lambda s: priority_order.get(s["priority"], 3))
        return suggestions[:15]
