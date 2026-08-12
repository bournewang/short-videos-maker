import type { Metadata } from "next";
import DigitalHumanApp from "./DigitalHumanApp";

export const metadata: Metadata = {
  title: "Digital Human — Shortform Studio",
  description: "Create and manage digital human videos with AI-powered lip-sync.",
};

export default function DigitalHumanPage() {
  return <DigitalHumanApp />;
}