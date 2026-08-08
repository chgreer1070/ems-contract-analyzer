"use client";

import { useEffect, useMemo, useState } from "react";

const decisionTypes=[
  ["ACCEPT","Accept terms"],
  ["NEGOTIATE","Continue negotiation"],
  ["ESCALATE","Escalate for decision"],
  ["REJECT","Reject terms"],
  ["APPROVE_EXCEPTION","Approve exception"]
] as const;

type DecisionType=(typeof decisionTypes)[number][0];
type EligibleFinding={
  id:string;
  document_id:string|null;
  clause_family:string;
  issue:string;
  risk_level:string;
  review_status:string;
  is_current:boolean;
};
type AgreementVersion={
  id:string;
  version_number:number;
  label:string;
  status:string;
  documents:Array<{documentId:string;filename:string}>;
};

const findingRequired=(decisionType:DecisionType)=>
  decisionType==="ACCEPT"||decisionType==="APPROVE_EXCEPTION";

export default function DecisionRequestPanel({matterId}:{matterId:string}){
  const [decisionType,setDecisionType]=useState<DecisionType>("APPROVE_EXCEPTION");
  const [agreementVersionId,setAgreementVersionId]=useState("");
  const [versions,setVersions]=useState<AgreementVersion[]>([]);
  const [findingId,setFindingId]=useState("");
  const [findings,setFindings]=useState<EligibleFinding[]>([]);
  const [loadStatus,setLoadStatus]=useState("Loading agreement versions and lawyer-validated findings…");
  const [rationale,setRationale]=useState("");
  const [conditions,setConditions]=useState("");
  const [role,setRole]=useState("APPROVER");
  const [status,setStatus]=useState("");
  const [busy,setBusy]=useState(false);

  useEffect(()=>{
    let active=true;
    const load=async()=>{
      try{
        const [versionResponse,findingResponse]=await Promise.all([
          fetch(`/api/matters/${encodeURIComponent(matterId)}/versions`,{cache:"no-store"}),
          fetch(`/api/matters/${encodeURIComponent(matterId)}/findings`,{cache:"no-store"})
        ]);
        const [versionPayload,findingPayload]=await Promise.all([
          versionResponse.json().catch(()=>({})),findingResponse.json().catch(()=>({}))
        ]);
        if(!versionResponse.ok)throw new Error(versionPayload.error||"Agreement versions could not be loaded.");
        if(!findingResponse.ok)throw new Error(findingPayload.error||"Validated findings could not be loaded.");
        if(!active)return;
        const available=(versionPayload.versions||[]).filter((version:AgreementVersion)=>
          version.status==="WORKING"||version.status==="APPROVED"
        );
        setVersions(available);
        setAgreementVersionId(previous=>available.some((version:AgreementVersion)=>version.id===previous)
          ?previous
          :(available[0]?.id||""));
        setFindings(findingPayload.findings||[]);
        setLoadStatus(available.length
          ?"Authority is bound to the selected version; only current, lawyer-validated findings in that source set are eligible."
          :"Create a WORKING agreement version before requesting a decision.");
      }catch(error){
        if(!active)return;
        setVersions([]);setAgreementVersionId("");setFindings([]);
        setLoadStatus(error instanceof Error?error.message:"Agreement authority context could not be loaded.");
      }
    };
    void load();
    return()=>{active=false;};
  },[matterId]);

  const selectedVersion=useMemo(
    ()=>versions.find(version=>version.id===agreementVersionId),
    [agreementVersionId,versions]
  );
  const eligibleFindings=useMemo(()=>{
    const documentIds=new Set((selectedVersion?.documents||[]).map(document=>document.documentId));
    return findings.filter(finding=>
      finding.review_status==="VALIDATED"&&finding.is_current&&
      Boolean(finding.document_id&&documentIds.has(finding.document_id))
    );
  },[findings,selectedVersion]);
  const selectedFinding=useMemo(
    ()=>eligibleFindings.find(finding=>finding.id===findingId),
    [eligibleFindings,findingId]
  );
  useEffect(()=>{
    if(findingId&&!eligibleFindings.some(finding=>finding.id===findingId))setFindingId("");
  },[eligibleFindings,findingId]);

  const needsFinding=findingRequired(decisionType);
  const canSubmit=!busy&&Boolean(selectedVersion)&&rationale.trim().length>=10&&
    (!needsFinding||Boolean(selectedFinding));

  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();
    if(!selectedVersion){setStatus("Select a WORKING or APPROVED agreement version.");return;}
    if(needsFinding&&!selectedFinding){
      setStatus("Select a current lawyer-validated finding in this agreement version for the binding disposition.");
      return;
    }
    setBusy(true);setStatus("");
    try{
      const response=await fetch("/api/decision-requests",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          matterId,agreementVersionId:selectedVersion.id,decisionType,
          findingId:findingId||null,rationale:rationale.trim(),
          conditions:conditions.trim()||null,requiredApproverRole:role
        })
      });
      const payload=await response.json().catch(()=>({}));
      setStatus(response.ok
        ?`Decision request ${payload.decisionId} created for v${selectedVersion.version_number} and routed to ${payload.requiredApproverRole}.`
        :(payload.error||"Decision request failed."));
      if(response.ok){
        setRationale("");setConditions("");setFindingId("");
        setTimeout(()=>window.location.reload(),650);
      }
    }catch(error){
      setStatus(error instanceof Error?error.message:"Decision request failed.");
    }finally{setBusy(false);}
  };

  return <section style={{maxWidth:1600,margin:"10px auto 0",padding:"0 30px"}}>
    <details style={{background:"white",border:"1px solid #e0e5ea",borderRadius:12,padding:"12px 16px"}}>
      <summary style={{cursor:"pointer",fontWeight:800,fontSize:13}}>Request executive / exception decision</summary>
      <p style={hint}>A recommendation is not an approval. Every request is bound to one frozen source set and creates a separate pending authority record.</p>
      <form onSubmit={submit} style={formGrid}>
        <Field label="Agreement version (required)">
          <select required value={agreementVersionId} onChange={event=>setAgreementVersionId(event.target.value)}>
            <option value="">Select version</option>
            {versions.map(version=><option key={version.id} value={version.id}>v{version.version_number} · {version.label} · {version.status}</option>)}
          </select>
        </Field>
        <Field label="Decision type">
          <select required value={decisionType} onChange={event=>setDecisionType(event.target.value as DecisionType)}>
            {decisionTypes.map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label={needsFinding?"Current validated finding (required)":"Current validated finding (optional)"}>
          <select value={findingId} onChange={event=>setFindingId(event.target.value)} required={needsFinding}>
            <option value="">{needsFinding?"Select a finding":"Version-level request"}</option>
            {eligibleFindings.map(finding=><option key={finding.id} value={finding.id}>{finding.risk_level} · {finding.clause_family} · {finding.issue}</option>)}
          </select>
        </Field>
        <Field label="Rationale">
          <input required minLength={10} maxLength={4000} value={rationale}
            onChange={event=>setRationale(event.target.value)} placeholder="Business/legal reason and consequence"/>
        </Field>
        <Field label="Conditions / guardrails">
          <textarea maxLength={4000} value={conditions} rows={3}
            onChange={event=>setConditions(event.target.value)} placeholder="Optional; enter one independently clearable condition per line"/>
        </Field>
        <Field label="Authority">
          <select value={role} onChange={event=>setRole(event.target.value)}><option>APPROVER</option><option>ADMIN</option></select>
        </Field>
        <button disabled={!canSubmit} style={primary}>{busy?"Routing…":"Create request"}</button>
      </form>
      <p style={hint}>{loadStatus} {selectedVersion&&eligibleFindings.length===0?"No eligible current findings are available in this version.":""}</p>
      {status&&<p role="status" style={{fontSize:11,color:"#6b5423"}}>{status}</p>}
    </details>
  </section>;
}

const formGrid:React.CSSProperties={display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))",gap:9,alignItems:"end"};
const primary:React.CSSProperties={background:"#17212b",color:"white",border:0,borderRadius:8,padding:"9px 12px",fontWeight:800};
const hint:React.CSSProperties={fontSize:11,color:"#74808a"};

function Field({label,children}:{label:string;children:React.ReactNode}){
  return <label style={{fontSize:10,fontWeight:800,color:"#53616e"}}>{label}<div style={{marginTop:4}}>{children}</div>
    <style jsx>{`input,select,textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #d5dce3;border-radius:7px;font:inherit}`}</style>
  </label>;
}
