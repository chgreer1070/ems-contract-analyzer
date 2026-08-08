import { AGREEMENT_GRAPH_VERSION, CLAUSE_SCHEMA_VERSION, DEPENDENCY_PROMPT_VERSION, DEPENDENCY_SCHEMA_VERSION, ECONOMICS_FORMULA_VERSION, PIPELINE_VERSION, PRECEDENCE_PROMPT_VERSION, PRECEDENCE_SCHEMA_VERSION, PROMPT_VERSION, TERM_PROMPT_VERSION, TERM_SCHEMA_VERSION } from "@/lib/engineVersions";

export function currentEngineManifest(){
  const modelName=process.env.OPENAI_MODEL||"gpt-5.6";
  return {
    modelName,
    clauseRisk:{promptVersion:PROMPT_VERSION,schemaVersion:CLAUSE_SCHEMA_VERSION},
    termExtraction:{promptVersion:TERM_PROMPT_VERSION,schemaVersion:TERM_SCHEMA_VERSION},
    dependency:{promptVersion:DEPENDENCY_PROMPT_VERSION,schemaVersion:DEPENDENCY_SCHEMA_VERSION},
    precedence:{promptVersion:PRECEDENCE_PROMPT_VERSION,schemaVersion:PRECEDENCE_SCHEMA_VERSION},
    economicsFormulaVersion:ECONOMICS_FORMULA_VERSION,
    pipelineVersion:PIPELINE_VERSION,
    agreementGraphVersion:AGREEMENT_GRAPH_VERSION
  } as const;
}
