export interface ContentRevision {
  lastModified: string;
  hash: string | null;
  hashAlgorithm: string | null;
}

export interface RevisionedContent {
  last_modified: string;
  hash?: string | null;
  hash_algorithm?: string | null;
}

export class NotebookChangedOnDiskError extends Error {
  constructor(
    readonly expected: ContentRevision,
    readonly actual: ContentRevision,
  ) {
    super("The notebook changed on disk after Zbook opened it.");
  }
}

export function contentRevision(entry: RevisionedContent): ContentRevision {
  return {
    lastModified: entry.last_modified,
    hash: entry.hash ?? null,
    hashAlgorithm: entry.hash_algorithm ?? null,
  };
}

export function sameContentRevision(left: ContentRevision, right: ContentRevision): boolean {
  if (left.hash && right.hash && left.hashAlgorithm === right.hashAlgorithm) {
    return left.hash === right.hash;
  }
  return left.lastModified === right.lastModified;
}
