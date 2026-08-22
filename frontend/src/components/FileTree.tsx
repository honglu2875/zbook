import { useRef, useState } from "react";
import type { ContentEntry } from "../services/contents";
import {
  ChevronIcon,
  FileIcon,
  FolderIcon,
  NewFolderIcon,
  PlusIcon,
  RefreshIcon,
  RenameIcon,
  TrashIcon,
  UploadIcon,
} from "./icons";

interface FileTreeProps {
  workspaceName: string;
  environmentName: string;
  pythonVersion: string;
  activePath: string | null;
  activeDirectory: string;
  directories: Record<string, ContentEntry[]>;
  loadingPaths: ReadonlySet<string>;
  onLoadDirectory: (path: string, refresh?: boolean) => void;
  onOpen: (entry: ContentEntry) => void;
  onNewNotebook: () => void;
  onNewFolder: () => void;
  onUpload: (files: FileList) => void;
  onSelectDirectory: (path: string) => void;
  onRename: (entry: ContentEntry) => void;
  onDelete: (entry: ContentEntry) => void;
  onEnvironment: () => void;
}

interface TreeNodeProps extends Pick<
  FileTreeProps,
  "activePath" | "activeDirectory" | "directories" | "loadingPaths" | "onLoadDirectory" | "onOpen" | "onRename" | "onDelete" | "onSelectDirectory"
> {
  node: ContentEntry;
  depth: number;
}

function TreeNode({
  node,
  depth,
  activePath,
  activeDirectory,
  directories,
  loadingPaths,
  onLoadDirectory,
  onOpen,
  onRename,
  onDelete,
  onSelectDirectory,
}: TreeNodeProps) {
  const [open, setOpen] = useState(false);
  const expandable = node.type === "directory";
  const children = directories[node.path];

  function activate() {
    if (!expandable) {
      onOpen(node);
      return;
    }
    onSelectDirectory(node.path);
    const next = !open;
    setOpen(next);
    if (next && children === undefined) onLoadDirectory(node.path);
  }

  return (
    <>
      <div className={`tree-row-wrap${activePath === node.path || activeDirectory === node.path ? " is-active" : ""}`}>
        <button
          className="tree-row"
          style={{ paddingLeft: `${10 + depth * 13}px` }}
          onClick={activate}
          title={node.path}
        >
          <ChevronIcon
            className={`tree-chevron${expandable && open ? " is-open" : ""}${!expandable ? " is-hidden" : ""}`}
          />
          {expandable ? <FolderIcon className="tree-kind" /> : <FileIcon className="tree-kind" />}
          <span>{node.name}</span>
          {loadingPaths.has(node.path) && <i className="tree-loading" />}
        </button>
        <span className="tree-actions">
          <button onClick={() => onRename(node)} aria-label={`Rename ${node.name}`} title="Rename"><RenameIcon /></button>
          <button onClick={() => onDelete(node)} aria-label={`Delete ${node.name}`} title="Delete"><TrashIcon /></button>
        </span>
      </div>
      {expandable && open && children?.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          activePath={activePath}
          activeDirectory={activeDirectory}
          directories={directories}
          loadingPaths={loadingPaths}
          onLoadDirectory={onLoadDirectory}
          onOpen={onOpen}
          onRename={onRename}
          onDelete={onDelete}
          onSelectDirectory={onSelectDirectory}
        />
      ))}
      {expandable && open && children?.length === 0 && (
        <div className="tree-empty" style={{ paddingLeft: `${31 + depth * 13}px` }}>empty</div>
      )}
    </>
  );
}

export function FileTree({
  workspaceName,
  environmentName,
  pythonVersion,
  activePath,
  activeDirectory,
  directories,
  loadingPaths,
  onLoadDirectory,
  onOpen,
  onNewNotebook,
  onNewFolder,
  onUpload,
  onSelectDirectory,
  onRename,
  onDelete,
  onEnvironment,
}: FileTreeProps) {
  const [rootOpen, setRootOpen] = useState(true);
  const uploadInput = useRef<HTMLInputElement>(null);
  const rootEntries = directories[""] ?? [];

  return (
    <aside className="file-panel" aria-label="Workspace files">
      <div className="panel-heading">
        <span>WORKSPACE</span>
        <span className="panel-actions">
          <button className="icon-button" onClick={() => onLoadDirectory("", true)} aria-label="Refresh files" title="Refresh files"><RefreshIcon /></button>
          <button className="icon-button" onClick={onNewFolder} aria-label="New folder" title="New folder"><NewFolderIcon /></button>
          <button className="icon-button" onClick={() => uploadInput.current?.click()} aria-label="Upload files" title="Upload files"><UploadIcon /></button>
          <button className="icon-button" onClick={onNewNotebook} aria-label="New notebook" title="New notebook"><PlusIcon /></button>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files?.length) onUpload(event.target.files);
              event.target.value = "";
            }}
          />
        </span>
      </div>
      <button
        className={`workspace-name${activeDirectory === "" ? " is-active" : ""}`}
        onClick={() => {
          onSelectDirectory("");
          setRootOpen((value) => !value);
        }}
      >
        <ChevronIcon className={`workspace-chevron${rootOpen ? " is-open" : ""}`} />
        <span>{workspaceName}</span>
      </button>
      {rootOpen && (
        <nav className="tree" aria-label="File tree">
          {rootEntries.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activePath={activePath}
              activeDirectory={activeDirectory}
              directories={directories}
              loadingPaths={loadingPaths}
              onLoadDirectory={onLoadDirectory}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
              onSelectDirectory={onSelectDirectory}
            />
          ))}
          {loadingPaths.has("") && <div className="tree-empty">loading workspace…</div>}
          {!loadingPaths.has("") && rootEntries.length === 0 && <div className="tree-empty">No files yet</div>}
        </nav>
      )}
      <div className="environment-block">
        <span className="environment-label">ENVIRONMENT</span>
        <button className="environment-button" onClick={onEnvironment}>
          <span className="environment-dot" />
          <span className="environment-copy"><strong>{environmentName}</strong><small>{pythonVersion} · uv</small></span>
          <ChevronIcon />
        </button>
      </div>
    </aside>
  );
}
