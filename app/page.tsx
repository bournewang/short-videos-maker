import type { Metadata } from "next";
import StudioApp from "./StudioApp";

export const metadata: Metadata = {
  title: "Shortform Studio",
  description: "A local-first production desk for AI-assisted short videos.",
};

export default function Home() {
  return <StudioApp />;
}
