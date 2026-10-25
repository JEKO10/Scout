import "./globals.css";

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Scout — Find conversations worth joining",
    template: "%s · Scout",
  },
  description:
    "An AI growth operator that finds and ranks the conversations where your perspective matters.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // next-themes (via NeonAuthUIProvider) sets the theme class/style before hydration
      suppressHydrationWarning
      // globals.css sets smooth scrolling; this lets Next turn it off during
      // route changes so navigation doesn't animate-scroll
      data-scroll-behavior="smooth"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
