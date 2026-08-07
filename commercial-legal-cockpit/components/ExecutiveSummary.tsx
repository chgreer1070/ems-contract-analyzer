"use client";
import { useEffect, useState } from "react";
import styles from "./ExecutiveSummary.module.css";

export default function ExecutiveSummary({matterId,snapshotId}:{matterId:string;snapshotId?:string}){
  const [data,setData]=useState<any>(null);const [error,setError]=useState("");
  useEffect(()=>{void(async()=>{try{const r=await fetch(`/api/matters/${matterId}/workspace`,{cache:"no-store"});const j=await r.json();if(!r.ok)throw new Error(j.error||"Unable to load summary.");setData(j);}catch(e){setError(e instanceof Error?e.message:"Unable to load summary.");}})()},[matterId]);
  if(error)return <main className={styles.loading}>{error}</main>;if(!data)return <main className={styles.loading}>Loading executive brief…</main>;
  const snapshot=(snapshotId?data.snapshots.find((s:any)=>s.id===snapshotId):null)||data.snapshots[0];
  if(!snapshot)return <main className={styles.loading}>No frozen executive snapshot exists for this matter.</main>;
  const m=data.matter;const risks=Array.isArray(snapshot.top_risks)?snapshot.top_risks:[];const deps=Array.isArray(snapshot.dependencies)?snapshot.dependencies:[];const actions=Array.isArray(snapshot.negotiation_actions)?snapshot.negotiation_actions:[];const decisions=Array.isArray(snapshot.executive_decisions)?snapshot.executive_decisions:[];const next=Array.isArray(snapshot.next_steps)?snapshot.next_steps:[];const econ=snapshot.quantified_exposure||{};
  const money=(v:any)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",notation:"compact",maximumFractionDigits:1}).format(Number(v)||0);
  return <main className={styles.page}>
    <div className={styles.controls}><a href={`/matters/${matterId}`}>← Matter workspace</a><button onClick={()=>window.print()}>Print / Save PDF</button></div>
    <header><div className={styles.eyebrow}>CONTRACTTWIN · EXECUTIVE DECISION BRIEF</div><h1>{m.customer}</h1><p>{m.agreement_title} · {m.matter_number} · {m.region}</p><div className={styles.meta}><span>Snapshot v{snapshot.snapshot_version}</span><span>{new Date(snapshot.generated_at).toLocaleString()}</span><span>Source state {String(snapshot.source_state_hash).slice(0,12)}…</span></div></header>
    <section className={styles.metrics}><div><span>Annual revenue</span><b>{money(m.annual_revenue)}</b></div><div><span>Modeled burden</span><b>{money(econ.outputs?.totalModeledBurden??econ.totalModeledBurden)}</b></div><div><span>Top risks</span><b>{risks.length}</b></div><div><span>Pending decisions</span><b>{decisions.length}</b></div></section>
    <section><h2>Top contractual risks</h2>{risks.length?risks.map((r:any,i:number)=><article className={styles.risk} key={r.id||i}><div><span className={styles.number}>0{i+1}</span><div><h3>{r.issue}</h3><p>{r.operational_consequence||r.rationale}</p><small>{r.source_locator}</small></div></div><strong>{r.risk_level}</strong></article>):<p>No human-validated risk findings were present when this snapshot was generated.</p>}</section>
    <section className={styles.two}><div><h2>Key dependencies</h2>{deps.length?<ul>{deps.map((d:any,i:number)=><li key={i}><b>{d.dependency_type}</b> — {d.rationale}</li>)}</ul>:<p>No validated dependency edges.</p>}</div><div><h2>Negotiation actions</h2>{actions.length?<ul>{actions.map((a:any,i:number)=><li key={i}><b>{a.issue}</b>: {a.primary||"No approved standard"}{a.approval?` · Approval: ${a.approval}`:""}</li>)}</ul>:<p>No negotiation actions in snapshot.</p>}</div></section>
    <section><h2>Executive decisions required</h2>{decisions.length?<table><thead><tr><th>Decision</th><th>Rationale</th><th>Authority</th><th>Status</th></tr></thead><tbody>{decisions.map((d:any,i:number)=><tr key={d.id||i}><td>{d.decision_type}</td><td>{d.rationale}</td><td>{d.required_approver_role||"APPROVER"}</td><td>{d.decision_status}</td></tr>)}</tbody></table>:<p>No pending executive decisions in this snapshot.</p>}</section>
    <section><h2>Next steps</h2><ol>{next.map((n:string,i:number)=><li key={i}>{n}</li>)}</ol></section>
    <footer>Frozen ContractTwin snapshot. Source-grounded findings remain subject to the recorded human-review state. This page does not modify source agreements or authorize contractual commitments.</footer>
  </main>;
}
