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
export const SparkIcon = (props: IconProps) => (
  <Icon {...props}><path d="M8 1.5c.45 3.5 2 5.05 5.5 5.5C10 7.45 8.45 9 8 12.5 7.55 9 6 7.45 2.5 7 6 6.55 7.55 5 8 1.5Z" /></Icon>
);
export const BranchIcon = (props: IconProps) => (
  <Icon {...props}><circle cx="4" cy="3" r="1.5" /><circle cx="12" cy="4" r="1.5" /><circle cx="4" cy="13" r="1.5" /><path d="M4 4.5v7M5.5 8h2.2A4.3 4.3 0 0 0 12 3.7" /></Icon>
);
export const PanelIcon = (props: IconProps) => (
  <Icon {...props}><rect x="1.75" y="2" width="12.5" height="12" rx="1" /><path d="M5.5 2v12" /></Icon>
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
export const UploadIcon = (props: IconProps) => (
  <Icon {...props}><path d="M8 14V4M5 7l3-3 3 3M2.5 2h11" /></Icon>
);
export const NewFolderIcon = (props: IconProps) => (
  <Icon {...props}><path d="M1.75 4.25h4l1.2 1.5h7.3v7.5H1.75zM10.5 8v3M9 9.5h3" /></Icon>
);
