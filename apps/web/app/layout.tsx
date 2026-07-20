import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "China Sourcing",
  description: "Sourcing automatico multi-marketplace con preventivo",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
