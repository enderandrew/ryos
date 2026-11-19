import type { AppProps } from "@/apps/base/types";
import { EmbeddedWebApp } from "@/components/shared/EmbeddedWebApp";
import { appMetadata, helpItems } from "..";

/** See EmbeddedWebApp for cross-origin vs. same-origin hosting. */
const GAME_URL = "https://enderandrew.com/polybius/";

export function PolybiusAppComponent(props: AppProps) {
  return (
    <EmbeddedWebApp
      {...props}
      appId="polybius"
      url={GAME_URL}
      metadata={appMetadata}
      helpItems={helpItems}
    />
  );
}
