import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { AppShell } from "./components/app-shell";

export const metadata: Metadata = {
  title: "DocRelay",
  description: "Safe AI write-back for cloud documents.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-background text-ink">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
