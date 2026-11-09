/**
 * Pure rules for discussions on API elements. No database or framework imports: the server
 * module owns storage and authorization, this file owns what a comment may contain.
 */
import { z } from "zod";

export const COMMENT_TARGETS = ["request", "folder", "specification", "mergeRequest"] as const;
export type CommentTarget = (typeof COMMENT_TARGETS)[number];

export const COMMENT_LIMITS = { body: 4000, mentions: 20, perTarget: 1000 } as const;

/** Comment text is plain text: control characters and markup-looking tags are stripped, never rendered as HTML. */
export function sanitizeCommentBody(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<\/?[a-zA-Z!][^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/** `@username` tokens in a comment, lower-cased and de-duplicated, in order of appearance. */
export function extractMentions(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(/(?<![\w@])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/g)) {
    const name = m[1].replace(/[._-]+$/, "").toLowerCase();
    if (name && !found.includes(name)) found.push(name);
  }
  return found.slice(0, COMMENT_LIMITS.mentions);
}

export const commentBodySchema = z
  .string()
  .max(COMMENT_LIMITS.body * 2)
  .transform(sanitizeCommentBody)
  .pipe(z.string().min(1, "Comment is empty").max(COMMENT_LIMITS.body));

export const createCommentInput = z
  .object({
    targetKind: z.enum(COMMENT_TARGETS),
    targetId: z.string().min(1).max(200),
    body: commentBodySchema,
    /** Reply to a top-level comment; replies cannot be nested further. */
    parentId: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();
export const editCommentInput = z.object({ body: commentBodySchema }).strict();
export const resolveCommentInput = z.object({ resolved: z.boolean() }).strict();

export interface CommentView {
  id: string;
  workspaceId: string;
  targetKind: CommentTarget;
  targetId: string;
  parentId: string | null;
  body: string;
  authorId: string | null;
  authorName: string;
  mentions: string[];
  /** What the element looked like when the comment was written (its revision or last-change time). */
  revision: string;
  resolvedAt: number | null;
  resolvedBy: string | null;
  createdAt: number;
  editedAt: number | null;
  /** What the viewer may do with it. */
  can: { edit: boolean; delete: boolean; resolve: boolean };
  replies?: CommentView[];
}

/** Arrange a flat list into threads: top-level comments oldest first, each with replies oldest first. */
export function buildThreads(comments: CommentView[]): CommentView[] {
  const byId = new Map(comments.map((c) => [c.id, { ...c, replies: [] as CommentView[] }]));
  const roots: CommentView[] = [];
  for (const c of [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    if (parent) parent.replies!.push(c);
    else if (!c.parentId) roots.push(c);
  }
  return roots;
}
