// App icon set: Tabler icons (MIT).
// Exports keep the Phosphor names and `weight` prop the app already uses, so call sites
// only import from here. `weight` maps to Tabler's stroke width, and "fill" switches to
// Tabler's filled variant where one exists.
import type { ComponentProps, ReactElement } from "react";
import {
  IconActivity,
  IconAdjustmentsHorizontal,
  IconAlertCircle,
  IconAlertOctagon,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconArrowsSort,
  IconBallpen,
  IconBan,
  IconBattery4,
  IconBolt,
  IconBoltFilled,
  IconBlockquote,
  IconBoxMultiple,
  IconBraces,
  IconBroadcast,
  IconBrush,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconFileDescription,
  IconPrinter,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleArrowUp,
  IconCircleCheck,
  IconCircleDot,
  IconCircleX,
  IconClick,
  IconCode,
  IconColorPicker,
  IconComponents,
  IconCopy,
  IconCornerDownLeft,
  IconCpu,
  IconCrosshair,
  IconCube,
  IconDatabase,
  IconDeviceDesktop,
  IconDeviceLaptop,
  IconDeviceSdCard,
  IconDots,
  IconDotsVertical,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFileCode,
  IconFiles,
  IconFlask,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconFrame,
  IconGauge,
  IconHammer,
  IconHelpCircle,
  IconHighlight,
  IconHistory,
  IconHome,
  IconInfoCircle,
  IconKey,
  IconKeyboard,
  IconLayoutSidebar,
  IconLink,
  IconListCheck,
  IconListTree,
  IconLoader2,
  IconLock,
  IconLockOpen,
  IconMarquee2,
  IconMessage,
  IconMessageCircle,
  IconMinus,
  IconPackage,
  IconPalette,
  IconPaperclip,
  IconPencil,
  IconPictureInPicture,
  IconPlayerPlay,
  IconPlayerPlayFilled,
  IconPlus,
  IconPoint,
  IconPointer,
  IconRefresh,
  IconRobot,
  IconRotate,
  IconRotateClockwise,
  IconScan,
  IconSearch,
  IconSelector,
  IconServer,
  IconSettings,
  IconShape,
  IconSitemap,
  IconSparkles,
  IconSquareHalf,
  IconStack2,
  IconStar,
  IconStarFilled,
  IconTerminal2,
  IconThumbDown,
  IconThumbDownFilled,
  IconThumbUp,
  IconThumbUpFilled,
  IconTool,
  IconTrash,
  IconUnlink,
  IconUserCircle,
  IconVectorTriangle,
  IconVolume,
  IconVolumeOff,
  IconWifiOff,
  IconWorld,
  IconX,
  IconZoomScan,
  createReactComponent,
  type Icon as TablerIcon,
} from "@tabler/icons-react";

export type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
export type IconProps = Omit<ComponentProps<"svg">, "ref" | "stroke"> & {
  size?: number | string;
  weight?: IconWeight;
};
export type Icon = (props: IconProps) => ReactElement;

// Tabler's default stroke (2) is the regular weight.
const STROKE_BY_WEIGHT: Record<IconWeight, number> = {
  thin: 1.25,
  light: 1.5,
  regular: 2,
  bold: 2.5,
  fill: 2,
  duotone: 2,
};

function tablerIcon(Outline: TablerIcon, Filled?: TablerIcon): Icon {
  return function AppIcon({ weight = "regular", size = "1em", ...props }: IconProps) {
    const Component = weight === "fill" && Filled ? Filled : Outline;
    return <Component size={size} stroke={STROKE_BY_WEIGHT[weight]} {...props} />;
  };
}

