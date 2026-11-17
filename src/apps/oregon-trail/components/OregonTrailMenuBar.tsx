import { AppMenuBarShell } from "@/components/shared/menubar/AppMenuBarShell";
import {
  AppMenuBarMenus,
  type MenuDescriptor,
} from "@/components/shared/menubar/AppMenuBarMenus";
import { useAppMenuBarChrome } from "@/hooks/useAppMenuBarChrome";
import { useTranslation } from "react-i18next";

interface OregonTrailMenuBarProps {
  onClose: () => void;
  onShowHelp: () => void;
  onShowAbout: () => void;
  onNewTrip: () => void;
}

export function OregonTrailMenuBar({
  onClose,
  onShowHelp,
  onShowAbout,
  onNewTrip,
}: OregonTrailMenuBarProps) {
  const { t } = useTranslation();
  const {
    isShareDialogOpen,
    setIsShareDialogOpen,
    isWindowsTheme,
    isMacOSTheme,
    appId,
    appName,
  } = useAppMenuBarChrome("oregon-trail");

  const menus: MenuDescriptor[] = [
    {
      label: t("common.menu.file"),
      items: [
        {
          type: "action",
          label: t("apps.oregon-trail.menu.newTrip"),
          onClick: onNewTrip,
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
      isWindowsTheme={isWindowsTheme}
      isMacOSTheme={isMacOSTheme}
      appId={appId}
      appName={appName}
      isShareDialogOpen={isShareDialogOpen}
      setIsShareDialogOpen={setIsShareDialogOpen}
      helpItemLabel={t("apps.oregon-trail.menu.help")}
      aboutItemLabel={t("apps.oregon-trail.menu.about")}
      onShowHelp={onShowHelp}
      onShowAbout={onShowAbout}
    >
      <AppMenuBarMenus menus={menus} />
    </AppMenuBarShell>
  );
}
