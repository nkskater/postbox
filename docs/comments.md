# Comments and review discussions

Every request, folder or collection, and API specification has a **Comments** tab. Use it to ask
a question, flag a problem or sign off on a change without leaving the element you are talking about.

- **Threads.** A comment starts a thread; replies are one level deep and always answer a top-level comment.
- **Mentions.** Write `@username` to tell a teammate. Only people who can read the workspace
  (members and administrators) are notified; anyone else stays plain text. Editing a comment only
  notifies people it newly mentions. A reply also notifies the author of the thread.
- **Resolve / reopen.** The thread's author or any editor or owner can resolve a thread. Resolved threads
  collapse and can be reopened. Unresolved counts show on the tab and in `GET /api/comments/counts`.
- **Revisions.** Each comment records which version of the element it was written against (a request or
  folder's last-change time, a specification's revision) so a reader can tell when advice is out of date.
- **Plain text only.** Markup and control characters are stripped; the app never renders comment HTML.
  Up to 4,000 characters per comment and 1,000 per element.

## Who can do what

| Action                     | Needs                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| Read a discussion          | Read access to the workspace                                        |
| Comment or reply           | Read access (viewers may take part). API keys need `write` scope.   |
| Edit a comment             | Its author only                                                     |
| Resolve or reopen a thread | The thread's author, or an editor or owner                          |
| Delete a comment           | Its author, or a workspace owner. Deleting a thread removes replies |

Deleting a request, folder or specification deletes its discussion. Notifications for people who lose
workspace access are hidden. Every change is recorded in the audit log.

## Notifications

The bell in the top bar lists mentions and replies addressed to you, with an unread count. Opening a
notification takes you to the thread and marks it read.

## API and automation

| Method           | Path                                     | Notes                                                                                                                                  |
| ---------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET / POST       | `/api/requests/ID/comments`              | Also `/api/folders/ID/comments` and `/api/specifications/ID/comments`. `GET ?open=1` hides resolved threads. POST `{body, parentId?}`. |
| GET/PATCH/DELETE | `/api/comments/ID`                       | PATCH `{body}`.                                                                                                                        |
| PUT              | `/api/comments/ID/resolution`            | `{resolved: boolean}`                                                                                                                  |
| GET              | `/api/comments/counts?workspaceId=`      | Unresolved threads keyed `request:ID`, `folder:ID`, ...                                                                                |
| GET              | `/api/comments/mentionable?workspaceId=` | People who can be mentioned.                                                                                                           |
| GET              | `/api/notifications?unread=1`            | Your mentions and replies.                                                                                                             |
| POST             | `/api/notifications/read`                | `{ids?}`; without ids marks all read.                                                                                                  |

MCP tools: `list_comments`, `add_comment`, `resolve_comment`.
