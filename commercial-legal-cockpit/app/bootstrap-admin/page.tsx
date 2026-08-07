"use client";
import { useState } from "react";

export default function BootstrapAdminPage(){
 const [status,setStatus]=useState("");const [busy,setBusy]=useState(false);
 const bootstrap=async()=>{setBusy(true);setStatus("");const r=await fetch("/api/admin/bootstrap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})});const j=await r.json().catch(()=>({}));setStatus(r.ok?`${j.message} You can now open the Admin console.`:j.error||"Bootstrap failed.");setBusy(false);};
 return <main className="signin-shell"><section className="signin-card"><div className="eyebrow">ONE-TIME PRODUCTION BOOTSTRAP</div><h1>Establish the first ContractTwin Admin</h1><p>Sign in first with the exact Entra identity configured in <code>BOOTSTRAP_ADMIN_EMAIL</code>. This operation succeeds only when no active Admin exists and requires explicit confirmation.</p><button className="primary" disabled={busy} onClick={()=>void bootstrap()}>{busy?"Checking controls…":"Bootstrap first Admin"}</button>{status&&<div className="signin-note">{status}</div>}<p className="signin-note">After success, remove <code>BOOTSTRAP_ADMIN_EMAIL</code> from the production environment. All later role changes must use the audited Admin role-management workflow.</p><a href="/admin">Open Admin console</a></section></main>;
}
