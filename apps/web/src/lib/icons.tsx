// App icon set: Material Symbols Rounded at weight 700 (Apache 2.0), from Google's SVGs.
// Exports keep the Phosphor names and `weight` prop the app already uses, so call sites
// only import from here. Material Symbols are filled outlines, not strokes, so `weight`
// picks a glyph: "fill" uses the filled variant and "thin"/"light" use a weight 300 glyph
// where one is imported. Every other weight renders the 700 glyph.
import type { ComponentProps, ReactElement } from "react";
import archiveSvg from "@material-symbols/svg-700/rounded/archive.svg?raw";
import arrowCircleUpSvg from "@material-symbols/svg-700/rounded/arrow_circle_up.svg?raw";
import rotateRightSvg from "@material-symbols/svg-700/rounded/rotate_right.svg?raw";
import rotateLeftSvg from "@material-symbols/svg-700/rounded/rotate_left.svg?raw";
import arrowDownwardSvg from "@material-symbols/svg-700/rounded/arrow_downward.svg?raw";
import arrowBackSvg from "@material-symbols/svg-700/rounded/arrow_back.svg?raw";
import arrowForwardSvg from "@material-symbols/svg-700/rounded/arrow_forward.svg?raw";
import openInNewSvg from "@material-symbols/svg-700/rounded/open_in_new.svg?raw";
import undoSvg from "@material-symbols/svg-700/rounded/undo.svg?raw";
import arrowUpwardSvg from "@material-symbols/svg-700/rounded/arrow_upward.svg?raw";
import refreshSvg from "@material-symbols/svg-700/rounded/refresh.svg?raw";
import swapVertSvg from "@material-symbols/svg-700/rounded/swap_vert.svg?raw";
import closeFullscreenSvg from "@material-symbols/svg-700/rounded/close_fullscreen.svg?raw";
import openInFullSvg from "@material-symbols/svg-700/rounded/open_in_full.svg?raw";
import batteryFullSvg from "@material-symbols/svg-700/rounded/battery_full.svg?raw";
import selectSvg from "@material-symbols/svg-700/rounded/select.svg?raw";
import filterNoneSvg from "@material-symbols/svg-700/rounded/filter_none.svg?raw";
import dataObjectSvg from "@material-symbols/svg-700/rounded/data_object.svg?raw";
import sensorsSvg from "@material-symbols/svg-700/rounded/sensors.svg?raw";
import photoCameraSvg from "@material-symbols/svg-700/rounded/photo_camera.svg?raw";
import keyboardArrowDownSvg from "@material-symbols/svg-700/rounded/keyboard_arrow_down.svg?raw";
import chevronLeftSvg from "@material-symbols/svg-700/rounded/chevron_left.svg?raw";
import chevronRightSvg from "@material-symbols/svg-700/rounded/chevron_right.svg?raw";
import unfoldMoreSvg from "@material-symbols/svg-700/rounded/unfold_more.svg?raw";
import keyboardArrowUpSvg from "@material-symbols/svg-700/rounded/keyboard_arrow_up.svg?raw";
import chatBubbleSvg from "@material-symbols/svg-700/rounded/chat_bubble.svg?raw";
import chatSvg from "@material-symbols/svg-700/rounded/chat.svg?raw";
import checkCircleSvg from "@material-symbols/svg-700/rounded/check_circle.svg?raw";
import checkSvg from "@material-symbols/svg-700/rounded/check.svg?raw";
import progressActivitySvg from "@material-symbols/svg-700/rounded/progress_activity.svg?raw";
import historySvg from "@material-symbols/svg-700/rounded/history.svg?raw";
import codeSvg from "@material-symbols/svg-700/rounded/code.svg?raw";
import contentCopySvg from "@material-symbols/svg-700/rounded/content_copy.svg?raw";
import memorySvg from "@material-symbols/svg-700/rounded/memory.svg?raw";
import myLocationSvg from "@material-symbols/svg-700/rounded/my_location.svg?raw";
import descriptionSvg from "@material-symbols/svg-700/rounded/description.svg?raw";
import printSvg from "@material-symbols/svg-700/rounded/print.svg?raw";
import widgetsSvg from "@material-symbols/svg-700/rounded/widgets.svg?raw";
import deployedCodeSvg from "@material-symbols/svg-700/rounded/deployed_code.svg?raw";
import deployedCodeLightSvg from "@material-symbols/svg-300/rounded/deployed_code.svg?raw";
import adsClickSvg from "@material-symbols/svg-700/rounded/ads_click.svg?raw";
import arrowSelectorToolSvg from "@material-symbols/svg-700/rounded/arrow_selector_tool.svg?raw";
import arrowSelectorToolFillSvg from "@material-symbols/svg-700/rounded/arrow_selector_tool-fill.svg?raw";
import databaseSvg from "@material-symbols/svg-700/rounded/database.svg?raw";
import moreHorizSvg from "@material-symbols/svg-700/rounded/more_horiz.svg?raw";
import moreVertSvg from "@material-symbols/svg-700/rounded/more_vert.svg?raw";
import downloadSvg from "@material-symbols/svg-700/rounded/download.svg?raw";
import visibilitySvg from "@material-symbols/svg-700/rounded/visibility.svg?raw";
import visibilityOffSvg from "@material-symbols/svg-700/rounded/visibility_off.svg?raw";
import colorizeSvg from "@material-symbols/svg-700/rounded/colorize.svg?raw";
import codeBlocksSvg from "@material-symbols/svg-700/rounded/code_blocks.svg?raw";
import draftSvg from "@material-symbols/svg-700/rounded/draft.svg?raw";
import fileCopySvg from "@material-symbols/svg-700/rounded/file_copy.svg?raw";
import scienceSvg from "@material-symbols/svg-700/rounded/science.svg?raw";
import folderSvg from "@material-symbols/svg-700/rounded/folder.svg?raw";
import folderOpenSvg from "@material-symbols/svg-700/rounded/folder_open.svg?raw";
import createNewFolderSvg from "@material-symbols/svg-700/rounded/create_new_folder.svg?raw";
import cropFreeSvg from "@material-symbols/svg-700/rounded/crop_free.svg?raw";
import speedSvg from "@material-symbols/svg-700/rounded/speed.svg?raw";
import settingsSvg from "@material-symbols/svg-700/rounded/settings.svg?raw";
import languageSvg from "@material-symbols/svg-700/rounded/language.svg?raw";
import hardwareSvg from "@material-symbols/svg-700/rounded/hardware.svg?raw";
import dnsSvg from "@material-symbols/svg-700/rounded/dns.svg?raw";
import inkHighlighterSvg from "@material-symbols/svg-700/rounded/ink_highlighter.svg?raw";
import homeSvg from "@material-symbols/svg-700/rounded/home.svg?raw";
import infoSvg from "@material-symbols/svg-700/rounded/info.svg?raw";
import polylineSvg from "@material-symbols/svg-700/rounded/polyline.svg?raw";
import keySvg from "@material-symbols/svg-700/rounded/key.svg?raw";
import keyboardSvg from "@material-symbols/svg-700/rounded/keyboard.svg?raw";
import laptopWindowsSvg from "@material-symbols/svg-700/rounded/laptop_windows.svg?raw";
import boltSvg from "@material-symbols/svg-700/rounded/bolt.svg?raw";
import boltFillSvg from "@material-symbols/svg-700/rounded/bolt-fill.svg?raw";
import linkOffSvg from "@material-symbols/svg-700/rounded/link_off.svg?raw";
import linkSvg from "@material-symbols/svg-700/rounded/link.svg?raw";
import checklistSvg from "@material-symbols/svg-700/rounded/checklist.svg?raw";
import lockSvg from "@material-symbols/svg-700/rounded/lock.svg?raw";
import lockOpenSvg from "@material-symbols/svg-700/rounded/lock_open.svg?raw";
import searchSvg from "@material-symbols/svg-700/rounded/search.svg?raw";
import sdCardSvg from "@material-symbols/svg-700/rounded/sd_card.svg?raw";
import removeSvg from "@material-symbols/svg-700/rounded/remove.svg?raw";
import monitorSvg from "@material-symbols/svg-700/rounded/monitor.svg?raw";
import editSquareSvg from "@material-symbols/svg-700/rounded/edit_square.svg?raw";
import package2Svg from "@material-symbols/svg-700/rounded/package_2.svg?raw";
import brushSvg from "@material-symbols/svg-700/rounded/brush.svg?raw";
import paletteSvg from "@material-symbols/svg-700/rounded/palette.svg?raw";
import attachFileSvg from "@material-symbols/svg-700/rounded/attach_file.svg?raw";
import inkPenSvg from "@material-symbols/svg-700/rounded/ink_pen.svg?raw";
import editSvg from "@material-symbols/svg-700/rounded/edit.svg?raw";
import pictureInPictureSvg from "@material-symbols/svg-700/rounded/picture_in_picture.svg?raw";
import playArrowSvg from "@material-symbols/svg-700/rounded/play_arrow.svg?raw";
import playArrowFillSvg from "@material-symbols/svg-700/rounded/play_arrow-fill.svg?raw";
import addSvg from "@material-symbols/svg-700/rounded/add.svg?raw";
import vitalSignsSvg from "@material-symbols/svg-700/rounded/vital_signs.svg?raw";
import smartToySvg from "@material-symbols/svg-700/rounded/smart_toy.svg?raw";
import scanSvg from "@material-symbols/svg-700/rounded/scan.svg?raw";
import categorySvg from "@material-symbols/svg-700/rounded/category.svg?raw";
import dockToRightSvg from "@material-symbols/svg-700/rounded/dock_to_right.svg?raw";
import tuneSvg from "@material-symbols/svg-700/rounded/tune.svg?raw";
import starShineSvg from "@material-symbols/svg-700/rounded/star_shine.svg?raw";
import contrastSquareSvg from "@material-symbols/svg-700/rounded/contrast_square.svg?raw";
import volumeUpSvg from "@material-symbols/svg-700/rounded/volume_up.svg?raw";
import volumeOffSvg from "@material-symbols/svg-700/rounded/volume_off.svg?raw";
import stacksSvg from "@material-symbols/svg-700/rounded/stacks.svg?raw";
import starSvg from "@material-symbols/svg-700/rounded/star.svg?raw";
import starFillSvg from "@material-symbols/svg-700/rounded/star-fill.svg?raw";
import terminalSvg from "@material-symbols/svg-700/rounded/terminal.svg?raw";
import deleteSvg from "@material-symbols/svg-700/rounded/delete.svg?raw";
import lanSvg from "@material-symbols/svg-700/rounded/lan.svg?raw";
import accountCircleSvg from "@material-symbols/svg-700/rounded/account_circle.svg?raw";
import errorSvg from "@material-symbols/svg-700/rounded/error.svg?raw";
import warningSvg from "@material-symbols/svg-700/rounded/warning.svg?raw";
import wifiOffSvg from "@material-symbols/svg-700/rounded/wifi_off.svg?raw";
import buildSvg from "@material-symbols/svg-700/rounded/build.svg?raw";
import cancelSvg from "@material-symbols/svg-700/rounded/cancel.svg?raw";
import closeSvg from "@material-symbols/svg-700/rounded/close.svg?raw";
import frameInspectSvg from "@material-symbols/svg-700/rounded/frame_inspect.svg?raw";
import radioButtonCheckedSvg from "@material-symbols/svg-700/rounded/radio_button_checked.svg?raw";
import blockSvg from "@material-symbols/svg-700/rounded/block.svg?raw";
import reportSvg from "@material-symbols/svg-700/rounded/report.svg?raw";
import helpSvg from "@material-symbols/svg-700/rounded/help.svg?raw";
import circleSvg from "@material-symbols/svg-700/rounded/circle.svg?raw";
import accountTreeSvg from "@material-symbols/svg-700/rounded/account_tree.svg?raw";
import formatQuoteSvg from "@material-symbols/svg-700/rounded/format_quote.svg?raw";
import thumbDownSvg from "@material-symbols/svg-700/rounded/thumb_down.svg?raw";
import thumbDownFillSvg from "@material-symbols/svg-700/rounded/thumb_down-fill.svg?raw";
import thumbUpSvg from "@material-symbols/svg-700/rounded/thumb_up.svg?raw";
import thumbUpFillSvg from "@material-symbols/svg-700/rounded/thumb_up-fill.svg?raw";
import keyboardReturnSvg from "@material-symbols/svg-700/rounded/keyboard_return.svg?raw";
import stopSvg from "@material-symbols/svg-700/rounded/stop.svg?raw";

