import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppId } from "@/config/appIds";
import type { AppProps } from "@/apps/base/types";
import { AppWindowShell } from "@/components/shared/AppWindowShell";
import { AppHelpAboutDialogs } from "@/components/shared/AppHelpAboutDialogs";
import { OfflineEmptyState } from "@/components/shared/OfflineEmptyState";
import { AppMenuBarShell } from "@/components/shared/menubar/AppMenuBarShell";
import {
  AppMenuBarMenus,
  type MenuDescriptor,
} from "@/components/shared/menubar/AppMenuBarMenus";
import { useAppMenuBarChrome } from "@/hooks/useAppMenuBarChrome";
import { useOffline } from "@/hooks/useOffline";
import { useThemeFlags } from "@/hooks/useThemeFlags";
import { useTranslatedHelpItems } from "@/hooks/useTranslatedHelpItems";
import { getTranslatedAppName } from "@/utils/i18n";

/**
 * A ryOS app whose content is a web page (typically one of your own games)
 * shown in an iframe, with the standard window, menu bar, Help and About.
 *
 * `url` can be:
 *  - an absolute URL on another host. The page keeps its own localStorage,
 *    and that host must not send X-Frame-Options: DENY / SAMEORIGIN or a
 *    frame-ancestors CSP that excludes ryOS, or the frame renders blank.
 *  - a same-origin path such as "/games/oregon-trail/", by copying the files
 *    into public/. Works offline and the frame can never be refused.
 *
 * Translation keys used, all under `apps.<appId>`:
 *   name, menu.<restartMenuKey>, menu.help, menu.about
 */
export interface EmbeddedWebAppProps extends AppProps {
  appId: AppId;
  url: string;
  metadata: Parameters<typeof AppHelpAboutDialogs>[0]["metadata"];
  helpItems: NonNullable<AppProps["helpItems"]>;
  /** Menu key for File ▸ restart, e.g. "restart" or "newTrip". */
  restartMenuKey?: string;
}

/** Sandbox for embedded pages. allow-same-origin keeps the page's own saves; it does not grant ryOS's origin. */
export const EMBEDDED_WEB_APP_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock";

export function EmbeddedWebApp({
  appId,
  url,
  metadata,
  helpItems,
  restartMenuKey = "restart",
  isWindowOpen,
  onClose,
  isForeground,
  skipInitialSound,
  instanceId,
  onNavigateNext,
  onNavigatePrevious,
}: EmbeddedWebAppProps) {
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState(false);
  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false);
  // Bumping this key remounts the iframe, which restarts the page.
  const [reloadKey, setReloadKey] = useState(0);
  const { isWindowsTheme, isMacOSTheme } = useThemeFlags();
  const isOffline = useOffline();
  const translatedHelpItems = useTranslatedHelpItems(appId, helpItems);
  const appName = getTranslatedAppName(appId);

  const handleRestart = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  // A cross-origin page cannot be reached offline and the service worker has
  // nothing cached for it, so say so rather than show a blank frame.
  const isRemote = /^https?:\/\//i.test(url);

  return (
    <AppWindowShell
      isWindowOpen={isWindowOpen}
      isWindowsTheme={isWindowsTheme}
      isForeground={isForeground}
      menuBar={
        <EmbeddedWebAppMenuBar
          appId={appId}
          restartMenuKey={restartMenuKey}
          onClose={onClose}
          onRestart={handleRestart}
          onShowHelp={() => setIsHelpDialogOpen(true)}
          onShowAbout={() => setIsAboutDialogOpen(true)}
        />
      }
      trailing={
        <AppHelpAboutDialogs
          appId={appId}
          metadata={metadata}
          helpItems={translatedHelpItems}
          isHelpOpen={isHelpDialogOpen}
          onHelpOpenChange={setIsHelpDialogOpen}
          isAboutOpen={isAboutDialogOpen}
          onAboutOpenChange={setIsAboutDialogOpen}
        />
      }
      windowFrameProps={{
        title: appName,
        onClose,
        isForeground,
        appId,
        material: isMacOSTheme ? "brushedmetal" : "default",
        skipInitialSound,
        instanceId,
        onNavigateNext,
        onNavigatePrevious,
      }}
    >
      <div className="flex flex-col flex-1 min-h-0 w-full bg-black relative">
        {isRemote && isOffline ? (
          <OfflineEmptyState appName={appName} appearance="dark" />
        ) : (
          <iframe
            key={reloadKey}
            src={url}
            title={metadata.name}
            sandbox={EMBEDDED_WEB_APP_SANDBOX}
            allow="fullscreen; autoplay; gamepad"
            className="absolute inset-0 w-full h-full border-0 block"
          />
        )}
      </div>
    </AppWindowShell>
  );
}

interface EmbeddedWebAppMenuBarProps {
  appId: AppId;
  restartMenuKey: string;
  onClose: () => void;
  onRestart: () => void;
  onShowHelp: () => void;
  onShowAbout: () => void;
}

function EmbeddedWebAppMenuBar({
  appId,
  restartMenuKey,
  onClose,
  onRestart,
  onShowHelp,
  onShowAbout,
}: EmbeddedWebAppMenuBarProps) {
  const { t } = useTranslation();
  const chrome = useAppMenuBarChrome(appId);

  const menus: MenuDescriptor[] = [
    {
      label: t("common.menu.file"),
      items: [
        {
          type: "action",
          label: t(`apps.${appId}.menu.${restartMenuKey}`),
          onClick: onRestart,
        },
        { type: "separator" },
        {
          type: "action",
          label: t("common.menu.close"),
          onClick: onClose,
          shortcutId: "close",
        },
      ],
    },
  ];

  return (
    <AppMenuBarShell
      isWindowsTheme={chrome.isWindowsTheme}
      isMacOSTheme={chrome.isMacOSTheme}
      appId={chrome.appId}
      appName={chrome.appName}
      isShareDialogOpen={chrome.isShareDialogOpen}
      setIsShareDialogOpen={chrome.setIsShareDialogOpen}
      helpItemLabel={t(`apps.${appId}.menu.help`)}
      aboutItemLabel={t(`apps.${appId}.menu.about`)}
      onShowHelp={onShowHelp}
      onShowAbout={onShowAbout}
    >
      <AppMenuBarMenus menus={menus} />
    </AppMenuBarShell>
  );
}
