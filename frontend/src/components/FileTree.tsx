import { useState } from "react";
import { ChevronIcon, FileIcon, FolderIcon, PlusIcon } from "./icons";

interface FileNode {
  name: string;
  kind: "file" | "folder";
  active?: boolean;
  children?: FileNode[];
}

const tree: FileNode[] = [
  { name: "analysis.ipynb", kind: "file", active: true },
  { name: "scratch.ipynb", kind: "file" },
  {
    name: "data",
    kind: "folder",
    children: [
      { name: "observations.csv", kind: "file" },
      { name: "README.md", kind: "file" },
    ],
  },
  { name: "pyproject.toml", kind: "file" },
  { name: "uv.lock", kind: "file" },
];

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const expandable = node.kind === "folder";
  return (
    <>
      <button
        className={`tree-row${node.active ? " is-active" : ""}`}
        style={{ paddingLeft: `${10 + depth * 13}px` }}
        onClick={() => expandable && setOpen((value) => !value)}
      >
        <ChevronIcon className={`tree-chevron${expandable && open ? " is-open" : ""}${!expandable ? " is-hidden" : ""}`} />
        {expandable ? <FolderIcon className="tree-kind" /> : <FileIcon className="tree-kind" />}
        <span>{node.name}</span>
      </button>
      {expandable && open && node.children?.map((child) => (
        <TreeNode key={child.name} node={child} depth={depth + 1} />
      ))}
    </>
  );
}
export function FileTree() {
  return (
    <aside className="file-panel" aria-label="Workspace files">
      <div className="panel-heading">
        <span>WORKSPACE</span>
        <button className="icon-button" aria-label="New file"><PlusIcon /></button>
      </div>
      <div className="workspace-name"><ChevronIcon className="workspace-chevron" />quick-notebook</div>
      <nav className="tree" aria-label="File tree">
        {tree.map((node) => <TreeNode key={node.name} node={node} depth={0} />)}
      </nav>
      <div className="environment-block">
        <span className="environment-label">ENVIRONMENT</span>
        <button className="environment-button">
          <span className="environment-dot" />
          <span className="environment-copy"><strong>.venv</strong><small>Python 3.12 · uv</small></span>
          <ChevronIcon />
        </button>
      </div>
    </aside>
  );
}
