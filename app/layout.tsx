import "./globals.css";

import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";

import { appUrl } from "@/lib/appUrl";

import { Providers } from "./providers";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description =
  "Scout monitors conversations on X, finds opportunities relevant to your expertise, and helps you write replies that actually add value.";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl()),
  title: {
    default: "Scout — Find the right conversations on X",
    template: "%s · Scout",
  },
  description,
  applicationName: "Scout",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Scout",
    title: "Scout — Find the right conversations. Grow your audience.",
    description,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Scout — Find the right conversations. Grow your audience.",
    description,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f9fc",
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
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