export const ArchiveIcon = tablerIcon(IconArchive);
export const ArrowCircleUpIcon = tablerIcon(IconCircleArrowUp);
export const ArrowClockwiseIcon = tablerIcon(IconRotateClockwise);
export const ArrowCounterClockwiseIcon = tablerIcon(IconRotate);
export const ArrowDownIcon = tablerIcon(IconArrowDown);
export const ArrowLeftIcon = tablerIcon(IconArrowLeft);
export const ArrowRightIcon = tablerIcon(IconArrowRight);
export const ArrowSquareOutIcon = tablerIcon(IconExternalLink);
export const ArrowUUpLeftIcon = tablerIcon(IconArrowBackUp);
export const ArrowUpIcon = tablerIcon(IconArrowUp);
export const ArrowsClockwiseIcon = tablerIcon(IconRefresh);
export const ArrowsDownUpIcon = tablerIcon(IconArrowsSort);
export const ArrowsInSimpleIcon = tablerIcon(IconArrowsDiagonalMinimize2);
export const ArrowsOutSimpleIcon = tablerIcon(IconArrowsDiagonal);
export const BatteryFullIcon = tablerIcon(IconBattery4);
export const BoundingBoxIcon = tablerIcon(IconMarquee2);
export const BoxMultipleIcon = tablerIcon(IconBoxMultiple);
export const BracketsCurlyIcon = tablerIcon(IconBraces);
export const BroadcastIcon = tablerIcon(IconBroadcast);
export const CameraIcon = tablerIcon(IconCamera);
export const CaretDownIcon = tablerIcon(IconChevronDown);
export const CaretLeftIcon = tablerIcon(IconChevronLeft);
export const CaretRightIcon = tablerIcon(IconChevronRight);
export const CaretUpDownIcon = tablerIcon(IconSelector);
export const CaretUpIcon = tablerIcon(IconChevronUp);
export const ChatCircleIcon = tablerIcon(IconMessageCircle);
export const ChatIcon = tablerIcon(IconMessage);
export const CheckCircleIcon = tablerIcon(IconCircleCheck);
export const CheckIcon = tablerIcon(IconCheck);
export const CircleNotchIcon = tablerIcon(IconLoader2);
export const ClockCounterClockwiseIcon = tablerIcon(IconHistory);
export const CodeIcon = tablerIcon(IconCode);
export const CopyIcon = tablerIcon(IconCopy);
export const CpuIcon = tablerIcon(IconCpu);
export const CrosshairIcon = tablerIcon(IconCrosshair);
export const PartDrawingIcon = tablerIcon(IconFileDescription);
export const PrinterIcon = tablerIcon(IconPrinter);
export const ComponentsIcon = tablerIcon(IconComponents);
export const CubeIcon = tablerIcon(IconCube);
export const CursorClickIcon = tablerIcon(IconClick);
export const CursorIcon = tablerIcon(IconPointer);
export const DatabaseIcon = tablerIcon(IconDatabase);
export const DotsThreeIcon = tablerIcon(IconDots);
export const DotsThreeVerticalIcon = tablerIcon(IconDotsVertical);
export const DownloadIcon = tablerIcon(IconDownload);
export const EyeIcon = tablerIcon(IconEye);
export const EyeSlashIcon = tablerIcon(IconEyeOff);
export const EyedropperIcon = tablerIcon(IconColorPicker);
export const FileCodeIcon = tablerIcon(IconFileCode);
export const FileIcon = tablerIcon(IconFile);
export const FilesIcon = tablerIcon(IconFiles);
export const FlaskIcon = tablerIcon(IconFlask);
export const FolderIcon = tablerIcon(IconFolder);
export const FolderOpenIcon = tablerIcon(IconFolderOpen);
export const FolderPlusIcon = tablerIcon(IconFolderPlus);
export const FrameCornersIcon = tablerIcon(IconFrame);
export const GaugeIcon = tablerIcon(IconGauge);
export const GearSixIcon = tablerIcon(IconSettings);
export const GlobeIcon = tablerIcon(IconWorld);
export const HammerIcon = tablerIcon(IconHammer);
export const HardDriveIcon = tablerIcon(IconServer);
export const HighlighterIcon = tablerIcon(IconHighlight);
export const HouseIcon = tablerIcon(IconHome);
export const InfoIcon = tablerIcon(IconInfoCircle);
export const IntersectIcon = tablerIcon(IconVectorTriangle);
export const KeyIcon = tablerIcon(IconKey);
export const KeyboardIcon = tablerIcon(IconKeyboard);
export const LaptopIcon = tablerIcon(IconDeviceLaptop);
export const LightningIcon = tablerIcon(IconBolt, IconBoltFilled);
export const LinkBreakIcon = tablerIcon(IconUnlink);
export const LinkIcon = tablerIcon(IconLink);
export const ListChecksIcon = tablerIcon(IconListCheck);
export const LockSimpleIcon = tablerIcon(IconLock);
export const LockSimpleOpenIcon = tablerIcon(IconLockOpen);
export const MagnifyingGlassIcon = tablerIcon(IconSearch);
export const MemoryIcon = tablerIcon(IconDeviceSdCard);
export const MinusIcon = tablerIcon(IconMinus);
export const MonitorIcon = tablerIcon(IconDeviceDesktop);
export const NotePencilIcon = tablerIcon(IconEdit);
export const PackageIcon = tablerIcon(IconPackage);
export const PaintBrushIcon = tablerIcon(IconBrush);
export const PaletteIcon = tablerIcon(IconPalette);
export const PaperclipIcon = tablerIcon(IconPaperclip);
export const PenIcon = tablerIcon(IconBallpen);
export const PencilSimpleIcon = tablerIcon(IconPencil);
export const PictureInPictureIcon = tablerIcon(IconPictureInPicture);
export const PlayIcon = tablerIcon(IconPlayerPlay, IconPlayerPlayFilled);
export const PlusIcon = tablerIcon(IconPlus);
export const PulseIcon = tablerIcon(IconActivity);
export const RobotIcon = tablerIcon(IconRobot);
export const ScanIcon = tablerIcon(IconScan);
export const ShapesIcon = tablerIcon(IconShape);
export const SidebarIcon = tablerIcon(IconLayoutSidebar);
export const SidebarSimpleIcon = tablerIcon(IconLayoutSidebar);
export const SlidersHorizontalIcon = tablerIcon(IconAdjustmentsHorizontal);
export const SparkleIcon = tablerIcon(IconSparkles);
export const SquareHalfIcon = tablerIcon(IconSquareHalf);
export const SpeakerHighIcon = tablerIcon(IconVolume);
export const SpeakerSlashIcon = tablerIcon(IconVolumeOff);
export const SpinnerIcon = tablerIcon(IconLoader2);
export const StackIcon = tablerIcon(IconStack2);
export const StarIcon = tablerIcon(IconStar, IconStarFilled);
export const TerminalWindowIcon = tablerIcon(IconTerminal2);
export const TrashIcon = tablerIcon(IconTrash);
export const TreeStructureIcon = tablerIcon(IconSitemap);
export const UserCircleIcon = tablerIcon(IconUserCircle);
export const WarningCircleIcon = tablerIcon(IconAlertCircle);
export const WarningIcon = tablerIcon(IconAlertTriangle);
export const WifiSlashIcon = tablerIcon(IconWifiOff);
export const WrenchIcon = tablerIcon(IconTool);
export const XCircleIcon = tablerIcon(IconCircleX);
export const XIcon = tablerIcon(IconX);
export const ZoomScanIcon = tablerIcon(IconZoomScan);
export const RecordIcon = tablerIcon(IconCircleDot);
export const ProhibitIcon = tablerIcon(IconBan);
export const WarningOctagonIcon = tablerIcon(IconAlertOctagon);
export const QuestionIcon = tablerIcon(IconHelpCircle);
export const DotOutlineIcon = tablerIcon(IconPoint);
export const ListTreeIcon = tablerIcon(IconListTree);
export const QuotesIcon = tablerIcon(IconBlockquote);
export const ThumbsDownIcon = tablerIcon(IconThumbDown, IconThumbDownFilled);
export const ThumbsUpIcon = tablerIcon(IconThumbUp, IconThumbUpFilled);
export const ArrowElbowDownLeftIcon = tablerIcon(IconCornerDownLeft);
// The composer's stop glyph. Tabler's square spans 18 of 24 units. A closed square reads
// larger than the open send arrow at the same extent, so this one spans 11 units (6.5 to
// 17.5) with the same stroke width, which makes the two look the same size in the button.
export const StopIcon = tablerIcon(
  createReactComponent("outline", "stop", "Stop", [
    [
      "path",
      {
        d: "M6.5 8a1.5 1.5 0 0 1 1.5 -1.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1 -1.5 1.5h-8a1.5 1.5 0 0 1 -1.5 -1.5z",
        key: "svg-0",
      },
    ],
  ]),
);
