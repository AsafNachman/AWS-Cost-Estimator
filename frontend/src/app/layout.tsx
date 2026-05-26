import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * `next/font/google` self-hosts the font at build time:
 * Next.js downloads the .woff2 files during `next build`, fingerprints them,
 * and serves them from /_next/static/media so we get the privacy and
 * performance of self-hosting without manually managing font files.
 *
 * The CSS variables exposed below are referenced from `tailwind.config.js`
 * so every Tailwind `font-sans` / `font-mono` class resolves to these fonts.
 */
const fontSans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "AWS Cost Estimator — LangGraph",
  description:
    "Upload an infrastructure diagram, get a per-resource cost breakdown and a plain-language architectural review.",
  applicationName: "AWS Cost Estimator",
  authors: [{ name: "AWS Cost Estimator" }],
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <html lang="en" className={`${fontSans.variable} ${fontMono.variable}`}>
      <body className="min-h-screen font-sans text-ink-900 antialiased">
        {children}
      </body>
    </html>
  );
}