export type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
export type IconProps = Omit<ComponentProps<"svg">, "ref"> & {
  size?: number | string;
  weight?: IconWeight;
};
export type Icon = (props: IconProps) => ReactElement;

// Every Material Symbols SVG is one path on this grid.
const VIEW_BOX = "0 -960 960 960";

function pathData(svg: string): string {
  const d = /<path d="([^"]+)"\/>/.exec(svg)?.[1];
  if (d === undefined) throw new Error("Material Symbols SVG has no single path");
  return d;
}

// Builds an app icon from raw Material Symbols SVGs: the weight 700 glyph plus optional
// filled and weight 300 variants.
function materialIcon(regular: string, variants: { fill?: string; light?: string } = {}): Icon {
  const paths = {
    regular: pathData(regular),
    fill: variants.fill === undefined ? undefined : pathData(variants.fill),
    light: variants.light === undefined ? undefined : pathData(variants.light),
  };
  return function AppIcon({ weight = "regular", size = "1em", ...props }: IconProps) {
    const d =
      (weight === "fill" ? paths.fill : undefined) ??
      (weight === "thin" || weight === "light" ? paths.light : undefined) ??
      paths.regular;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={VIEW_BOX}
        width={size}
        height={size}
        fill="currentColor"
        {...props}
      >
        <path d={d} />
      </svg>
    );
  };
}

