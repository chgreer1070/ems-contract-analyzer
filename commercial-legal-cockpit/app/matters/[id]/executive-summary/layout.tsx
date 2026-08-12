export default function ExecutiveSummaryLayout({children}:{children:React.ReactNode}){
  return <><style>{`@media print{.matter-layout-actions{display:none!important}}`}</style>{children}</>;
}
