
export const DOCX_EXTRACTOR_VERSION="docx-negotiation-2026-10-09.v2";
export const DOCX_CHUNK_PREFIX="CONTRACTTWIN_DOCX_EVIDENCE_V1\n";
export type XmlSource={part:string;path:string};
export type XmlNode={name:string;namespace:string;attributes:Array<{name:string;namespace:string;value:string}>;source:XmlSource;text:string|null;children:XmlNode[]};
export type DocxIssue={code:string;source:XmlSource|null;message:string;blocking:boolean};
export type DocxRevision={key:string;id:string|null;kind:string;author:string|null;date:string|null;source:XmlSource;properties:XmlNode};
export type CommentAnchor={kind:"start"|"end"|"reference";source:XmlSource;paragraphPath:string|null;storyOffset:number;paragraphOffset:number};
export type DocxComment={id:string;author:string|null;initials:string|null;date:string|null;source:XmlSource;text:string;anchors:CommentAnchor[]};
export type DocxRun={text:string;source:XmlSource;revisionKeys:string[];commentIds:string[];kind:string};
export type DocxTableCell={source:XmlSource;originalText:string;proposedText:string;properties:XmlNode|null};
export type DocxParagraph={source:XmlSource;ancestors:Array<{name:string;source:XmlSource}>;style:string|null;numbering:XmlNode|null;tableContext:{source:XmlSource;rowIndex:number;cellIndex:number;gridColumn:number;gridSpan:number;verticalMerge:string|null;rowCells:DocxTableCell[];firstRow:DocxTableCell[];headerRows:DocxTableCell[][]}|null;runs:DocxRun[];originalText:string;proposedText:string};
export type DocxEvidence={
  version:1;extractorVersion:string;sourceSha256:string;legalEvidenceReady:false;
  analysisEligible:boolean;issues:DocxIssue[];
  parts:Array<{part:string;sha256:string;sizeBytes:number;tree:XmlNode|null}>;
  relationships:Array<{part:string;id:string;type:string;target:string;resolvedTarget:string|null;external:boolean}>;
  stories:Array<{part:string;kind:string;paragraphs:DocxParagraph[]}>;
  revisions:DocxRevision[];comments:DocxComment[];
  references:Array<{kind:string;id:string;source:XmlSource;target:XmlSource|null}>;
};
export type DocxProjection={version:1;sourceSha256:string;storyKind:string;paragraph:DocxParagraph;revisions:DocxRevision[];comments:DocxComment[];references:DocxEvidence["references"];context:"UNAPPROVED_NEGOTIATION_EVIDENCE"};
export function projectDocxParagraph(evidence:DocxEvidence,paragraph:DocxParagraph):DocxProjection{
  const keys=new Set(paragraph.runs.flatMap(r=>r.revisionKeys));
  return {version:1,context:"UNAPPROVED_NEGOTIATION_EVIDENCE",sourceSha256:evidence.sourceSha256,storyKind:evidence.stories.find(s=>s.part===paragraph.source.part)!.kind,paragraph,revisions:evidence.revisions.filter(r=>keys.has(r.key)),comments:evidence.comments.filter(c=>c.anchors.some(a=>a.source.part===paragraph.source.part&&a.paragraphPath===paragraph.source.path)||paragraph.runs.some(r=>r.commentIds.includes(c.id))),references:evidence.references.filter(r=>r.source.part===paragraph.source.part&&r.source.path.startsWith(paragraph.source.path+"/"))};
}
export function readDocxProjection(text:string):DocxProjection|null{
  if(!text.startsWith(DOCX_CHUNK_PREFIX))return null;
  const value=JSON.parse(text.slice(DOCX_CHUNK_PREFIX.length)) as DocxProjection;
  if(value.version!==1||value.context!=="UNAPPROVED_NEGOTIATION_EVIDENCE"||typeof value.storyKind!=="string"||!Array.isArray(value.paragraph?.runs)||typeof value.paragraph.originalText!=="string"||typeof value.paragraph.proposedText!=="string")throw new Error("Invalid DOCX evidence projection.");
  return value;
}

// Metadata and comments cannot ground a contract quotation. Views are hypotheses,
// not an operative agreement; whitespace/case normalization is legacy behavior.
export function sourceTextViews(text:string):string[]{
  if(!text.startsWith(DOCX_CHUNK_PREFIX))return [text];
  // Precedence analysis supplies multiple complete envelopes separated by two
  // newlines. JSON escapes source newlines, so content cannot forge a boundary.
  return text.split(`\n\n${DOCX_CHUNK_PREFIX}`).flatMap((chunk,index)=>{
    const projection=readDocxProjection(index?DOCX_CHUNK_PREFIX+chunk:chunk)!;
    return [projection.paragraph.originalText,projection.paragraph.proposedText];
  });
}
export function proposedTextContainsExcerpt(text:string,excerpt:string){
  const projection=readDocxProjection(text),normalize=(s:string)=>s.replace(/\s+/g," ").trim().toLowerCase(),needle=normalize(excerpt);
  return projection?Boolean(excerpt.trim())&&projection.paragraph.proposedText.includes(excerpt):Boolean(needle)&&normalize(text).includes(needle);
}
