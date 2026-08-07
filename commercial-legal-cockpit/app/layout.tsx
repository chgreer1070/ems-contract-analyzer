import type { Metadata } from "next";
import "./globals.css";
import "./v2-a.css";
import "./v2-b.css";

export const metadata: Metadata = {
  title: "EMS Commercial Legal Cockpit",
  description: "Source-grounded executive commercial legal decision support for EMS contract portfolios."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
