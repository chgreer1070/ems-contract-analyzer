import DocumentUploadPanel from "@/components/DocumentUploadPanel";
import GovernancePanel from "@/components/GovernancePanel";
import MatterAccessPanel from "@/components/MatterAccessPanel";
import SourceRecordsPanel from "@/components/SourceRecordsPanel";
import MatterWorkspace from "@/components/MatterWorkspace";

export default async function MatterPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  return <><DocumentUploadPanel matterId={id}/><GovernancePanel matterId={id}/><MatterAccessPanel matterId={id}/><SourceRecordsPanel matterId={id}/><MatterWorkspace matterId={id}/></>;
}
