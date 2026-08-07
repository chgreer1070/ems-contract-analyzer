import ExecutiveSummary from "@/components/ExecutiveSummary";

export default async function ExecutiveSummaryPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{snapshot?:string}>}){
  const {id}=await params;const {snapshot}=await searchParams;
  return <ExecutiveSummary matterId={id} snapshotId={snapshot}/>;
}
