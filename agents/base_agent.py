"""Base agent class for the multi-agent orchestration system."""

import time
from dataclasses import dataclass, field


@dataclass
class AgentResult:
    """Standardized result from any analysis agent."""
    agent_name: str
    specialty: str
    findings: dict = field(default_factory=dict)
    top_insights: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    assumptions: list = field(default_factory=list)
    confidence: float = 0.0
    execution_time_ms: float = 0.0
    metadata: dict = field(default_factory=dict)
    citations: list = field(default_factory=list)

    def to_dict(self):
        return {
            "agent_name": self.agent_name,
            "specialty": self.specialty,
            "findings": self.findings,
            "top_insights": self.top_insights,
            "warnings": self.warnings,
            "assumptions": self.assumptions,
            "confidence": self.confidence,
            "execution_time_ms": self.execution_time_ms,
            "metadata": self.metadata,
            "citations": self.citations,
        }


class BaseAgent:
    """Abstract base class for all specialized analysis agents.

    Subclasses implement ``_perform_analysis(text, context) -> dict``.
    Citations are passed by having the subclass append dicts to
    ``findings["_citations"]``; the base class extracts that key out of
    findings into ``AgentResult.citations`` so the return value stays clean.
    """

    name = "BaseAgent"
    specialty = "General"

    def analyze(self, text, context=None):
        """Run this agent's analysis and return an AgentResult."""
        start = time.time()
        findings = self._perform_analysis(text, context or {})
        if not isinstance(findings, dict):
            findings = {}

        # Extract citations piggybacked in findings (thread-safe: local scope)
        citations = findings.pop("_citations", []) or []

        # Attach agent name to every citation, assign stable ids
        prepared_citations = []
        for i, cite in enumerate(citations):
            entry = dict(cite)  # copy
            entry.setdefault("agent", self.name)
            entry.setdefault("id", f"{self.name}-{i}")
            prepared_citations.append(entry)

        insights = self._extract_insights(findings)
        warnings = self._identify_warnings(findings)
        assumptions = self._state_assumptions(findings)
        confidence = self._compute_confidence(findings)
        elapsed = (time.time() - start) * 1000

        return AgentResult(
            agent_name=self.name,
            specialty=self.specialty,
            findings=findings,
            top_insights=insights[:3],
            warnings=warnings,
            assumptions=assumptions,
            confidence=confidence,
            execution_time_ms=round(elapsed, 2),
            citations=prepared_citations,
        )

    def _perform_analysis(self, text, context):
        raise NotImplementedError

    def _extract_insights(self, findings):
        return []

    def _identify_warnings(self, findings):
        return []

    def _state_assumptions(self, findings):
        return ["Text is a valid contract document"]

    def _compute_confidence(self, findings):
        return 0.5
