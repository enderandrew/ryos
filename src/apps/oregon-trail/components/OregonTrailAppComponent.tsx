import type { AppProps } from "@/apps/base/types";
import { EmbeddedWebApp } from "@/components/shared/EmbeddedWebApp";
import { appMetadata, helpItems } from "..";

/** See EmbeddedWebApp for cross-origin vs. same-origin hosting. */
const GAME_URL = "https://enderandrew.com/oregon-trail/";

export function OregonTrailAppComponent(props: AppProps) {
  return (
    <EmbeddedWebApp
      {...props}
      appId="oregon-trail"
      url={GAME_URL}
      metadata={appMetadata}
      helpItems={helpItems}
      restartMenuKey="newTrip"
    />
  );
}
