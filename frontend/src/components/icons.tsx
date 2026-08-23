import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}><path d="m6 3.5 4 4.5-4 4.5" /></Icon>
);
export const FileIcon = (props: IconProps) => (
  <Icon {...props}><path d="M3.5 1.75h5l4 4v8.5h-9zM8.5 2v4h3.75" /></Icon>
);
export const FolderIcon = (props: IconProps) => (
  <Icon {...props}><path d="M1.75 4.25h4l1.2 1.5h7.3v7.5H1.75z" /></Icon>
);
export const PlayIcon = (props: IconProps) => (
  <Icon {...props}><path d="m5.25 3.2 7 4.8-7 4.8z" /></Icon>
);
export const PlusIcon = (props: IconProps) => (
  <Icon {...props}><path d="M8 2.5v11M2.5 8h11" /></Icon>
);
export const PromptIcon = (props: IconProps) => (
  <Icon {...props}><path d="m3 4.5 3.5 3.5L3 11.5M8.5 11.5H13" /></Icon>
);
export const BranchIcon = (props: IconProps) => (
  <Icon {...props}><circle cx="4" cy="3" r="1.5" /><circle cx="12" cy="4" r="1.5" /><circle cx="4" cy="13" r="1.5" /><path d="M4 4.5v7M5.5 8h2.2A4.3 4.3 0 0 0 12 3.7" /></Icon>
);
export const PanelIcon = (props: IconProps) => (
  <Icon {...props}><rect x="1.75" y="2" width="12.5" height="12" rx="1" /><path d="M5.5 2v12" /></Icon>
);
export const PanelRightIcon = (props: IconProps) => (
  <Icon {...props}><rect x="1.75" y="2" width="12.5" height="12" rx="1" /><path d="M10.5 2v12" /></Icon>
);
export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}><path d="M13 5V2.5l-1 1A5.5 5.5 0 1 0 13.3 9" /><path d="M13 2.5h-2.5" /></Icon>
);
export const SaveIcon = (props: IconProps) => (
  <Icon {...props}><path d="M2 2h9.5L14 4.5V14H2zM4.5 2v4h6V2.5M4.5 14V9h7v5" /></Icon>
);
export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}><path d="M8 1.5v8M5 6.5l3 3 3-3M2.5 12.5h11" /></Icon>
);
export const TrashIcon = (props: IconProps) => (
  <Icon {...props}><path d="M3.5 4.5h9M6 4.5v-2h4v2M5 6.5v6M8 6.5v6M11 6.5v6M4 4.5l.5 10h7l.5-10" /></Icon>
);
export const RenameIcon = (props: IconProps) => (
  <Icon {...props}><path d="m3 11.5-.5 2 2-.5 7.5-7.5-1.5-1.5zM9.5 5l1.5 1.5" /></Icon>
);
export const StopIcon = (props: IconProps) => (
  <Icon {...props}><rect x="4" y="4" width="8" height="8" /></Icon>
);
export const SendIcon = (props: IconProps) => (
  <Icon {...props}><path d="M8 13V3.5M4.75 6.75 8 3.5l3.25 3.25" /></Icon>
);
export const UploadIcon = (props: IconProps) => (
  <Icon {...props}><path d="M8 14V4M5 7l3-3 3 3M2.5 2h11" /></Icon>
);
export const NewFolderIcon = (props: IconProps) => (
  <Icon {...props}><path d="M1.75 4.25h4l1.2 1.5h7.3v7.5H1.75zM10.5 8v3M9 9.5h3" /></Icon>
);
export const CloseIcon = (props: IconProps) => (
  <Icon {...props}><path d="m4 4 8 8M12 4l-8 8" /></Icon>
);
export const HistoryIcon = (props: IconProps) => (
  <Icon {...props}><path d="M2.25 4.5V1.75M2.25 4.5H5M2.25 4.5A6 6 0 1 1 2 10" /><path d="M8 4.5V8l2.5 1.5" /></Icon>
);
export const SearchIcon = (props: IconProps) => (
  <Icon {...props}><circle cx="6.75" cy="6.75" r="4.5" /><path d="m10.25 10.25 3.5 3.5" /></Icon>
);
export const HeightIcon = (props: IconProps) => (
  <Icon {...props}><path d="M3 3h10M3 13h10M8 5v6M6.25 6.5 8 4.75 9.75 6.5M6.25 9.5 8 11.25 9.75 9.5" /></Icon>
);
export const CodeIcon = (props: IconProps) => (
  <Icon {...props}><path d="m5.5 3.5-4 4.5 4 4.5M10.5 3.5l4 4.5-4 4.5M9 2.5l-2 11" /></Icon>
);
export const OutputIcon = (props: IconProps) => (
  <Icon {...props}><rect x="2" y="2.5" width="12" height="11" rx="1" /><path d="M4.5 6h7M4.5 9h4.5" /></Icon>
);
export const LockIcon = (props: IconProps) => (
  <Icon {...props}><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2M8 10v1.5" /></Icon>
);
export const NotebookIcon = (props: IconProps) => (
  <Icon {...props}><rect x="2" y="1.75" width="12" height="12.5" rx="1.25" /><path d="M5.25 1.75v12.5M8 5h3.5M8 8h3.5M8 11h2.25" /></Icon>
);
