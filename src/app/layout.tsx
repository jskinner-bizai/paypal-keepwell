import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Keepwell | Merchant recovery",
  description: "A next-best-action workspace for failed renewals and past-due invoices.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
