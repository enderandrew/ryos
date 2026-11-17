import { useCallback, useRef, useState } from "react";
import { AppProps } from "@/apps/base/types";
import { AppWindowShell } from "@/components/shared/AppWindowShell";
import { AppHelpAboutDialogs } from "@/components/shared/AppHelpAboutDialogs";
import { OfflineEmptyState } from "@/components/shared/OfflineEmptyState";
import { useOffline } from "@/hooks/useOffline";
import { useThemeFlags } from "@/hooks/useThemeFlags";
import { useTranslatedHelpItems } from "@/hooks/useTranslatedHelpItems";
import { getTranslatedAppName } from "@/utils/i18n";
import { appMetadata, helpItems } from "..";
import { OregonTrailMenuBar } from "./OregonTrailMenuBar";

/**
 * Where the game lives. Two options:
 *
 *  - An absolute URL on another host, as below. The game keeps its own
 *    localStorage (saves live under that origin), and that host must not send
 *    X-Frame-Options: DENY / SAMEORIGIN or a frame-ancestors CSP, or the frame
 *    renders blank.
 *  - A same-origin path such as "/games/oregon-trail/", by copying the game's
 *    files into ryOS's public/ folder. Nothing to configure, works offline
 *    through the service worker, and the frame can never be refused.
 */
const GAME_URL = "https://enderandrew.com/oregon-trail/";

export function OregonTrailAppComponent({
  isWindowOpen,
  onClose,
  isForeground,
  skipInitialSound,
  instanceId,
  onNavigateNext,
  onNavigatePrevious,
}: AppProps) {
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState(false);
  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false);
  // Bumping this key remounts the iframe, which restarts the game.
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { isWindowsTheme, isMacOSTheme } = useThemeFlags();
  const isOffline = useOffline();
  const translatedHelpItems = useTranslatedHelpItems(
    "oregon-trail",
    helpItems
  );

  const handleNewTrip = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  const menuBar = (
    <OregonTrailMenuBar
      onClose={onClose}
      onShowHelp={() => setIsHelpDialogOpen(true)}
      onShowAbout={() => setIsAboutDialogOpen(true)}
      onNewTrip={handleNewTrip}
    />
  );

  // A cross-origin game cannot be reached while offline, and the service
  // worker has nothing cached for it, so say so rather than showing a blank
  // white frame.
  const isRemote = /^https?:\/\//i.test(GAME_URL);

  return (
    <AppWindowShell
      isWindowOpen={isWindowOpen}
      isWindowsTheme={isWindowsTheme}
      isForeground={isForeground}
      menuBar={menuBar}
      trailing={
        <AppHelpAboutDialogs
          appId="oregon-trail"
          metadata={appMetadata}
          helpItems={translatedHelpItems}
          isHelpOpen={isHelpDialogOpen}
          onHelpOpenChange={setIsHelpDialogOpen}
          isAboutOpen={isAboutDialogOpen}
          onAboutOpenChange={setIsAboutDialogOpen}
        />
      }
      windowFrameProps={{
        title: getTranslatedAppName("oregon-trail"),
        onClose,
        isForeground,
        appId: "oregon-trail",
        material: isMacOSTheme ? "brushedmetal" : "default",
        skipInitialSound,
        instanceId,
        onNavigateNext,
        onNavigatePrevious,
      }}
    >
      <div className="flex flex-col flex-1 min-h-0 w-full bg-black relative">
        {isRemote && isOffline ? (
          <OfflineEmptyState
            appName={getTranslatedAppName("oregon-trail")}
            appearance="dark"
          />
        ) : (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={GAME_URL}
            title={appMetadata.name}
            // allow-same-origin keeps the game's own localStorage saves
            // working; it does NOT give it access to ryOS's origin.
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"
            allow="fullscreen; autoplay; gamepad"
            className="absolute inset-0 w-full h-full border-0 block"
          />
        )}
      </div>
    </AppWindowShell>
  );
}
