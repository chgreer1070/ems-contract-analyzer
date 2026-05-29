"""Actionable contract mitigation playbook generation."""


def build_action_plan(clauses, risks, financial_terms, key_dates, obligations):
    """Build a prioritized action plan from extracted analysis artifacts."""
    items = []

    missing = set((clauses or {}).get("missing", []))
    if "Limitation of Liability" in missing:
        items.append({
            "priority": "critical",
            "title": "Add a limitation of liability cap",
            "why": "Unlimited or unbounded exposure can create catastrophic downside.",
            "how": "Cap direct damages (for example: fees paid in last 12 months) and exclude indirect/consequential damages.",
        })
    if "Termination" in missing:
        items.append({
            "priority": "high",
            "title": "Insert a clear termination clause",
            "why": "Without exit rights, obligations may continue longer than intended.",
            "how": "Define for-cause and convenience termination, notice period, and post-termination obligations.",
        })
    if "Dispute Resolution" in missing:
        items.append({
            "priority": "high",
            "title": "Define dispute resolution process",
            "why": "Ambiguous dispute mechanics increase cost and time to enforce rights.",
            "how": "Specify governing law, venue, and whether arbitration or courts are required.",
        })
    if "Confidentiality" in missing:
        items.append({
            "priority": "high",
            "title": "Add confidentiality protections",
            "why": "Sensitive data may be exposed without use/disclosure restrictions.",
            "how": "Include confidentiality obligations, permitted disclosures, and survival period.",
        })
    if "Payment Terms" in missing:
        items.append({
            "priority": "high",
            "title": "Add explicit payment mechanics",
            "why": "Missing billing terms can lead to collection delays and pricing disputes.",
            "how": "Define invoicing cycle, due dates, late fees, and disputed-charge process.",
        })

    risk_rules = {
        "Unlimited liability exposure": (
            "critical",
            "Narrow unlimited liability language",
            "Carve-outs should be narrowly scoped to avoid open-ended risk."
        ),
        "Auto-renewal term": (
            "medium",
            "Control auto-renewal",
            "Silent renewals can lock the business into unwanted spend."
        ),
        "Broad indemnification obligation": (
            "high",
            "Constrain indemnity scope",
            "Broad indemnity can transfer disproportionate legal risk."
        ),
    }
    all_risks = (risks or {}).get("high", []) + (risks or {}).get("medium", []) + (risks or {}).get("low", [])
    for risk in all_risks:
        desc = risk.get("description", "")
        if desc in risk_rules:
            priority, title, why = risk_rules[desc]
            items.append({
                "priority": priority,
                "title": title,
                "why": why,
                "how": f"Trigger phrase found: '{risk.get('matched', '').strip()}'. Draft redlines around this language.",
            })

    if not key_dates:
        items.append({
            "priority": "medium",
            "title": "Add operational dates and deadlines",
            "why": "Undefined timelines make enforcement and delivery tracking difficult.",
            "how": "Define effective date, milestones, payment due dates, and renewal/cancellation windows.",
        })
    if financial_terms and not any("$" in (f.get("value", "")) for f in financial_terms):
        items.append({
            "priority": "medium",
            "title": "Clarify monetary amounts",
            "why": "Percentages without base amounts create billing ambiguity.",
            "how": "Specify currency, fixed fees, and formula inputs for variable charges.",
        })
    if obligations and len(obligations) > 15:
        items.append({
            "priority": "low",
            "title": "Create obligation tracker",
            "why": "A high number of duties increases operational non-compliance risk.",
            "how": "Export obligations into a checklist with owners and due dates.",
        })

    priority_score = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    deduped = []
    seen_titles = set()
    for item in items:
        if item["title"] in seen_titles:
            continue
        seen_titles.add(item["title"])
        deduped.append(item)

    deduped.sort(key=lambda item: priority_score.get(item["priority"], 4))
    return deduped[:7]
