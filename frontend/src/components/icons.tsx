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
