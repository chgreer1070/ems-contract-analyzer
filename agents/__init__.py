"""Multi-agent orchestration system for contract analysis."""

from agents.base_agent import BaseAgent, AgentResult
from agents.clause_agent import ClauseDetectionAgent
from agents.risk_agent import RiskAssessmentAgent
from agents.financial_agent import FinancialAnalysisAgent
from agents.obligation_agent import ObligationExtractionAgent
from agents.temporal_agent import TemporalAnalysisAgent
from agents.party_agent import PartyIdentificationAgent
from agents.cross_validator import CrossValidationAgent
from agents.executive_reviewer import ExecutiveReviewAgent

__all__ = [
    "BaseAgent",
    "AgentResult",
    "ClauseDetectionAgent",
    "RiskAssessmentAgent",
    "FinancialAnalysisAgent",
    "ObligationExtractionAgent",
    "TemporalAnalysisAgent",
    "PartyIdentificationAgent",
    "CrossValidationAgent",
    "ExecutiveReviewAgent",
]
