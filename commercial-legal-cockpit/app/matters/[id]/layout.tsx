import DecisionRequestPanel from "@/components/DecisionRequestPanel";

export default async function MatterLayout({children,params}:{children:React.ReactNode;params:Promise<{id:string}>}){
  const {id}=await params;
  return <><div className="matter-layout-actions"><DecisionRequestPanel matterId={id}/></div>{children}</>;
}
