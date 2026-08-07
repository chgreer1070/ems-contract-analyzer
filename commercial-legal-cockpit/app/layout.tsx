import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EMS Commercial Legal Cockpit",
  description: "Executive commercial legal decision support for EMS contract portfolios.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