export const ArchiveIcon = materialIcon(archiveSvg);
export const ArrowCircleUpIcon = materialIcon(arrowCircleUpSvg);
export const ArrowClockwiseIcon = materialIcon(rotateRightSvg);
export const ArrowCounterClockwiseIcon = materialIcon(rotateLeftSvg);
export const ArrowDownIcon = materialIcon(arrowDownwardSvg);
export const ArrowLeftIcon = materialIcon(arrowBackSvg);
export const ArrowRightIcon = materialIcon(arrowForwardSvg);
export const ArrowSquareOutIcon = materialIcon(openInNewSvg);
export const ArrowUUpLeftIcon = materialIcon(undoSvg);
export const ArrowUpIcon = materialIcon(arrowUpwardSvg);
export const ArrowsClockwiseIcon = materialIcon(refreshSvg);
export const ArrowsDownUpIcon = materialIcon(swapVertSvg);
export const ArrowsInSimpleIcon = materialIcon(closeFullscreenSvg);
export const ArrowsOutSimpleIcon = materialIcon(openInFullSvg);
export const BatteryFullIcon = materialIcon(batteryFullSvg);
export const BoundingBoxIcon = materialIcon(selectSvg);
export const BoxMultipleIcon = materialIcon(filterNoneSvg);
export const BracketsCurlyIcon = materialIcon(dataObjectSvg);
export const BroadcastIcon = materialIcon(sensorsSvg);
export const CameraIcon = materialIcon(photoCameraSvg);
export const CaretDownIcon = materialIcon(keyboardArrowDownSvg);
export const CaretLeftIcon = materialIcon(chevronLeftSvg);
export const CaretRightIcon = materialIcon(chevronRightSvg);
export const CaretUpDownIcon = materialIcon(unfoldMoreSvg);
export const CaretUpIcon = materialIcon(keyboardArrowUpSvg);
export const ChatCircleIcon = materialIcon(chatBubbleSvg);
export const ChatIcon = materialIcon(chatSvg);
export const CheckCircleIcon = materialIcon(checkCircleSvg);
export const CheckIcon = materialIcon(checkSvg);
export const CircleNotchIcon = materialIcon(progressActivitySvg);
export const ClockCounterClockwiseIcon = materialIcon(historySvg);
export const CodeIcon = materialIcon(codeSvg);
export const CopyIcon = materialIcon(contentCopySvg);
export const CpuIcon = materialIcon(memorySvg);
export const CrosshairIcon = materialIcon(myLocationSvg);
export const PartDrawingIcon = materialIcon(descriptionSvg);
export const PrinterIcon = materialIcon(printSvg);
export const ComponentsIcon = materialIcon(widgetsSvg);
export const CubeIcon = materialIcon(deployedCodeSvg, { light: deployedCodeLightSvg });
export const CursorClickIcon = materialIcon(adsClickSvg);
export const CursorIcon = materialIcon(arrowSelectorToolSvg, { fill: arrowSelectorToolFillSvg });
export const DatabaseIcon = materialIcon(databaseSvg);
export const DotsThreeIcon = materialIcon(moreHorizSvg);
export const DotsThreeVerticalIcon = materialIcon(moreVertSvg);
export const DownloadIcon = materialIcon(downloadSvg);
export const EyeIcon = materialIcon(visibilitySvg);
export const EyeSlashIcon = materialIcon(visibilityOffSvg);
export const EyedropperIcon = materialIcon(colorizeSvg);
export const FileCodeIcon = materialIcon(codeBlocksSvg);
export const FileIcon = materialIcon(draftSvg);
export const FilesIcon = materialIcon(fileCopySvg);
export const FlaskIcon = materialIcon(scienceSvg);
export const FolderIcon = materialIcon(folderSvg);
export const FolderOpenIcon = materialIcon(folderOpenSvg);
export const FolderPlusIcon = materialIcon(createNewFolderSvg);
export const FrameCornersIcon = materialIcon(cropFreeSvg);
export const GaugeIcon = materialIcon(speedSvg);
export const GearSixIcon = materialIcon(settingsSvg);
export const GlobeIcon = materialIcon(languageSvg);
export const HammerIcon = materialIcon(hardwareSvg);
export const HardDriveIcon = materialIcon(dnsSvg);
export const HighlighterIcon = materialIcon(inkHighlighterSvg);
export const HouseIcon = materialIcon(homeSvg);
export const InfoIcon = materialIcon(infoSvg);
export const IntersectIcon = materialIcon(polylineSvg);
export const KeyIcon = materialIcon(keySvg);
export const KeyboardIcon = materialIcon(keyboardSvg);
export const LaptopIcon = materialIcon(laptopWindowsSvg);
export const LightningIcon = materialIcon(boltSvg, { fill: boltFillSvg });
export const LinkBreakIcon = materialIcon(linkOffSvg);
export const LinkIcon = materialIcon(linkSvg);
export const ListChecksIcon = materialIcon(checklistSvg);
export const LockSimpleIcon = materialIcon(lockSvg);
export const LockSimpleOpenIcon = materialIcon(lockOpenSvg);
export const MagnifyingGlassIcon = materialIcon(searchSvg);
export const MemoryIcon = materialIcon(sdCardSvg);
export const MinusIcon = materialIcon(removeSvg);
export const MonitorIcon = materialIcon(monitorSvg);
export const NotePencilIcon = materialIcon(editSquareSvg);
export const PackageIcon = materialIcon(package2Svg);
export const PaintBrushIcon = materialIcon(brushSvg);
export const PaletteIcon = materialIcon(paletteSvg);
export const PaperclipIcon = materialIcon(attachFileSvg);
export const PenIcon = materialIcon(inkPenSvg);
export const PencilSimpleIcon = materialIcon(editSvg);
export const PictureInPictureIcon = materialIcon(pictureInPictureSvg);
export const PlayIcon = materialIcon(playArrowSvg, { fill: playArrowFillSvg });
export const PlusIcon = materialIcon(addSvg);
export const PulseIcon = materialIcon(vitalSignsSvg);
export const RobotIcon = materialIcon(smartToySvg);
export const ScanIcon = materialIcon(scanSvg);
export const ShapesIcon = materialIcon(categorySvg);
export const SidebarIcon = materialIcon(dockToRightSvg);
export const SidebarSimpleIcon = materialIcon(dockToRightSvg);
export const SlidersHorizontalIcon = materialIcon(tuneSvg);
export const SparkleIcon = materialIcon(starShineSvg);
export const SquareHalfIcon = materialIcon(contrastSquareSvg);
export const SpeakerHighIcon = materialIcon(volumeUpSvg);
export const SpeakerSlashIcon = materialIcon(volumeOffSvg);
export const SpinnerIcon = materialIcon(progressActivitySvg);
export const StackIcon = materialIcon(stacksSvg);
export const StarIcon = materialIcon(starSvg, { fill: starFillSvg });
export const TerminalWindowIcon = materialIcon(terminalSvg);
export const TrashIcon = materialIcon(deleteSvg);
export const TreeStructureIcon = materialIcon(lanSvg);
export const UserCircleIcon = materialIcon(accountCircleSvg);
export const WarningCircleIcon = materialIcon(errorSvg);
export const WarningIcon = materialIcon(warningSvg);
export const WifiSlashIcon = materialIcon(wifiOffSvg);
export const WrenchIcon = materialIcon(buildSvg);
export const XCircleIcon = materialIcon(cancelSvg);
export const XIcon = materialIcon(closeSvg);
export const ZoomScanIcon = materialIcon(frameInspectSvg);
export const RecordIcon = materialIcon(radioButtonCheckedSvg);
export const ProhibitIcon = materialIcon(blockSvg);
export const WarningOctagonIcon = materialIcon(reportSvg);
export const QuestionIcon = materialIcon(helpSvg);
export const DotOutlineIcon = materialIcon(circleSvg);
export const ListTreeIcon = materialIcon(accountTreeSvg);
export const QuotesIcon = materialIcon(formatQuoteSvg);
export const ThumbsDownIcon = materialIcon(thumbDownSvg, { fill: thumbDownFillSvg });
export const ThumbsUpIcon = materialIcon(thumbUpSvg, { fill: thumbUpFillSvg });
export const ArrowElbowDownLeftIcon = materialIcon(keyboardReturnSvg);
export const StopIcon = materialIcon(stopSvg);
