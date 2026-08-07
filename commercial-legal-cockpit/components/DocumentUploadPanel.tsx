"use client";

import { upload } from "@vercel/blob/client";
import { useState } from "react";

async function sha256(file:File){
  const bytes=await file.arrayBuffer();
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

export default function DocumentUploadPanel({matterId}:{matterId:string}){
  const [file,setFile]=useState<File|null>(null);const [documentType,setDocumentType]=useState("MSA");const [versionLabel,setVersionLabel]=useState("");const [busy,setBusy]=useState(false);const [status,setStatus]=useState("");
  const submit=async(e:React.FormEvent)=>{e.preventDefault();if(!file)return;setBusy(true);setStatus("Computing source fingerprint…");try{
    const digest=await sha256(file);setStatus("Uploading to private source storage…");
    const safeName=file.name.replace(/[^a-zA-Z0-9._-]+/g,"-");
    await upload(`contracts/${matterId}/${Date.now()}-${safeName}`,file,{access:"private",handleUploadUrl:"/api/documents/upload",clientPayload:JSON.stringify({matterId,documentType,versionLabel:versionLabel.trim()||null,filename:file.name,sha256:digest,sizeBytes:file.size,sourceStatus:"CURRENT"})});
    setStatus("Upload registered. Reloading source set…");setFile(null);setTimeout(()=>window.location.reload(),600);
  }catch(error){setStatus(error instanceof Error?error.message:"Document upload failed.");}finally{setBusy(false)}};
  return <section style={{maxWidth:1600,margin:"18px auto 0",padding:"0 30px"}}><details style={{background:"white",border:"1px solid #e0e5ea",borderRadius:12,padding:"12px 16px"}}><summary style={{cursor:"pointer",fontWeight:800,fontSize:13}}>Add source document</summary><form onSubmit={submit} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr auto",gap:10,alignItems:"end",marginTop:14}}><label style={{fontSize:11,fontWeight:700}}>File<input required type="file" accept=".pdf,.docx,.txt,.xlsx" onChange={e=>setFile(e.target.files?.[0]||null)} style={{display:"block",width:"100%",marginTop:5}}/></label><label style={{fontSize:11,fontWeight:700}}>Document type<select value={documentType} onChange={e=>setDocumentType(e.target.value)} style={{display:"block",width:"100%",marginTop:5,padding:8}}>{["MSA","SOW","AMENDMENT","EXHIBIT","QUALITY_AGREEMENT","PRICING_AGREEMENT","PURCHASE_ORDER","OTHER"].map(v=><option key={v}>{v}</option>)}</select></label><label style={{fontSize:11,fontWeight:700}}>Version label<input value={versionLabel} onChange={e=>setVersionLabel(e.target.value)} placeholder="Executed / Redline v4" style={{display:"block",width:"100%",marginTop:5,padding:8}}/></label><button disabled={!file||busy} style={{padding:"9px 13px",border:0,borderRadius:8,background:"#17212b",color:"white",fontWeight:800}}>{busy?"Uploading…":"Upload source"}</button></form>{status&&<p style={{fontSize:11,color:"#61707d",marginBottom:0}}>{status}</p>}</details></section>;
}
