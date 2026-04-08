"""Specialized agent for detecting and analyzing contract clauses."""

import re

from agents import patterns
from agents.base_agent import BaseAgent


# Iterate sentences with their start offset in the original text, so we can
# track citation spans at the full-text level.
_SENTENCE_RE = re.compile(r"[^.!?]+[.!?]?", re.DOTALL)


class ClauseDetectionAgent(BaseAgent):
    """Detects standard contract clauses, assesses completeness, and flags gaps."""

    name = "ClauseDetectionAgent"
    specialty = "Clause Detection & Completeness"

    # Aliases kept for any legacy callers that read these off the class.
    CLAUSE_PATTERNS = patterns.CLAUSE_PATTERNS_RAW
    CRITICAL_CLAUSES = patterns.CRITICAL_CLAUSES

    def _perform_analysis(self, text, context):
        found = []
        citations = []
        total_clauses = len(patterns.CLAUSE_PATTERNS)

        # Walk each sentence once, keeping its (start, end) in the full text
        sentences = [
            (m.start(), m.end(), m.group(0).strip())
            for m in _SENTENCE_RE.finditer(text) if m.group(0).strip()
        ]

        cache = context.get("match_cache") if context else None

        for clause_name, compiled_patterns in patterns.CLAUSE_PATTERNS.items():
            matching = []
            clause_citations = []
            for i, pattern in enumerate(compiled_patterns):
                # Read from cache or fall back to direct search against sentences
                if cache is not None:
                    hit_sentences = self._sentences_for_pattern_hits(
                        cache.get(f"clause:{clause_name}:{i}"), sentences
                    )
                else:
                    hit_sentences = [
                        (s, e, t) for s, e, t in sentences if pattern.search(t)
                    ]
                for sent_start, sent_end, sent_text in hit_sentences:
                    clean = sent_text[:300]
                    if clean not in matching:
                        matching.append(clean)
                        clause_citations.append({
                            "start": sent_start,
                            "end": sent_end,
                            "label": clause_name,
                            "excerpt": clean[:160],
                            "line": cache.line_for(sent_start) if cache else None,
                        })
            if matching:
                found.append({
                    "name": clause_name,
                    "present": True,
                    "excerpts": matching[:3],
                    "match_strength": min(len(matching), 3),
                })
                citations.extend(clause_citations[:3])

        found_names = {c["name"] for c in found}
        missing = [n for n in patterns.CLAUSE_PATTERNS if n not in found_names]
        missing_critical = [n for n in missing if n in patterns.CRITICAL_CLAUSES]

        completeness = len(found) / total_clauses * 100 if total_clauses else 0

        return {
            "found": found,
            "missing": missing,
            "missing_critical": missing_critical,
            "completeness_pct": round(completeness, 1),
            "total_checked": total_clauses,
            "_citations": citations,
        }

    @staticmethod
    def _sentences_for_pattern_hits(match_tuples, sentences):
        """Given cached pattern matches, return the sentences containing each."""
        if not match_tuples:
            return []
        hits = []
        seen = set()
        for start, end, _g0, _groups in match_tuples:
            for sent_start, sent_end, sent_text in sentences:
                if sent_start <= start < sent_end:
                    key = (sent_start, sent_end)
                    if key not in seen:
                        seen.add(key)
                        hits.append((sent_start, sent_end, sent_text))
                    break
        return hits

    def _extract_insights(self, findings):
        insights = []
        pct = findings["completeness_pct"]
        insights.append(f"Contract clause completeness: {pct}%")
        if findings["missing_critical"]:
            insights.append(
                f"CRITICAL clauses missing: {', '.join(findings['missing_critical'])}"
            )
        count = len(findings["found"])
        insights.append(f"{count} of {findings['total_checked']} standard clauses detected")
        return insights

    def _identify_warnings(self, findings):
        warnings = []
        for clause in findings["missing_critical"]:
            warnings.append(f"Missing critical clause: {clause}")
        if findings["completeness_pct"] < 50:
            warnings.append("Contract has less than 50% of standard clauses")
        return warnings

    def _state_assumptions(self, findings):
        return [
            "Regex pattern matching; nuanced or paraphrased clauses may be missed",
            "Clause completeness is based on 12 common commercial contract clauses",
        ]

    def _compute_confidence(self, findings):
        strong = sum(1 for c in findings["found"] if c["match_strength"] >= 2)
        total = max(len(findings["found"]), 1)
        return round(0.5 + 0.5 * (strong / total), 2)
